"""Thin queue interface (ADR-003). Endpoints only call ``get_queue()``.

Backends (``QUEUE_BACKEND``):
  * ``inline`` (default; local dev + CI) — in-process thread pool.
  * ``arq``    — Redis + Arq (``REDIS_URL``); worker: ``arq app.jobs.worker.WorkerSettings``.
  * ``manual`` — tests only: records jobs, runs nothing until ``drain()``.
Swapping to SQS/Celery later means one more class here, no endpoint changes.
"""

from __future__ import annotations

import asyncio
import os
import uuid
from concurrent.futures import Future, ThreadPoolExecutor
from functools import lru_cache
from typing import Protocol

from .runner import execute_run

REDIS_URL_DEFAULT = "redis://127.0.0.1:6380/0"
ARQ_FUNCTION = "run_job"


class JobQueue(Protocol):
    name: str

    def enqueue(self, run_id: uuid.UUID, tenant_id: uuid.UUID) -> None: ...

    def cancel(self, run_id: uuid.UUID) -> None:
        """Best-effort transport-level abort; the DB status flip is authoritative."""
        ...


class InlineQueue:
    name = "inline"

    def __init__(self, workers: int = 4) -> None:
        self._pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="ff-run")
        self.futures: dict[uuid.UUID, Future] = {}

    def enqueue(self, run_id: uuid.UUID, tenant_id: uuid.UUID) -> None:
        self.futures[run_id] = self._pool.submit(execute_run, run_id, tenant_id)

    def cancel(self, run_id: uuid.UUID) -> None:
        f = self.futures.get(run_id)
        if f is not None:
            f.cancel()  # only stops it if not started; runner honours DB status otherwise


class ManualQueue:
    name = "manual"

    def __init__(self) -> None:
        self.jobs: list[tuple[uuid.UUID, uuid.UUID]] = []

    def enqueue(self, run_id: uuid.UUID, tenant_id: uuid.UUID) -> None:
        self.jobs.append((run_id, tenant_id))

    def cancel(self, run_id: uuid.UUID) -> None:
        pass

    def drain(self) -> list[str]:
        jobs, self.jobs = self.jobs, []
        return [execute_run(r, t) for r, t in jobs]


class ArqQueue:
    name = "arq"

    def __init__(self, url: str | None = None) -> None:
        self.url = url or os.environ.get("REDIS_URL", REDIS_URL_DEFAULT)

    async def _pool(self):
        from arq import create_pool
        from arq.connections import RedisSettings

        return await create_pool(RedisSettings.from_dsn(self.url))

    async def _enqueue(self, run_id: uuid.UUID, tenant_id: uuid.UUID) -> None:
        pool = await self._pool()
        try:
            await pool.enqueue_job(ARQ_FUNCTION, str(run_id), str(tenant_id), _job_id=str(run_id))
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

    def enqueue(self, run_id: uuid.UUID, tenant_id: uuid.UUID) -> None:
        asyncio.run(self._enqueue(run_id, tenant_id))

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
