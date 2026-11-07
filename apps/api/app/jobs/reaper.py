"""Crash recovery for the async run pipeline (CR-004).

A run can get stuck in two ways, and both are fixed here:

1. **A worker died mid-solve.** The row stays ``running`` forever. The runner's
   heartbeat stops, so after ``RUN_STALE_AFTER_S`` the reaper either requeues it
   (while ``attempts < RUN_MAX_ATTEMPTS``) or fails it with an explicit
   "interrupted" message. ``runner.finish`` is attempt-fenced, so if the old
   worker was merely partitioned and comes back, its late result is discarded.
2. **The queue lost the message.** The row stays ``queued`` forever. The reaper
   re-dispatches runs whose last hand-off (``dispatched_at``) is older than
   ``RUN_QUEUED_STALE_AFTER_S``. The runner's claim makes the duplicate
   harmless; the attempt-scoped job id keeps Arq from swallowing the retry.

The sweep is safe to run concurrently in several processes (``FOR UPDATE SKIP
LOCKED``) and across tenants; it reads the tenant list with the owner session
and then does the actual work per tenant under RLS.

Run it three ways:

* automatically in the API process (lifespan thread, ``RUN_REAPER_ENABLED``);
* once when an Arq worker starts (``app.jobs.worker.on_startup``);
* as a cron/CronJob: ``python -m app.jobs.reaper --once``.
"""

from __future__ import annotations

import argparse
import logging
import os
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select

from ..db.models import AuditEvent, Run, Tenant
from ..db.session import admin_session, tenant_session
from ..metrics import record_reaped, set_stuck_runs
from .queue import enqueue_run

log = logging.getLogger("flowform.reaper")

#: No heartbeat for this long means the owning process is gone.
DEFAULT_STALE_AFTER_S = 180.0
#: No dispatch for this long means the queue message was lost.
DEFAULT_QUEUED_STALE_AFTER_S = 120.0
#: One automatic retry, then the run is failed instead of looping.
DEFAULT_MAX_ATTEMPTS = 2
#: Background sweep cadence in the API process.
DEFAULT_INTERVAL_S = 300.0
#: Threshold behind the "stuck runs" SLO gauge (10 minutes).
DEFAULT_STUCK_AFTER_S = 600.0


def _env_float(name: str, default: float) -> float:
    try:
        return max(1.0, float(os.environ.get(name, default)))
    except (TypeError, ValueError):
        return default


def _env_int(name: str, default: int) -> int:
    try:
        return max(1, int(os.environ.get(name, default)))
    except (TypeError, ValueError):
        return default


@dataclass
class ReapResult:
    requeued: list[str] = field(default_factory=list)
    failed: list[str] = field(default_factory=list)
    redispatched: list[str] = field(default_factory=list)

    def __bool__(self) -> bool:
        return bool(self.requeued or self.failed or self.redispatched)

    def as_dict(self) -> dict[str, int]:
        return {
            "requeued": len(self.requeued),
            "failed": len(self.failed),
            "redispatched": len(self.redispatched),
        }

    def merge(self, other: "ReapResult") -> None:
        self.requeued += other.requeued
        self.failed += other.failed
        self.redispatched += other.redispatched


def _tenant_ids() -> list[uuid.UUID]:
    with admin_session() as s:
        return list(s.execute(select(Tenant.id).order_by(Tenant.created_at)).scalars())


def _reap_tenant(
    tenant_id: uuid.UUID,
    *,
    now: datetime,
    stale_before: datetime,
    queued_before: datetime,
    stale_after_s: float,
    max_attempts: int,
) -> tuple[ReapResult, list[tuple[uuid.UUID, int]]]:
    """Reclaim one tenant's stuck runs. Returns the result and jobs to enqueue."""
    result = ReapResult()
    to_enqueue: list[tuple[uuid.UUID, int]] = []

    with tenant_session(tenant_id) as s:
        stale = (
            s.execute(
                select(Run)
                .where(
                    Run.tenant_id == tenant_id,
                    Run.status == "running",
                    func.coalesce(Run.heartbeat_at, Run.started_at, Run.created_at) < stale_before,
                )
                .with_for_update(skip_locked=True)
            )
            .scalars()
            .all()
        )
        for r in stale:
            attempts = r.attempts or 0
            if attempts < max_attempts:
                r.status = "queued"
                r.progress = 0.0
                r.started_at = None
                r.heartbeat_at = None
                r.dispatched_at = now
                r.message = "Interrupted: the worker stopped responding. Retrying."
                s.add(
                    AuditEvent(
                        tenant_id=tenant_id,
                        action="run.requeue",
                        target=str(r.id),
                        detail={"attempts": attempts, "staleForSeconds": stale_after_s},
                    )
                )
                result.requeued.append(str(r.id))
                to_enqueue.append((r.id, attempts + 1))
            else:
                r.status = "failed"
                r.progress = 1.0
                r.finished_at = now
                r.message = (
                    "Run interrupted: the worker stopped responding and the retry "
                    f"limit ({max_attempts} attempts) was reached."
                )
                s.add(
                    AuditEvent(
                        tenant_id=tenant_id,
                        action="run.interrupted",
                        target=str(r.id),
                        detail={"attempts": attempts, "staleForSeconds": stale_after_s},
                    )
                )
                result.failed.append(str(r.id))

        lost = (
            s.execute(
                select(Run)
                .where(
                    Run.tenant_id == tenant_id,
                    Run.status == "queued",
                    func.coalesce(Run.dispatched_at, Run.created_at) < queued_before,
                )
                .with_for_update(skip_locked=True)
            )
            .scalars()
            .all()
        )
        for r in lost:
            r.dispatched_at = now  # reserve the slot so the next sweep is quiet
            if not r.message:
                r.message = "Queued"
            s.add(
                AuditEvent(
                    tenant_id=tenant_id,
                    action="run.dispatch_retry",
                    target=str(r.id),
                    detail={"attempts": r.attempts or 0},
                )
            )
            result.redispatched.append(str(r.id))
            to_enqueue.append((r.id, (r.attempts or 0) + 1))

    return result, to_enqueue


def count_stuck_runs(after_s: float | None = None, now: datetime | None = None) -> int:
    """Non-terminal runs that should have moved by now.

    This is the gauge the ``Stuck runs`` alert fires on: it reads the same
    columns as the sweep instead of inferring stuck-ness from counters.
    """
    threshold_s = after_s if after_s is not None else _env_float(
        "RUN_STUCK_ALERT_AFTER_S", DEFAULT_STUCK_AFTER_S
    )
    moment = now or datetime.now(timezone.utc)
    cutoff = moment - timedelta(seconds=max(1.0, threshold_s))
    with admin_session() as s:
        return int(
            s.execute(
                select(func.count())
                .select_from(Run)
                .where(
                    Run.status.in_(("queued", "running")),
                    func.coalesce(Run.heartbeat_at, Run.dispatched_at, Run.created_at) < cutoff,
                )
            ).scalar_one()
            or 0
        )


def reap_once(
    *,
    stale_after_s: float | None = None,
    queued_after_s: float | None = None,
    max_attempts: int | None = None,
    enqueue: bool = True,
) -> ReapResult:
    """One recovery sweep over every tenant.

    A failure in one tenant is logged and skipped so a single bad row cannot
    stop recovery for everyone else.
    """
    stale_after = stale_after_s if stale_after_s is not None else _env_float(
        "RUN_STALE_AFTER_S", DEFAULT_STALE_AFTER_S
    )
    queued_after = queued_after_s if queued_after_s is not None else _env_float(
        "RUN_QUEUED_STALE_AFTER_S", DEFAULT_QUEUED_STALE_AFTER_S
    )
    attempts_cap = max_attempts if max_attempts is not None else _env_int(
        "RUN_MAX_ATTEMPTS", DEFAULT_MAX_ATTEMPTS
    )

    now = datetime.now(timezone.utc)
    stale_before = now - timedelta(seconds=max(1.0, stale_after))
    queued_before = now - timedelta(seconds=max(1.0, queued_after))

    total = ReapResult()
    for tenant_id in _tenant_ids():
        try:
            result, jobs = _reap_tenant(
                tenant_id,
                now=now,
                stale_before=stale_before,
                queued_before=queued_before,
                stale_after_s=stale_after,
                max_attempts=attempts_cap,
            )
        except Exception:  # noqa: BLE001 - one tenant must not block the sweep
            log.exception("reaper failed for tenant %s", tenant_id)
            continue
        total.merge(result)
        if enqueue:
            for run_id, attempt in jobs:
                if not enqueue_run(run_id, tenant_id, attempt=attempt):
                    log.error("reaper could not re-enqueue run %s; will retry", run_id)

    record_reaped(total.as_dict())
    try:
        set_stuck_runs(count_stuck_runs(now=now))
    except Exception:  # noqa: BLE001 - a metrics query must never fail the sweep
        log.debug("could not count stuck runs for metrics", exc_info=True)

    if total:
        log.warning("reaper: %s", total.as_dict())
    else:
        log.debug("reaper: nothing to recover")
    return total


def start_background_reaper() -> threading.Event | None:
    """Start the API-process sweep. Returns a stop event, or None if disabled."""
    if os.environ.get("RUN_REAPER_ENABLED", "true").lower() in {"0", "false", "no", "off"}:
        return None
    if os.environ.get("QUEUE_BACKEND", "inline").lower() == "manual":
        return None  # nothing dispatches in tests; sweeping would only add noise
    interval = _env_float("RUN_REAPER_INTERVAL_S", DEFAULT_INTERVAL_S)
    stop = threading.Event()

    def loop() -> None:
        while not stop.is_set():
            try:
                reap_once()
            except Exception:  # noqa: BLE001 - DB outage at boot must not crash the API
                log.exception("reaper sweep failed; retrying in %ss", interval)
            stop.wait(interval)

    threading.Thread(target=loop, name="ff-reaper", daemon=True).start()
    log.info("run reaper started (interval %ss)", interval)
    return stop


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Reclaim stuck Flowform runs.")
    parser.add_argument("--once", action="store_true", help="one sweep, then exit")
    parser.add_argument(
        "--interval",
        type=float,
        default=None,
        help="seconds between sweeps when not using --once (default RUN_REAPER_INTERVAL_S)",
    )
    args = parser.parse_args(argv)
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))

    interval = args.interval if args.interval is not None else _env_float(
        "RUN_REAPER_INTERVAL_S", DEFAULT_INTERVAL_S
    )
    while True:
        result = reap_once()
        log.info("reaper: %s", result.as_dict())
        if args.once:
            return 0
        time.sleep(max(1.0, interval))


if __name__ == "__main__":  # pragma: no cover - process entry point
    raise SystemExit(main())
