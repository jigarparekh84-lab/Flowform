"""CR-006 — request ids, liveness/readiness, Sentry scrubbing, OTel opt-in.

No collector, DSN or network is used: the Sentry test injects a recording
transport, and tracing is asserted inert without an OTLP endpoint.
"""

from __future__ import annotations

import logging
import os
import uuid

import pytest

if not os.environ.get("DATABASE_URL"):
    pytest.skip("DATABASE_URL not set (Postgres tests)", allow_module_level=True)

from fastapi.testclient import TestClient  # noqa: E402

from app import health as H  # noqa: E402
from app import observability as O  # noqa: E402
from app.main import app  # noqa: E402


@pytest.fixture(autouse=True)
def _fresh(monkeypatch):
    monkeypatch.setenv("READYZ_CACHE_S", "0")
    monkeypatch.setenv("READYZ_TIMEOUT_S", "1")
    H.reset_readiness_cache()
    yield
    H.reset_readiness_cache()
    O.reset_observability_for_tests()


def _client() -> TestClient:
    return TestClient(app)


# ---------------------------------------------------------------- request ids


def test_request_id_is_echoed_generated_and_sanitised():
    c = _client()
    assert c.get("/livez", headers={"X-Request-ID": "req-12345678"}).headers["x-request-id"] == "req-12345678"

    generated = c.get("/livez").headers["x-request-id"]
    assert len(generated) >= 8

    for bad in ("short", "has space", "x" * 200):
        got = c.get("/livez", headers={"X-Request-ID": bad}).headers["x-request-id"]
        assert got != bad, bad
        assert O.valid_request_id(got) == got

    # Non-ASCII is legal over the wire as latin-1 but not a sane log token.
    raw = "unicode-é-12345678".encode("latin-1")
    got = c.get("/livez", headers={"X-Request-ID": raw}).headers["x-request-id"]
    assert got != raw.decode("latin-1")
    assert O.valid_request_id(got) == got


def test_request_id_survives_an_auth_failure(monkeypatch):
    monkeypatch.setenv("AUTH_MODE", "off")
    r = _client().get("/v1/projects", headers={"X-Request-ID": "req-auth-401"})
    assert r.status_code == 401
    assert r.headers["x-request-id"] == "req-auth-401"


def test_log_lines_carry_the_request_id(monkeypatch):
    record = logging.LogRecord("flowform.api", logging.INFO, __file__, 1, "hello", None, None)
    O.RequestIdFilter().filter(record)
    assert record.request_id == "-"

    with O.request_context("rid-in-context"):
        record = logging.LogRecord("flowform.api", logging.INFO, __file__, 1, "hello", None, None)
        O.RequestIdFilter().filter(record)
        assert record.request_id == "rid-in-context"
        assert O.RequestIdFormatter("request_id=%(request_id)s").format(record) == "request_id=rid-in-context"


# ---------------------------------------------------------------- liveness


def test_health_and_livez_are_dependency_free():
    c = _client()
    legacy = c.get("/health")
    assert legacy.status_code == 200 and legacy.json()["status"] == "ok"
    assert legacy.json()["model"].endswith("+explain-v1")
    assert c.get("/livez").json()["status"] == "alive"


def test_livez_stays_up_when_the_database_is_down(monkeypatch):
    monkeypatch.setenv("AUTH_MODE", "dev")
    monkeypatch.setenv("DATABASE_URL", "postgresql+psycopg://flowform:flowform@127.0.0.1:5999/flowform")
    c = _client()
    assert c.get("/livez").status_code == 200
    ready = c.get("/readyz")
    assert ready.status_code == 503
    assert ready.json()["checks"]["database"].startswith(("error", "timeout"))
    # the probe must never leak the DSN or a password
    assert "flowform:flowform" not in ready.text

    # the same dependencies must not make the process look dead
    assert c.get("/health").status_code == 200


# ---------------------------------------------------------------- readiness


def test_readyz_checks_database_and_queue(monkeypatch):
    monkeypatch.setenv("AUTH_MODE", "dev")
    monkeypatch.setenv("QUEUE_BACKEND", "manual")
    r = _client().get("/readyz", headers={"X-Request-ID": "req-readyz-1"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "ready"
    assert body["checks"] == {"database": "ok", "queue": "ok (manual)"}
    assert body["requestId"] == "req-readyz-1"


def test_readyz_does_not_require_a_database_for_a_solve_only_deployment(monkeypatch):
    monkeypatch.setenv("AUTH_MODE", "off")
    monkeypatch.setenv("QUEUE_BACKEND", "inline")
    monkeypatch.delenv("READYZ_REQUIRE_DB", raising=False)
    monkeypatch.setenv("DATABASE_URL", "postgresql+psycopg://flowform:flowform@127.0.0.1:5999/flowform")
    r = _client().get("/readyz")
    assert r.status_code == 200, r.text
    assert r.json()["checks"]["database"] == "not_required"

    monkeypatch.setenv("READYZ_REQUIRE_DB", "1")
    H.reset_readiness_cache()
    assert _client().get("/readyz").status_code == 503


def test_readyz_is_cached(monkeypatch):
    monkeypatch.setenv("AUTH_MODE", "dev")
    monkeypatch.setenv("QUEUE_BACKEND", "manual")
    monkeypatch.setenv("READYZ_CACHE_S", "60")
    H.reset_readiness_cache()
    calls: list[str] = []
    real = H.database_check
    monkeypatch.setattr(H, "database_check", lambda: (calls.append("db"), real())[1])
    assert _client().get("/readyz").status_code == 200
    assert _client().get("/readyz").status_code == 200
    assert calls == ["db"], "a 60 s cache must serve the second probe"


# ---------------------------------------------------------------- Sentry


class RecordingTransport:
    """Minimal stand-in for sentry_sdk.transport.Transport (subclassed below)."""

    def __init__(self) -> None:
        self.envelopes: list[object] = []

    def capture_envelope(self, envelope):  # noqa: ANN001
        self.envelopes.append(envelope)

    def flush(self, timeout=None, callback=None):  # noqa: ANN001
        # Transport.flush callbacks are ``(pending_events, timeout)``.
        if callback:
            callback(0, timeout or 0.0)

    def kill(self):
        pass

    def record_lost_event(self, *args, **kwargs):
        pass


def recording_transport():
    """Sentry only accepts a real Transport instance, so subclass it."""
    from sentry_sdk.transport import Transport

    class Recorder(RecordingTransport, Transport):
        def __init__(self) -> None:
            Transport.__init__(self)
            RecordingTransport.__init__(self)

    return Recorder()


def test_sentry_is_inert_without_a_dsn(monkeypatch):
    monkeypatch.delenv("SENTRY_DSN", raising=False)
    assert O.init_sentry() is False


def test_sentry_scrubs_credentials_and_tags_the_request_id():
    event = {
        "request": {
            "url": "https://api.flowform.test/v1/auth/callback",
            "headers": {
                "Authorization": "Bearer secret-token",
                "Cookie": "session=secret",
                "X-Dev-Role": "owner",
                "Accept": "application/json",
            },
            "data": '{"payload": "a whole plan"}',
            "cookies": {"session": "secret"},
            "query_string": "code=secret-code",
        },
        "tags": {},
    }
    with O.request_context("rid-sentry-1"):
        scrubbed = O._scrub_event(event)
    headers = scrubbed["request"]["headers"]
    assert "Authorization" not in headers and "Cookie" not in headers and "X-Dev-Role" not in headers
    assert headers["Accept"] == "application/json"
    assert "data" not in scrubbed["request"] and "cookies" not in scrubbed["request"]
    assert "query_string" not in scrubbed["request"]
    assert scrubbed["tags"]["request_id"] == "rid-sentry-1"
    assert scrubbed["request"]["url"].endswith("/v1/auth/callback")


def test_sentry_init_wires_a_transport(monkeypatch):
    import sentry_sdk

    monkeypatch.setenv("SENTRY_DSN", "https://public@example.invalid/1")
    monkeypatch.setenv("SENTRY_TRACES_SAMPLE_RATE", "0")
    rec = recording_transport()
    try:
        assert O.init_sentry(transport=rec) is True
        with O.request_context("rid-sentry-2"):
            sentry_sdk.capture_message("boom")
        sentry_sdk.flush(timeout=2)
        assert rec.envelopes, "the recording transport should have received the event"
    finally:
        # Detach the recording client; `Hub` is deprecated in sentry-sdk 2.x.
        client = sentry_sdk.get_client()
        if client is not None:
            client.close(timeout=1)
        sentry_sdk.get_global_scope().set_client(None)


# ---------------------------------------------------------------- tracing


def test_tracing_is_inert_without_an_endpoint(monkeypatch):
    monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
    monkeypatch.delenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", raising=False)
    monkeypatch.delenv("OTEL_SDK_DISABLED", raising=False)
    O.reset_observability_for_tests()
    assert O.init_tracing(None) is False
    with O.run_span(uuid.uuid4()) as span:
        assert span is None


def test_tracing_can_be_disabled_explicitly(monkeypatch):
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:4318")
    monkeypatch.setenv("OTEL_SDK_DISABLED", "1")
    O.reset_observability_for_tests()
    assert O.init_tracing(None) is False
