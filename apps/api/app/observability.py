"""Observability baseline (CR-006): request ids, Sentry and OpenTelemetry.

Everything here is **inert unless configured**, so a browser-only or test
deployment needs no collector and no DSN:

* **Request ids** are always on. Every HTTP response carries ``X-Request-ID``
  (an inbound value is reused only when it is a sane 8–128 char token), every
  ``flowform*`` log line carries ``request_id=…``, and Sentry events are tagged
  with it.
* **Sentry** initialises when ``SENTRY_DSN`` is set; request bodies, cookies,
  query strings and auth/dev headers are stripped before an event leaves the
  process.
* **OpenTelemetry** initialises when ``OTEL_EXPORTER_OTLP_ENDPOINT`` (or the
  traces-specific endpoint) is set. FastAPI is instrumented with the standard
  HTTP/ASGI spans, and solve jobs get a ``run.execute`` span.

Configuration:

| Setting | Default | Meaning |
|---|---|---|
| `LOG_LEVEL` | `INFO` | level for the `flowform` logger |
| `HTTP_REQUEST_LOG` | `1` | one structured line per request (health probes excluded) |
| `SENTRY_DSN` | — | enables error reporting |
| `SENTRY_ENVIRONMENT` / `APP_ENV` | — | Sentry environment |
| `SENTRY_RELEASE` / `APP_RELEASE` | — | release tag |
| `SENTRY_TRACES_SAMPLE_RATE` | `0` | Sentry performance tracing |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | — | enables OTLP/HTTP tracing |
| `OTEL_SERVICE_NAME` | `flowform-api` | resource service name |
| `OTEL_TRACES_SAMPLE_RATE` | `0.1` | head sampling ratio once tracing is on |
| `OTEL_SDK_DISABLED` | — | `1` forces tracing off |
"""

from __future__ import annotations

import contextvars
import logging
import os
import re
import time
import uuid
from contextlib import contextmanager
from typing import Any, Iterator, MutableMapping

from starlette.datastructures import MutableHeaders

from . import metrics

log = logging.getLogger("flowform.observability")

REQUEST_ID_HEADER = "X-Request-ID"
LOG_FORMAT = "%(asctime)s %(levelname)s %(name)s request_id=%(request_id)s %(message)s"
HEALTH_PATHS = frozenset({"/health", "/livez", "/readyz", "/metrics"})
#: Headers that must never reach Sentry (or a log line).
SENSITIVE_HEADERS = frozenset({
    "authorization", "cookie", "set-cookie", "x-api-key", "proxy-authorization",
})

_request_id: contextvars.ContextVar[str | None] = contextvars.ContextVar("flowform_request_id", default=None)
_request_id_pattern = re.compile(r"^[A-Za-z0-9._:-]{8,128}$")
_STATE: dict[str, Any] = {"logging": False, "sentry": False, "tracing": None, "instrumented": False}


# ---------------------------------------------------------------- request ids


def current_request_id() -> str | None:
    return _request_id.get()


def valid_request_id(raw: str | None) -> str | None:
    """Accept a caller id only when it is bounded and cannot inject into logs."""
    candidate = (raw or "").strip()
    return candidate if _request_id_pattern.match(candidate) else None


def new_request_id(raw: str | None = None) -> str:
    return valid_request_id(raw) or uuid.uuid4().hex


@contextmanager
def request_context(request_id: str | None) -> Iterator[str | None]:
    """Bind a request id for code outside the HTTP middleware (jobs, tests)."""
    token = _request_id.set(request_id)
    try:
        yield request_id
    finally:
        _request_id.reset(token)


def request_id_from_headers(headers: Any) -> str:
    """``headers`` is the raw ASGI list of (name, value) byte pairs."""
    for name, value in headers or []:
        if name.lower() == b"x-request-id":
            return new_request_id(value.decode("latin-1"))
    return new_request_id()


# ---------------------------------------------------------------- logging


class RequestIdFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        if not hasattr(record, "request_id"):
            record.request_id = current_request_id() or "-"
        return True


class RequestIdFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        if not hasattr(record, "request_id"):
            record.request_id = current_request_id() or "-"
        return super().format(record)


def configure_logging() -> None:
    """One stderr handler for ``flowform*`` loggers, with the request id field."""
    if _STATE["logging"]:
        return
    level = getattr(logging, os.environ.get("LOG_LEVEL", "INFO").upper(), logging.INFO)
    logger = logging.getLogger("flowform")
    if not logger.handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(RequestIdFormatter(LOG_FORMAT))
        handler.addFilter(RequestIdFilter())
        logger.addHandler(handler)
    logger.setLevel(level)
    logger.propagate = True
    _STATE["logging"] = True


def _http_log_enabled() -> bool:
    return os.environ.get("HTTP_REQUEST_LOG", "1").strip().lower() not in {"0", "false", "no", "off"}


class RequestContextMiddleware:
    """Pure ASGI middleware (not BaseHTTPMiddleware, which would buffer SSE)."""

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: MutableMapping[str, Any], receive: Any, send: Any) -> None:
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return
        request_id = request_id_from_headers(scope.get("headers"))
        token = _request_id.set(request_id)
        started = time.perf_counter()
        status = 0

        async def send_with_request_id(message: MutableMapping[str, Any]) -> None:
            nonlocal status
            if message.get("type") == "http.response.start":
                status = int(message.get("status") or 0)
                headers = MutableHeaders(scope=message)
                if "x-request-id" not in headers:
                    headers[REQUEST_ID_HEADER] = request_id
            await send(message)

        try:
            await self.app(scope, receive, send_with_request_id)
        finally:
            elapsed_ms = (time.perf_counter() - started) * 1000
            path = str(scope.get("path") or "")
            # Metrics use the route template (see metrics.SKIP_ROUTES), which is
            # set on the scope by Starlette's router after matching.
            route = getattr(scope.get("route"), "path", None)
            metrics.observe_http(
                str(scope.get("method", "?")),
                route if isinstance(route, str) else "unmatched",
                status,
                elapsed_ms / 1000,
            )
            if _http_log_enabled() and path not in HEALTH_PATHS:
                log.info(
                    "%s %s → %s %.0fms",
                    scope.get("method", "?"), path, status or 500, elapsed_ms,
                )
            _request_id.reset(token)


# ---------------------------------------------------------------- Sentry


def _scrub_event(event: dict[str, Any], hint: Any = None) -> dict[str, Any]:
    """Remove credentials and request content before an event leaves the app."""
    request = event.get("request")
    if isinstance(request, dict):
        request.pop("data", None)
        request.pop("cookies", None)
        request.pop("query_string", None)
        headers = request.get("headers")
        if isinstance(headers, dict):
            for name in list(headers):
                lowered = name.lower()
                if lowered in SENSITIVE_HEADERS or lowered.startswith("x-dev-"):
                    headers.pop(name, None)
    tags = event.setdefault("tags", {})
    if isinstance(tags, dict):
        rid = current_request_id()
        if rid:
            tags.setdefault("request_id", rid)
    return event


def _privacy_options() -> dict[str, Any]:
    """Collect nothing by default, on both the old and the new SDK option.

    sentry-sdk 2.7x deprecated ``send_default_pii`` in favour of the structured
    ``data_collection`` map, and passing both emits a warning. The module probe
    keeps older 2.x installs working, since requirements are not pinned.
    """
    try:
        import sentry_sdk.data_collection  # noqa: F401
    except ImportError:
        return {"send_default_pii": False}
    return {
        "data_collection": {
            "user_info": False,
            "cookies": {"mode": "off"},
            "url_query_params": {"mode": "off"},
            "http_headers": {"mode": "off"},
            "http_bodies": [],  # a project snapshot is the customer's whole plan
            "stack_frame_variables": False,
        }
    }


def _float_env(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, "") or default)
    except ValueError:
        return default


def init_sentry(transport: Any = None) -> bool:
    """Enable error reporting when ``SENTRY_DSN`` is set; never fail startup."""
    dsn = (os.environ.get("SENTRY_DSN") or "").strip()
    if not dsn:
        return False
    try:
        import sentry_sdk
    except ImportError:  # pragma: no cover - requirements install it
        log.warning("SENTRY_DSN is set but sentry-sdk is not installed; errors will not be reported")
        return False
    integrations: list[Any] = []
    try:
        from sentry_sdk.integrations.fastapi import FastApiIntegration
        from sentry_sdk.integrations.starlette import StarletteIntegration

        integrations = [StarletteIntegration(), FastApiIntegration()]
    except ImportError:  # pragma: no cover - the fastapi extra provides these
        log.warning("Sentry FastAPI integration unavailable; using the plain SDK")
    kwargs: dict[str, Any] = {
        "dsn": dsn,
        "environment": os.environ.get("SENTRY_ENVIRONMENT") or os.environ.get("APP_ENV") or None,
        "release": os.environ.get("SENTRY_RELEASE") or os.environ.get("APP_RELEASE") or None,
        "traces_sample_rate": max(0.0, min(1.0, _float_env("SENTRY_TRACES_SAMPLE_RATE", 0.0))),
        # Bodies are never useful in an error report and often hold a whole plan.
        "max_request_body_size": "never",
        **_privacy_options(),
        "attach_stacktrace": False,
        "integrations": integrations,
        "before_send": _scrub_event,
        "before_send_transaction": _scrub_event,
    }
    if transport is not None:
        kwargs["transport"] = transport
    try:
        sentry_sdk.init(**kwargs)
    except Exception as e:  # noqa: BLE001 - bad DSN must not stop the API
        log.error("Sentry could not be initialised (%s); continuing without it", type(e).__name__)
        return False
    _STATE["sentry"] = True
    return True


# ---------------------------------------------------------------- OpenTelemetry


def _tracing_requested() -> bool:
    if os.environ.get("OTEL_SDK_DISABLED", "").strip().lower() in {"1", "true", "yes", "on"}:
        return False
    return bool(
        os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT")
        or os.environ.get("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT")
    )


def init_tracing(app: Any | None = None) -> bool:
    """Enable OTLP tracing when an endpoint is configured; no-op otherwise."""
    if _STATE["tracing"] is not None:
        if app is not None and not _STATE["instrumented"]:
            _instrument_app(app)
        return True
    if not _tracing_requested():
        return False
    try:
        from opentelemetry import trace
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
        from opentelemetry.sdk.trace.sampling import ParentBased, TraceIdRatioBased
    except ImportError:  # pragma: no cover - requirements install them
        log.warning("OTEL endpoint is set but the OpenTelemetry SDK is not installed; tracing is off")
        return False

    ratio = max(0.0, min(1.0, _float_env("OTEL_TRACES_SAMPLE_RATE", 0.1)))
    resource = Resource.create({
        "service.name": os.environ.get("OTEL_SERVICE_NAME", "flowform-api"),
        "service.version": os.environ.get("APP_RELEASE") or "dev",
        "deployment.environment": os.environ.get("APP_ENV") or "development",
    })
    provider = TracerProvider(resource=resource, sampler=ParentBased(TraceIdRatioBased(ratio)))
    provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
    trace.set_tracer_provider(provider)
    _STATE["tracing"] = provider
    if app is not None:
        _instrument_app(app)
    log.info(
        "tracing enabled (OTLP/HTTP, service=%s, sample=%.2f)",
        resource.attributes.get("service.name"), ratio,
    )
    return True


def _instrument_app(app: Any) -> None:
    try:
        from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

        FastAPIInstrumentor.instrument_app(
            app,
            tracer_provider=_STATE["tracing"],
            excluded_urls="/health,/livez,/readyz,/metrics",
        )
        _STATE["instrumented"] = True
    except Exception as e:  # noqa: BLE001 - tracing must never break serving
        log.warning("FastAPI instrumentation failed (%s); HTTP spans are unavailable", type(e).__name__)


@contextmanager
def run_span(run_id: Any, kind: str | None = None) -> Iterator[Any]:
    """A ``run.execute`` span for a solve, or a no-op when tracing is off."""
    if _STATE["tracing"] is None:
        yield None
        return
    from opentelemetry import trace

    attributes = {"flowform.run_id": str(run_id)}
    if kind:
        attributes["flowform.run_kind"] = kind
    with trace.get_tracer("flowform.jobs").start_as_current_span("run.execute", attributes=attributes) as span:
        yield span


def shutdown_tracing() -> None:
    provider = _STATE["tracing"]
    if provider is None:
        return
    try:
        provider.shutdown()
    except Exception:  # noqa: BLE001 - shutdown must not mask the real exit path
        log.debug("tracer shutdown failed", exc_info=True)
    _STATE["tracing"] = None
    _STATE["instrumented"] = False


def reset_observability_for_tests() -> None:
    """Drop Sentry/OTel state without flushing (tests only)."""
    _STATE["sentry"] = False
    _STATE["tracing"] = None
    _STATE["instrumented"] = False
    _request_id.set(None)
