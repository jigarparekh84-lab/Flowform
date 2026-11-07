"""Liveness and readiness (CR-006).

* ``/health`` — liveness alias kept for compatibility (Docker healthcheck, web probe).
* ``/livez``  — the process is up. No dependencies are touched.
* ``/readyz`` — this deployment can do its job: database and queue are reachable.

Readiness is deliberately *deployment-aware*: a solve-only API with
``AUTH_MODE=off`` and the inline queue needs no database, so a missing Postgres
reports ``not_required`` instead of failing the probe. Workspace deployments
(``AUTH_MODE`` other than ``off``) and the Arq backend do require it; override
with ``READYZ_REQUIRE_DB=0|1``.

Checks are bounded by ``READYZ_TIMEOUT_S`` and cached for ``READYZ_CACHE_S`` so a
frequent probe cannot exhaust connections. Responses never contain a DSN,
password or stack trace — only the failing exception class.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import Any, Callable

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from .metrics import record_readyz
from .observability import current_request_id
from .v1.auth import auth_mode

log = logging.getLogger("flowform.health")

router = APIRouter(tags=["health"])

SERVICE = "flowform-api"
_cache: dict[str, Any] = {"at": 0.0, "body": None, "code": 200}


def timeout_s() -> float:
    try:
        return max(0.2, float(os.environ.get("READYZ_TIMEOUT_S", "2")))
    except ValueError:
        return 2.0


def cache_s() -> float:
    try:
        return max(0.0, float(os.environ.get("READYZ_CACHE_S", "2")))
    except ValueError:
        return 2.0


def reset_readiness_cache() -> None:
    _cache.update(at=0.0, body=None, code=200)


def _flag(name: str, default: bool) -> bool:
    raw = (os.environ.get(name) or "").strip().lower()
    if not raw:
        return default
    return raw not in {"0", "false", "no", "off"}


def requires_database() -> bool:
    """A solve-only deployment may run without Postgres; a workspace may not."""
    backend = (os.environ.get("QUEUE_BACKEND") or "inline").lower()
    return _flag("READYZ_REQUIRE_DB", auth_mode() != "off" or backend == "arq")


# ---------------------------------------------------------------- checks


def database_check() -> str:
    from sqlalchemy import create_engine, text
    from sqlalchemy.pool import NullPool

    from .db.session import database_url

    url = database_url()
    connect_args: dict[str, Any] = {}
    if url.startswith("postgresql"):
        # psycopg's connect_timeout is whole seconds; the outer asyncio timeout
        # covers the rest of the handshake.
        connect_args["connect_timeout"] = max(1, int(round(timeout_s())))
    engine = create_engine(url, poolclass=NullPool, connect_args=connect_args)
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        return "ok"
    finally:
        engine.dispose()


def queue_check() -> str:
    backend = (os.environ.get("QUEUE_BACKEND") or "inline").lower()
    if backend != "arq":
        return f"ok ({backend})"
    import redis

    url = os.environ.get("REDIS_URL", "redis://127.0.0.1:6380/0")
    client = redis.Redis.from_url(
        url, socket_connect_timeout=timeout_s(), socket_timeout=timeout_s()
    )
    try:
        client.ping()
        return "ok (arq)"
    finally:
        client.close()


async def _run_check(name: str, fn: Callable[[], str]) -> str:
    try:
        return await asyncio.wait_for(asyncio.to_thread(fn), timeout=timeout_s())
    except asyncio.TimeoutError:
        log.warning("readiness check %s timed out after %.1fs", name, timeout_s())
        return f"timeout after {timeout_s():g}s"
    except Exception as e:  # noqa: BLE001 - the probe reports, it does not raise
        log.warning("readiness check %s failed: %s", name, str(e)[:200])
        return f"error: {type(e).__name__}"


def _ok(value: str) -> bool:
    return value == "ok" or value == "not_required" or value.startswith("ok (")


# ---------------------------------------------------------------- routes


@router.get("/livez")
def livez() -> dict[str, str]:
    return {"status": "alive", "service": SERVICE}


@router.get("/readyz")
async def readyz() -> JSONResponse:
    now = time.monotonic()
    if _cache["body"] is not None and now - _cache["at"] < cache_s():
        return JSONResponse(_cache["body"], status_code=_cache["code"])

    check_db = requires_database()
    db, queue = await asyncio.gather(
        _run_check("database", database_check) if check_db else _skip("not_required"),
        _run_check("queue", queue_check),
    )
    checks = {"database": db, "queue": queue}
    ready = all(_ok(v) for v in checks.values())
    body = {
        "status": "ready" if ready else "not_ready",
        "service": SERVICE,
        "checks": checks,
        "requestId": current_request_id(),
    }
    code = 200 if ready else 503
    _cache.update(at=now, body=body, code=code)
    # Cached answers are not re-counted, so one failing dependency does not
    # inflate the failure counter once per scrape.
    record_readyz(ready)
    if not ready:
        log.error("readiness failed: %s", checks)
    return JSONResponse(body, status_code=code)


async def _skip(value: str) -> str:
    return value
