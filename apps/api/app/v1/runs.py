"""Async run API (FF-105). Sync /optimize* endpoints are unchanged.

POST /v1/projects/{pid}/runs            {kind, payload, scenarioId?} → 202 run
GET  /v1/projects/{pid}/runs/{rid}      status/progress (+ result when done)
GET  /v1/projects/{pid}/runs/{rid}/events   SSE status/progress stream
POST /v1/projects/{pid}/runs/{rid}/cancel
"""

from __future__ import annotations

import asyncio
import json
import uuid
from datetime import datetime, timezone
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import select

from ..db.models import AuditEvent, Run, Scenario
from ..db.session import tenant_session
from ..jobs.queue import get_queue
from ..jobs.runner import TERMINAL, input_hash, versions
from .auth import Identity, editor, viewer
from .projects import get_project_or_404
from .scenarios import run_out

router = APIRouter(prefix="/v1/projects/{project_id}/runs", tags=["runs"])


class RunIn(BaseModel):
    """``payload`` is the same JSON body the sync /optimize[/multi-period|/stochastic] endpoint takes."""

    kind: Literal["optimize", "multi-period", "stochastic"] = "optimize"
    payload: dict[str, Any] = Field(default_factory=dict)
    scenarioId: uuid.UUID | None = None


def normalize_request(kind: str, body: dict[str, Any]) -> dict[str, Any]:
    """Apply the exact request→engine mapping of the sync endpoint for ``kind``
    so a job and a sync call with the same body solve the same model."""
    from pydantic import ValidationError

    from .. import main as m

    try:
        if kind == "optimize":
            return m._optimize_payload(m.OptimizeRequest(**body))
        if kind == "multi-period":
            return m.multi_period_payload(m.MultiPeriodOptimizeRequest(**body))
        return m.stochastic_payload(m.StochasticOptimizeRequest(**body))
    except ValidationError as e:
        raise HTTPException(status_code=422, detail=json.loads(e.json())) from e


def _run(s, ident: Identity, project_id: uuid.UUID, run_id: uuid.UUID) -> Run:
    r = s.execute(select(Run).where(
        Run.id == run_id, Run.project_id == project_id, Run.tenant_id == ident.tenant_id
    )).scalar_one_or_none()
    if r is None:
        raise HTTPException(status_code=404, detail="run not found")
    return r


@router.post("", status_code=202)
def create_run(project_id: uuid.UUID, body: RunIn, ident: Identity = Depends(editor)) -> dict[str, Any]:
    engine_v, solver_v = versions()
    payload = normalize_request(body.kind, body.payload)
    with tenant_session(ident.tenant_id) as s:
        get_project_or_404(s, ident, project_id)
        if body.scenarioId and s.execute(select(Scenario.id).where(
            Scenario.id == body.scenarioId, Scenario.project_id == project_id
        )).first() is None:
            raise HTTPException(status_code=404, detail="scenario not found")
        r = Run(tenant_id=ident.tenant_id, project_id=project_id, scenario_id=body.scenarioId,
                kind=body.kind, status="queued", progress=0.0, payload=payload,
                input_hash=input_hash(body.kind, payload), engine_version=engine_v, solver_version=solver_v)
        s.add(r)
        s.flush()
        s.add(AuditEvent(tenant_id=ident.tenant_id, actor_id=ident.user_id, action="run.create", target=str(r.id)))
        s.flush()
        s.refresh(r)
        out = run_out(r)
    get_queue().enqueue(uuid.UUID(out["id"]), ident.tenant_id)
    return out


@router.get("/{run_id}")
def get_run(project_id: uuid.UUID, run_id: uuid.UUID, ident: Identity = Depends(viewer)) -> dict[str, Any]:
    with tenant_session(ident.tenant_id) as s:
        r = _run(s, ident, project_id, run_id)
        return run_out(r, with_result=r.status in TERMINAL)


@router.post("/{run_id}/cancel")
def cancel_run(project_id: uuid.UUID, run_id: uuid.UUID, ident: Identity = Depends(editor)) -> dict[str, Any]:
    with tenant_session(ident.tenant_id) as s:
        r = _run(s, ident, project_id, run_id)
        if r.status not in TERMINAL:
            r.status, r.message, r.finished_at = "cancelled", "Cancelled by user", datetime.now(timezone.utc)
            s.add(AuditEvent(tenant_id=ident.tenant_id, actor_id=ident.user_id, action="run.cancel", target=str(r.id)))
        out = run_out(r)
    get_queue().cancel(run_id)
    return out


@router.get("/{run_id}/events")
async def run_events(project_id: uuid.UUID, run_id: uuid.UUID, poll_s: float = 0.5,
                     ident: Identity = Depends(viewer)) -> StreamingResponse:
    def snap() -> dict[str, Any]:
        with tenant_session(ident.tenant_id) as s:
            return run_out(_run(s, ident, project_id, run_id))

    first = await asyncio.to_thread(snap)  # 404 before streaming starts

    async def gen():
        last, cur = None, first
        while True:
            key = (cur["status"], cur["progress"], cur["message"])
            if key != last:
                yield f"event: status\ndata: {json.dumps(cur)}\n\n"
                last = key
            if cur["status"] in TERMINAL:
                yield "event: done\ndata: {}\n\n"
                return
            await asyncio.sleep(max(0.05, min(poll_s, 5.0)))
            cur = await asyncio.to_thread(snap)

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
