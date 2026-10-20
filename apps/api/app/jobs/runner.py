"""Executes one Run row: loads its payload, calls the engine, stores the result.

The Run row in Postgres is the state of record (ADR-003); queues only carry
``(run_id, tenant_id)``. Cancellation is a status flip: the runner checks it
before starting and never overwrites a cancelled run with a late result.
"""

from __future__ import annotations

import hashlib
import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Callable

import flowform_engine
from flowform_engine import solve_multi_period, solve_optimize, solve_stochastic
from flowform_engine.solvers import default_adapter

from ..db.models import Run
from ..db.session import tenant_session

log = logging.getLogger("flowform.jobs")

KINDS: dict[str, Callable[[dict[str, Any]], dict[str, Any]]] = {
    "optimize": solve_optimize,
    "multi-period": solve_multi_period,
    "stochastic": solve_stochastic,
}
TERMINAL = {"succeeded", "failed", "cancelled"}


def input_hash(kind: str, payload: dict[str, Any]) -> str:
    blob = json.dumps({"kind": kind, "payload": payload}, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(blob.encode()).hexdigest()


def versions() -> tuple[str, str]:
    return f"flowform-engine {flowform_engine.__version__}", default_adapter().version()


def _set(tenant_id: uuid.UUID, run_id: uuid.UUID, **fields: Any) -> Run | None:
    with tenant_session(tenant_id) as s:
        r = s.get(Run, run_id, with_for_update=True)
        if r is None:
            return None
        if r.status in TERMINAL:
            return r
        for k, v in fields.items():
            setattr(r, k, v)
        return r


def execute_run(run_id: uuid.UUID, tenant_id: uuid.UUID) -> str:
    """Run synchronously; returns the final status. Safe to call twice."""
    with tenant_session(tenant_id) as s:
        r = s.get(Run, run_id)
        if r is None:
            return "missing"
        if r.status in TERMINAL:
            return r.status
        kind, payload = r.kind, r.payload or {}
    r = _set(tenant_id, run_id, status="running", progress=0.1, message="Solving")
    if r is None or r.status in TERMINAL:
        return r.status if r else "missing"
    try:
        result = KINDS[kind](payload)
        status, msg = "succeeded", (result.get("status") if isinstance(result, dict) else None)
    except Exception as e:  # engine errors are user-visible run failures
        log.exception("run %s failed", run_id)
        result, status, msg = None, "failed", f"{type(e).__name__}: {e}"
    r = _set(tenant_id, run_id, status=status, progress=1.0, message=msg, result=result,
             finished_at=datetime.now(timezone.utc))
    return r.status if r else "missing"
