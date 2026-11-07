"""Arq worker: ``arq app.jobs.worker.WorkerSettings`` (needs DATABASE_URL, REDIS_URL)."""

from __future__ import annotations

import asyncio
import os
import uuid

from arq.connections import RedisSettings

from ..observability import configure_logging, init_tracing, run_span
from .queue import ARQ_FUNCTION, REDIS_URL_DEFAULT
from .reaper import reap_once
from .runner import execute_run


# The worker has no HTTP app, but it can still export spans when OTLP is set.
configure_logging()
init_tracing()


async def run_job(ctx: dict, run_id: str, tenant_id: str) -> str:
    # Solver is CPU-bound and synchronous: run it off the event loop.
    with run_span(run_id):
        return await asyncio.to_thread(execute_run, uuid.UUID(run_id), uuid.UUID(tenant_id))


run_job.__name__ = ARQ_FUNCTION


async def reap_on_startup(ctx: dict) -> None:
    """A worker starting up is the natural moment to reclaim its predecessor's
    runs. The API process runs the periodic sweep; this closes the gap when the
    API and workers are deployed separately."""
    await asyncio.to_thread(reap_once)


class WorkerSettings:
    functions = [run_job]
    on_startup = [reap_on_startup]
    redis_settings = RedisSettings.from_dsn(os.environ.get("REDIS_URL", REDIS_URL_DEFAULT))
    allow_abort_jobs = True
    max_jobs = int(os.environ.get("WORKER_MAX_JOBS", "2"))
    job_timeout = int(os.environ.get("WORKER_JOB_TIMEOUT_S", "3600"))
