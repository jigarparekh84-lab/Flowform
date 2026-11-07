"""Thin queue interface (ADR-003). Endpoints only call ``get_queue()``.

Backends (``QUEUE_BACKEND``):
  * ``inline`` (default; local dev + CI) — in-process thread pool.
  * ``arq``    — Redis + Arq (``REDIS_URL``); worker: ``arq app.jobs.worker.WorkerSettings``.
  * ``manual`` — tests only: records jobs, runs nothing until ``drain()``.
Swapping to SQS/Celery later means one more class here, no endpoint changes.

Delivery is at-least-once on every backend, and deliberately so: the runner's
conditional claim (``runner.claim``) makes a duplicate message a no-op. The
queue therefore only has to avoid *needless* duplicates — ``enqueue`` dedupes a
job that is still pending, and Arq gets an attempt-scoped ``_job_id`` so a
recovery re-dispatch is not swallowed by a finished job's retained result.
"""

from __future__ import annotations

import asyncio
import logging
import os
import uuid
from concurrent.futures import Future, ThreadPoolExecutor
from functools import lru_cache
from typing import Protocol

from ..observability import run_span
from .runner import execute_run

log = logging.getLogger("flowform.jobs")

REDIS_URL_DEFAULT = "redis://127.0.0.1:6380/0"
ARQ_FUNCTION = "run_job"


def job_id(run_id: uuid.UUID, attempt: int) -> str:
    """Transport id: one job per attempt, so a retry is never deduped away."""
    return str(run_id) if attempt <= 1 else f"{run_id}:a{attempt}"


def _execute(run_id: uuid.UUID, tenant_id: uuid.UUID) -> str:
    """Run a solve inside a span so in-process jobs show up in traces."""
    with run_span(run_id):
        return execute_run(run_id, tenant_id)


class JobQueue(Protocol):
    name: str

    def enqueue(self, run_id: uuid.UUID, tenant_id: uuid.UUID, attempt: int = 1) -> None: ...

    def cancel(self, run_id: uuid.UUID) -> None:
        """Best-effort transport-level abort; the DB status flip is authoritative."""
        ...


class InlineQueue:
    name = "inline"

    def __init__(self, workers: int = 4) -> None:
        self._pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="ff-run")
        self.futures: dict[uuid.UUID, Future] = {}

    def enqueue(self, run_id: uuid.UUID, tenant_id: uuid.UUID, attempt: int = 1) -> None:
        pending = self.futures.get(run_id)
        if pending is not None and not pending.done():
            return  # same run already executing in this process
        self.futures[run_id] = self._pool.submit(_execute, run_id, tenant_id)

    def cancel(self, run_id: uuid.UUID) -> None:
        f = self.futures.get(run_id)
        if f is not None:
            f.cancel()  # only stops it if not started; runner honours DB status otherwise


class ManualQueue:
    name = "manual"

    def __init__(self) -> None:
        self.jobs: list[tuple[uuid.UUID, uuid.UUID]] = []

    def enqueue(self, run_id: uuid.UUID, tenant_id: uuid.UUID, attempt: int = 1) -> None:
        if any(rid == run_id for rid, _ in self.jobs):
            return
        self.jobs.append((run_id, tenant_id))

    def cancel(self, run_id: uuid.UUID) -> None:
        pass

    def drain(self) -> list[str]:
        jobs, self.jobs = self.jobs, []
        return [_execute(r, t) for r, t in jobs]


class ArqQueue:
    name = "arq"

    def __init__(self, url: str | None = None) -> None:
        self.url: str = url or os.environ.get("REDIS_URL") or REDIS_URL_DEFAULT

    async def _pool(self):
        from arq import create_pool
        from arq.connections import RedisSettings

        return await create_pool(RedisSettings.from_dsn(self.url))

    async def _enqueue(self, run_id: uuid.UUID, tenant_id: uuid.UUID, attempt: int) -> None:
        pool = await self._pool()
        try:
            await pool.enqueue_job(
                ARQ_FUNCTION, str(run_id), str(tenant_id), _job_id=job_id(run_id, attempt)
            )
        finally:
            await pool.aclose()

    async def _cancel(self, run_id: uuid.UUID) -> None:
        from arq.jobs import Job

        pool = await self._pool()
        try:
            await Job(str(run_id), pool).abort(timeout=0)
        except Exception:
            pass
        finally:
            await pool.aclose()

    def enqueue(self, run_id: uuid.UUID, tenant_id: uuid.UUID, attempt: int = 1) -> None:
        asyncio.run(self._enqueue(run_id, tenant_id, attempt))

    def cancel(self, run_id: uuid.UUID) -> None:
        asyncio.run(self._cancel(run_id))


@lru_cache(maxsize=1)
def get_queue() -> JobQueue:
    backend = os.environ.get("QUEUE_BACKEND", "inline").lower()
    if backend == "arq":
        return ArqQueue()
    if backend == "manual":
        return ManualQueue()
    return InlineQueue()


def enqueue_run(run_id: uuid.UUID, tenant_id: uuid.UUID, attempt: int = 1) -> bool:
    """Hand a run to the queue without failing the request that created it.

    The row is already committed, so a transport outage must not turn a created
    run into a 500: the reaper re-dispatches runs whose ``dispatched_at`` goes
    stale. Returns whether the hand-off succeeded (for logging/tests).
    """
    try:
        get_queue().enqueue(run_id, tenant_id, attempt=attempt)
        return True
    except Exception:  # noqa: BLE001 - queue outage must not fail the API call
        log.exception(
            "could not enqueue run %s (attempt %s); the reaper will retry", run_id, attempt
        )
        return False
