"""Arq worker: ``arq app.jobs.worker.WorkerSettings`` (needs DATABASE_URL, REDIS_URL)."""

from __future__ import annotations

import asyncio
import os
import uuid

from arq.connections import RedisSettings

from .queue import ARQ_FUNCTION, REDIS_URL_DEFAULT
from .runner import execute_run


async def run_job(ctx: dict, run_id: str, tenant_id: str) -> str:
    # Solver is CPU-bound and synchronous: run it off the event loop.
    return await asyncio.to_thread(execute_run, uuid.UUID(run_id), uuid.UUID(tenant_id))


run_job.__name__ = ARQ_FUNCTION


class WorkerSettings:
    functions = [run_job]
    redis_settings = RedisSettings.from_dsn(os.environ.get("REDIS_URL", REDIS_URL_DEFAULT))
    allow_abort_jobs = True
    max_jobs = int(os.environ.get("WORKER_MAX_JOBS", "2"))
    job_timeout = int(os.environ.get("WORKER_JOB_TIMEOUT_S", "3600"))
