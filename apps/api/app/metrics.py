"""Prometheus metrics (CR-006): the scrape endpoint and the SLO signals.

The API already emits logs and traces; this module adds the third leg so the
SLOs in ``docs/OBSERVABILITY.md`` can page someone instead of being a query an
engineer remembers to run.

Deliberate limits:

* **No customer identifiers as labels.** Labels are route templates, methods,
  statuses, run kinds and outcomes. Tenant, user, project and run ids never
  appear, so the metric store holds no customer data and cardinality cannot
  grow with the customer base.
* **Bounded label sets.** Routes come from ``scope["route"].path`` (the
  template), not the request path; unmatched requests collapse to
  ``route="unmatched"``.
* **Scrapes are free.** ``/metrics``, ``/health``, ``/livez`` and ``/readyz``
  are not counted or timed, so a 15 s scrape cannot dominate the histograms.

Configuration:

| Setting | Default | Meaning |
|---|---|---|
| `METRICS_ENABLED` | `1` | set `0` to return 404 from `/metrics` |
| `METRICS_TOKEN` | — | when set, scrapes need `Authorization: Bearer <token>` |
"""

from __future__ import annotations

import hmac
import logging
import os
from typing import Any

from fastapi import APIRouter, Header
from fastapi.responses import JSONResponse, Response

log = logging.getLogger("flowform.metrics")

try:  # optional in stripped deployments; requirements.txt installs it
    from prometheus_client import CONTENT_TYPE_LATEST, Counter, Gauge, Histogram, generate_latest

    AVAILABLE = True
except ImportError:  # pragma: no cover - requirements install it
    AVAILABLE = False

#: Never measured: probes would dominate latency, and scrapes would count themselves.
SKIP_ROUTES = frozenset({"/metrics", "/health", "/livez", "/readyz"})

router = APIRouter(tags=["metrics"])

#: Optional-dependency sentinels. A stripped deployment has no metric objects at
#: all, so these are ``Any``; every use site returns early when ``AVAILABLE`` is
#: false, so they are never dereferenced.
HTTP_REQUESTS: Any
HTTP_LATENCY: Any
READYZ_STATUS: Any
READYZ_FAILURES: Any
RUNS: Any
RUN_DURATION: Any
RUN_QUEUE_WAIT: Any
REAPED: Any
STUCK_RUNS: Any

if AVAILABLE:
    HTTP_REQUESTS = Counter(
        "flowform_http_requests_total",
        "HTTP requests by method, route template and status.",
        ["method", "route", "status"],
    )
    HTTP_LATENCY = Histogram(
        "flowform_http_request_duration_seconds",
        "HTTP request latency by method and route template.",
        ["method", "route"],
        buckets=(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30),
    )
    READYZ_STATUS = Gauge(
        "flowform_readyz_status",
        "1 when the last readiness check passed, 0 when it did not.",
    )
    READYZ_FAILURES = Counter(
        "flowform_readyz_failures_total",
        "Readiness checks that returned 503.",
    )
    RUNS = Counter(
        "flowform_runs_total",
        "Terminal run outcomes by kind and status (cancelled is excluded from success ratios).",
        ["kind", "status"],
    )
    RUN_DURATION = Histogram(
        "flowform_run_duration_seconds",
        "Solve duration from claim to terminal state, by run kind.",
        ["kind"],
        buckets=(1, 5, 15, 30, 60, 120, 300, 600, 1800, 3600),
    )
    RUN_QUEUE_WAIT = Histogram(
        "flowform_run_queue_wait_seconds",
        "Time between a run being created and a worker claiming it, by run kind.",
        ["kind"],
        buckets=(0.5, 1, 5, 15, 30, 60, 120, 300, 600),
    )
    REAPED = Counter(
        "flowform_runs_reaped_total",
        "Recovery actions taken by the run reaper, by outcome.",
        ["outcome"],
    )
    STUCK_RUNS = Gauge(
        "flowform_stuck_runs",
        "Non-terminal runs whose last heartbeat/dispatch is older than the stuck threshold.",
    )
else:  # pragma: no cover - requirements install prometheus-client
    HTTP_REQUESTS = HTTP_LATENCY = READYZ_STATUS = READYZ_FAILURES = None
    RUNS = RUN_DURATION = RUN_QUEUE_WAIT = REAPED = STUCK_RUNS = None


# ---------------------------------------------------------------- recording


def observe_http(method: str, route: str | None, status: int, seconds: float) -> None:
    """Count and time one request; ``route`` is a template, never a raw path."""
    if not AVAILABLE:
        return
    label = route or "unmatched"
    if label in SKIP_ROUTES:
        return
    HTTP_REQUESTS.labels(method=method, route=label, status=str(status or 500)).inc()
    HTTP_LATENCY.labels(method=method, route=label).observe(max(0.0, seconds))


def record_readyz(ready: bool) -> None:
    if not AVAILABLE:
        return
    READYZ_STATUS.set(1 if ready else 0)
    if not ready:
        READYZ_FAILURES.inc()


def record_run_started(kind: str, queue_wait_s: float | None) -> None:
    if not AVAILABLE:
        return
    if queue_wait_s is not None:
        RUN_QUEUE_WAIT.labels(kind=kind).observe(max(0.0, queue_wait_s))


def record_run_finished(kind: str, status: str, seconds: float | None = None) -> None:
    if not AVAILABLE:
        return
    RUNS.labels(kind=kind, status=status).inc()
    if seconds is not None:
        RUN_DURATION.labels(kind=kind).observe(max(0.0, seconds))


def record_reaped(counts: dict[str, int]) -> None:
    if not AVAILABLE:
        return
    for outcome in ("requeued", "failed", "redispatched"):
        n = int(counts.get(outcome) or 0)
        if n:
            REAPED.labels(outcome=outcome).inc(n)


def set_stuck_runs(count: int) -> None:
    if not AVAILABLE:
        return
    STUCK_RUNS.set(max(0, int(count)))


# ---------------------------------------------------------------- endpoint


def _enabled() -> bool:
    return os.environ.get("METRICS_ENABLED", "1").strip().lower() not in {"0", "false", "no", "off"}


def _authorised(authorization: str | None) -> bool:
    expected = (os.environ.get("METRICS_TOKEN") or "").strip()
    if not expected:
        return True
    supplied = (authorization or "").strip()
    if supplied.lower().startswith("bearer "):
        supplied = supplied[7:].strip()
    return hmac.compare_digest(supplied, expected)


@router.get("/metrics", include_in_schema=False)
def metrics(authorization: str | None = Header(default=None)) -> Any:
    """Prometheus scrape endpoint (aggregates only — no tenant identifiers)."""
    if not _enabled():
        return JSONResponse({"detail": "metrics are disabled"}, status_code=404)
    if not AVAILABLE:
        return JSONResponse(
            {"detail": "prometheus-client is not installed; metrics are unavailable"},
            status_code=503,
        )
    if not _authorised(authorization):
        return JSONResponse(
            {"detail": "metrics require a bearer token"},
            status_code=401,
            headers={"WWW-Authenticate": "Bearer"},
        )
    return Response(
        content=generate_latest(),
        headers={"Content-Type": CONTENT_TYPE_LATEST, "Cache-Control": "no-store"},
    )
