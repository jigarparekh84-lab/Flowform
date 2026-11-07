"""Executes one Run row: loads its payload, calls the engine, stores the result.

The Run row in Postgres is the state of record (ADR-003); queues only carry
``(run_id, tenant_id)``. Cancellation is a status flip: the runner checks it
before starting and never overwrites a cancelled run with a late result.

Recovery (CR-004) makes delivery idempotent and crash-safe:

* :func:`claim` is a single conditional ``UPDATE ... WHERE status='queued'``, so
  two workers (or a duplicate queue message) cannot both solve one run. It
  returns the new ``attempts`` value, which acts as a fence.
* While solving, a heartbeat thread refreshes ``heartbeat_at``. A dead process
  stops beating, so :mod:`app.jobs.reaper` can reclaim the run.
* :func:`finish` writes with ``attempts = :attempt`` in the WHERE clause. A
  worker that lost its lease (reaped and re-claimed by another attempt) cannot
  overwrite the newer attempt's result.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import threading
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Callable, cast

from sqlalchemy import update
from sqlalchemy.engine import CursorResult

import flowform_engine
from flowform_engine import solve_multi_period, solve_optimize, solve_stochastic
from flowform_engine.solvers import default_adapter

from ..db.models import Run
from ..db.session import tenant_session
from ..metrics import record_run_finished, record_run_started

log = logging.getLogger("flowform.jobs")

KINDS: dict[str, Callable[[dict[str, Any]], dict[str, Any]]] = {
    "optimize": solve_optimize,
    "multi-period": solve_multi_period,
    "stochastic": solve_stochastic,
}
TERMINAL = {"succeeded", "failed", "cancelled"}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def input_hash(kind: str, payload: dict[str, Any]) -> str:
    blob = json.dumps({"kind": kind, "payload": payload}, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(blob.encode()).hexdigest()


def versions() -> tuple[str, str]:
    return f"flowform-engine {flowform_engine.__version__}", default_adapter().version()


def claim(tenant_id: uuid.UUID, run_id: uuid.UUID) -> int | None:
    """Atomically take ownership of a queued run.

    Returns the new attempt number (1 for a first run), or ``None`` when another
    worker owns it, it already finished, or it was cancelled. Conditional on
    ``status='queued'`` so duplicate deliveries are harmless.
    """
    with tenant_session(tenant_id) as s:
        row = s.execute(
            update(Run)
            .where(Run.id == run_id, Run.tenant_id == tenant_id, Run.status == "queued")
            .values(
                status="running",
                progress=0.1,
                message="Solving",
                started_at=_now(),
                heartbeat_at=_now(),
                attempts=Run.attempts + 1,
            )
            .returning(Run.attempts)
        ).first()
    return int(row[0]) if row else None


def heartbeat(tenant_id: uuid.UUID, run_id: uuid.UUID, attempt: int) -> bool:
    """Refresh the lease. Returns False once this attempt no longer owns the run."""
    with tenant_session(tenant_id) as s:
        n = cast(
            "CursorResult[Any]",
            s.execute(
                update(Run)
                .where(
                    Run.id == run_id,
                    Run.tenant_id == tenant_id,
                    Run.status == "running",
                    Run.attempts == attempt,
                )
                .values(heartbeat_at=_now())
            ),
        ).rowcount
    return bool(n)


def finish(tenant_id: uuid.UUID, run_id: uuid.UUID, attempt: int, **fields: Any) -> str | None:
    """Store a terminal state, fenced by attempt.

    Returns the new status, or ``None`` when this attempt lost the run (cancelled,
    or reaped and re-claimed). A late result from a stale worker is discarded.
    """
    with tenant_session(tenant_id) as s:
        row = s.execute(
            update(Run)
            .where(
                Run.id == run_id,
                Run.tenant_id == tenant_id,
                Run.status == "running",
                Run.attempts == attempt,
            )
            .values(heartbeat_at=_now(), **fields)
            .returning(Run.status)
        ).first()
    return str(row[0]) if row else None


def status_of(tenant_id: uuid.UUID, run_id: uuid.UUID) -> str:
    with tenant_session(tenant_id) as s:
        r = s.get(Run, run_id)
        return r.status if r else "missing"


class _LeaseHeartbeat(threading.Thread):
    """Keeps ``runs.heartbeat_at`` fresh while the solver runs."""

    daemon = True

    def __init__(self, tenant_id: uuid.UUID, run_id: uuid.UUID, attempt: int) -> None:
        super().__init__(name=f"ff-heartbeat-{run_id}")
        self.tenant_id, self.run_id, self.attempt = tenant_id, run_id, attempt
        self._stop = threading.Event()

    def run(self) -> None:
        interval = max(1.0, float(os.environ.get("RUN_HEARTBEAT_S", "30")))
        while not self._stop.wait(interval):
            try:
                if not heartbeat(self.tenant_id, self.run_id, self.attempt):
                    return  # cancelled or reaped; nothing left to keep alive
            except Exception:  # noqa: BLE001 - a DB blip must not kill the solve
                log.warning("heartbeat failed for run %s", self.run_id, exc_info=True)

    def stop(self) -> None:
        self._stop.set()


def execute_run(run_id: uuid.UUID, tenant_id: uuid.UUID) -> str:
    """Run synchronously; returns the final status. Safe to call twice."""
    created_at: datetime | None = None
    with tenant_session(tenant_id) as s:
        r = s.get(Run, run_id)
        if r is None:
            return "missing"
        if r.status in TERMINAL:
            return r.status
        kind, payload = r.kind, r.payload or {}
        created_at = r.created_at

    attempt = claim(tenant_id, run_id)
    if attempt is None:
        # A duplicate delivery, a cancel, or another worker got there first.
        return status_of(tenant_id, run_id)

    # Structured lifecycle lines (CR-006): run_id + attempt is enough to follow
    # one solve across queue, worker and reaper logs.
    started = time.perf_counter()
    log.info("run.start run=%s attempt=%s kind=%s", run_id, attempt, kind)
    if created_at is not None:
        record_run_started(kind, (_now() - created_at).total_seconds())

    beat = _LeaseHeartbeat(tenant_id, run_id, attempt)
    beat.start()
    try:
        result = KINDS[kind](payload)
        status, msg = "succeeded", (result.get("status") if isinstance(result, dict) else None)
    except Exception as e:  # engine errors are user-visible run failures
        log.exception("run %s failed", run_id)
        result, status, msg = None, "failed", f"{type(e).__name__}: {e}"
    finally:
        beat.stop()

    final = finish(
        tenant_id,
        run_id,
        attempt,
        status=status,
        progress=1.0,
        message=msg,
        result=result,
        finished_at=_now(),
    )
    if final is None:
        log.warning("run %s lost its lease before the result was stored; discarding", run_id)
        return status_of(tenant_id, run_id)
    elapsed_s = time.perf_counter() - started
    log.info(
        "run.finish run=%s attempt=%s status=%s in %.0fms",
        run_id, attempt, final, elapsed_s * 1000,
    )
    record_run_finished(kind, final, elapsed_s)
    return final
