"""/v1/projects/{id}/scenarios CRUD and read-only runs listing (FF-104).
Run creation lives in app/v1/runs.py (FF-105). All tenant-scoped (filter + RLS)."""

from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field
from sqlalchemy import select

from ..db.models import AuditEvent, Run, Scenario
from ..db.session import tenant_session
from .auth import Identity, admin, editor, viewer
from .projects import get_project_or_404

router = APIRouter(prefix="/v1/projects/{project_id}", tags=["scenarios"])


class ScenarioIn(BaseModel):
    name: str = Field(min_length=1, max_length=300)
    spec: dict[str, Any] = Field(default_factory=dict)


def scenario_out(sc: Scenario) -> dict[str, Any]:
    return {"id": str(sc.id), "projectId": str(sc.project_id), "name": sc.name, "spec": sc.spec,
            "createdAt": sc.created_at.isoformat() if sc.created_at else None}


def run_out(r: Run, *, with_result: bool = False) -> dict[str, Any]:
    out: dict[str, Any] = {
        "id": str(r.id), "projectId": str(r.project_id),
        "scenarioId": str(r.scenario_id) if r.scenario_id else None,
        "kind": r.kind, "status": r.status, "progress": r.progress, "message": r.message,
        "inputHash": r.input_hash, "engineVersion": r.engine_version, "solverVersion": r.solver_version,
        "createdAt": r.created_at.isoformat() if r.created_at else None,
        "finishedAt": r.finished_at.isoformat() if r.finished_at else None,
        # Recovery lease (CR-004): attempt count and worker liveness are visible
        # so a retried run is explainable in the UI and in support tickets.
        "attempts": r.attempts or 0,
        "startedAt": r.started_at.isoformat() if r.started_at else None,
        "heartbeatAt": r.heartbeat_at.isoformat() if r.heartbeat_at else None,
        "dispatchedAt": r.dispatched_at.isoformat() if r.dispatched_at else None,
    }
    if with_result:
        out["result"] = r.result
    return out


def _scenario(s, ident: Identity, project_id: uuid.UUID, sid: uuid.UUID) -> Scenario:
    sc = s.execute(select(Scenario).where(
        Scenario.id == sid, Scenario.project_id == project_id, Scenario.tenant_id == ident.tenant_id
    )).scalar_one_or_none()
    if sc is None:
        raise HTTPException(status_code=404, detail="scenario not found")
    return sc


@router.get("/scenarios")
def list_scenarios(project_id: uuid.UUID, ident: Identity = Depends(viewer)) -> dict[str, Any]:
    with tenant_session(ident.tenant_id) as s:
        get_project_or_404(s, ident, project_id)
        rows = s.execute(select(Scenario).where(
            Scenario.project_id == project_id, Scenario.tenant_id == ident.tenant_id
        ).order_by(Scenario.created_at)).scalars()
        return {"scenarios": [scenario_out(x) for x in rows]}


@router.post("/scenarios", status_code=201)
def create_scenario(project_id: uuid.UUID, body: ScenarioIn, ident: Identity = Depends(editor)) -> dict[str, Any]:
    with tenant_session(ident.tenant_id) as s:
        get_project_or_404(s, ident, project_id)
        sc = Scenario(tenant_id=ident.tenant_id, project_id=project_id, name=body.name, spec=body.spec)
        s.add(sc)
        s.flush()
        s.add(AuditEvent(tenant_id=ident.tenant_id, actor_id=ident.user_id, action="scenario.create", target=str(sc.id)))
        s.flush()
        s.refresh(sc)
        return scenario_out(sc)


@router.get("/scenarios/{scenario_id}")
def get_scenario(project_id: uuid.UUID, scenario_id: uuid.UUID, ident: Identity = Depends(viewer)) -> dict[str, Any]:
    with tenant_session(ident.tenant_id) as s:
        return scenario_out(_scenario(s, ident, project_id, scenario_id))


@router.put("/scenarios/{scenario_id}")
def update_scenario(project_id: uuid.UUID, scenario_id: uuid.UUID, body: ScenarioIn, ident: Identity = Depends(editor)) -> dict[str, Any]:
    with tenant_session(ident.tenant_id) as s:
        sc = _scenario(s, ident, project_id, scenario_id)
        sc.name, sc.spec = body.name, body.spec
        s.add(AuditEvent(tenant_id=ident.tenant_id, actor_id=ident.user_id, action="scenario.update", target=str(sc.id)))
        return scenario_out(sc)


@router.delete("/scenarios/{scenario_id}", status_code=204)
def delete_scenario(project_id: uuid.UUID, scenario_id: uuid.UUID, ident: Identity = Depends(admin)) -> Response:
    with tenant_session(ident.tenant_id) as s:
        s.delete(_scenario(s, ident, project_id, scenario_id))
        s.add(AuditEvent(tenant_id=ident.tenant_id, actor_id=ident.user_id, action="scenario.delete", target=str(scenario_id)))
    return Response(status_code=204)


@router.get("/runs")
def list_runs(project_id: uuid.UUID, ident: Identity = Depends(viewer)) -> dict[str, Any]:
    with tenant_session(ident.tenant_id) as s:
        get_project_or_404(s, ident, project_id)
        rows = s.execute(select(Run).where(
            Run.project_id == project_id, Run.tenant_id == ident.tenant_id
        ).order_by(Run.created_at.desc())).scalars()
        return {"runs": [run_out(r) for r in rows]}
