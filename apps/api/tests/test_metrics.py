"""CR-006 — Prometheus metrics: endpoint, labels, and the SLO signals.

The registry lives for the whole process, so assertions compare deltas rather
than absolute values. No collector or network is involved: the scrape body is
rendered in-process.
"""

from __future__ import annotations

import os
import re
import uuid

import pytest

if not os.environ.get("DATABASE_URL"):
    pytest.skip("DATABASE_URL not set (Postgres tests)", allow_module_level=True)

from fastapi.testclient import TestClient  # noqa: E402
from prometheus_client import generate_latest  # noqa: E402
from prometheus_client.parser import text_string_to_metric_families  # noqa: E402

from app import health as H  # noqa: E402
from app import metrics as M  # noqa: E402
from app.main import app  # noqa: E402


@pytest.fixture(autouse=True)
def _fresh(monkeypatch):
    monkeypatch.setenv("READYZ_CACHE_S", "0")
    monkeypatch.setenv("READYZ_TIMEOUT_S", "1")
    monkeypatch.delenv("METRICS_ENABLED", raising=False)
    monkeypatch.delenv("METRICS_TOKEN", raising=False)
    H.reset_readiness_cache()
    yield
    H.reset_readiness_cache()


def _client() -> TestClient:
    return TestClient(app)


def _samples(name: str) -> list[tuple[dict[str, str], float]]:
    """Every sample for a metric family rendered from the live registry."""
    out: list[tuple[dict[str, str], float]] = []
    for family in text_string_to_metric_families(generate_latest().decode()):
        for sample in family.samples:
            if sample.name == name:
                out.append((dict(sample.labels), float(sample.value)))
    return out


def _value(name: str, **labels: str) -> float:
    return sum(v for lab, v in _samples(name) if all(lab.get(k) == val for k, val in labels.items()))


def _dev_headers(tenant: uuid.UUID | None = None) -> dict[str, str]:
    return {"X-Dev-Tenant": str(tenant or uuid.uuid4()), "Content-Type": "application/json"}


# ---------------------------------------------------------------- endpoint


def test_metrics_endpoint_is_prometheus_text():
    r = _client().get("/metrics")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/plain")
    assert "# TYPE flowform_http_requests_total counter" in r.text
    assert "# TYPE flowform_runs_total counter" in r.text
    assert "# TYPE flowform_stuck_runs gauge" in r.text


def test_metrics_can_be_disabled(monkeypatch):
    monkeypatch.setenv("METRICS_ENABLED", "0")
    assert _client().get("/metrics").status_code == 404


def test_metrics_token_is_enforced_when_set(monkeypatch):
    monkeypatch.setenv("METRICS_TOKEN", "scrape-secret")
    c = _client()
    assert c.get("/metrics").status_code == 401
    assert c.get("/metrics", headers={"Authorization": "Bearer wrong"}).status_code == 401
    ok = c.get("/metrics", headers={"Authorization": "Bearer scrape-secret"})
    assert ok.status_code == 200
    # The token must not end up in the payload.
    assert "scrape-secret" not in ok.text


# ---------------------------------------------------------------- http labels


def test_http_metrics_use_the_route_template_not_the_request_path(monkeypatch):
    monkeypatch.setenv("AUTH_MODE", "dev")
    c = _client()
    tenant = uuid.uuid4()
    headers = _dev_headers(tenant)
    pid = c.post("/v1/projects", content=b'{"name": "metrics"}', headers=headers).json()["id"]
    rid = str(uuid.uuid4())
    assert c.get(f"/v1/projects/{pid}/runs/{rid}", headers=headers).status_code == 404

    samples = _samples("flowform_http_requests_total")
    routes = {lab.get("route") for lab, _ in samples}
    assert "/v1/projects/{project_id}/runs/{run_id}" in routes
    # Neither the project id nor the run id may appear anywhere in the payload.
    body = generate_latest().decode()
    assert pid not in body
    assert rid not in body

    assert _value(
        "flowform_http_requests_total",
        method="GET",
        route="/v1/projects/{project_id}/runs/{run_id}",
        status="404",
    ) >= 1


def test_unmatched_requests_collapse_to_one_label(monkeypatch):
    c = _client()
    missing = f"/no-such-{uuid.uuid4()}"
    assert c.get(missing).status_code == 404
    assert _value("flowform_http_requests_total", route="unmatched", status="404") >= 1
    assert missing not in generate_latest().decode()


def test_probes_and_scrapes_are_not_measured():
    c = _client()
    c.get("/livez")
    c.get("/health")
    c.get("/metrics")
    routes = {lab.get("route") for lab, _ in _samples("flowform_http_requests_total")}
    assert routes.isdisjoint({"/livez", "/health", "/metrics"})


def test_http_latency_is_recorded_for_api_routes(monkeypatch):
    monkeypatch.setenv("AUTH_MODE", "dev")
    before = _value(
        "flowform_http_request_duration_seconds_count", method="GET", route="/v1/projects"
    )
    _client().get("/v1/projects", headers=_dev_headers())
    after = _value(
        "flowform_http_request_duration_seconds_count", method="GET", route="/v1/projects"
    )
    assert after == before + 1


# ---------------------------------------------------------------- readiness


def test_readyz_updates_status_gauge_and_failure_counter(monkeypatch):
    monkeypatch.setenv("AUTH_MODE", "dev")
    monkeypatch.setenv("QUEUE_BACKEND", "manual")
    assert _client().get("/readyz").status_code == 200
    assert _value("flowform_readyz_status") == 1

    failures = _value("flowform_readyz_failures_total")
    monkeypatch.setenv("DATABASE_URL", "postgresql+psycopg://flowform:flowform@127.0.0.1:5999/flowform")
    H.reset_readiness_cache()
    assert _client().get("/readyz").status_code == 503
    assert _value("flowform_readyz_status") == 0
    assert _value("flowform_readyz_failures_total") == failures + 1


def test_cached_readiness_answers_do_not_inflate_the_failure_counter(monkeypatch):
    monkeypatch.setenv("AUTH_MODE", "dev")
    monkeypatch.setenv("QUEUE_BACKEND", "manual")
    monkeypatch.setenv("DATABASE_URL", "postgresql+psycopg://flowform:flowform@127.0.0.1:5999/flowform")
    monkeypatch.setenv("READYZ_CACHE_S", "60")
    H.reset_readiness_cache()
    before = _value("flowform_readyz_failures_total")
    c = _client()
    assert c.get("/readyz").status_code == 503
    assert c.get("/readyz").status_code == 503  # served from cache
    assert _value("flowform_readyz_failures_total") == before + 1


# ---------------------------------------------------------------- runs


def test_run_lifecycle_metrics(monkeypatch):
    before_success = _value("flowform_runs_total", kind="optimize", status="succeeded")
    before_duration = _value("flowform_run_duration_seconds_count", kind="optimize")
    M.record_run_started("optimize", 2.5)
    M.record_run_finished("optimize", "succeeded", 12.0)
    assert _value("flowform_runs_total", kind="optimize", status="succeeded") == before_success + 1
    assert _value("flowform_run_duration_seconds_count", kind="optimize") == before_duration + 1
    assert _value("flowform_run_queue_wait_seconds_count", kind="optimize") >= 1


def test_cancelled_runs_are_counted_apart_from_failures():
    before = _value("flowform_runs_total", kind="stochastic", status="cancelled")
    M.record_run_finished("stochastic", "cancelled")
    assert _value("flowform_runs_total", kind="stochastic", status="cancelled") == before + 1


def test_a_real_run_updates_the_run_metrics(monkeypatch):
    """The runner, not just the recording helpers, feeds the counters."""
    from app.db.models import Run
    from app.db.session import tenant_session
    from app.jobs import queue as q
    from app.jobs import runner
    from app.jobs.reaper import reap_once

    monkeypatch.setenv("AUTH_MODE", "dev")
    monkeypatch.setenv("QUEUE_BACKEND", "manual")
    q.get_queue.cache_clear()

    tenant = uuid.uuid4()
    headers = _dev_headers(tenant)
    pid = _client().post("/v1/projects", content=b'{"name": "metrics-run"}', headers=headers).json()["id"]

    with tenant_session(tenant) as s:
        r = Run(tenant_id=tenant, project_id=uuid.UUID(pid), kind="optimize",
                status="queued", progress=0.0, payload={})
        s.add(r)
        s.flush()
        run_id = r.id

    # Stub the solve so this test measures telemetry, not the MIP.
    monkeypatch.setitem(runner.KINDS, "optimize", lambda payload: {"status": "Optimal"})
    before_success = _value("flowform_runs_total", kind="optimize", status="succeeded")
    before_wait = _value("flowform_run_queue_wait_seconds_count", kind="optimize")
    assert runner.execute_run(run_id, tenant) == "succeeded"
    assert _value("flowform_runs_total", kind="optimize", status="succeeded") == before_success + 1
    assert _value("flowform_run_queue_wait_seconds_count", kind="optimize") == before_wait + 1

    # A sweep always refreshes the stuck-runs gauge, even when it recovers nothing.
    reap_once(enqueue=False)
    assert _samples("flowform_stuck_runs"), "the reaper must publish the stuck-runs gauge"


def test_reaper_outcomes_and_stuck_gauge():
    M.record_reaped({"requeued": 2, "failed": 0, "redispatched": 1})
    assert _value("flowform_runs_reaped_total", outcome="requeued") >= 2
    assert _value("flowform_runs_reaped_total", outcome="redispatched") >= 1
    M.set_stuck_runs(4)
    assert _value("flowform_stuck_runs") == 4
    M.set_stuck_runs(0)


# ---------------------------------------------------------------- promises


def test_no_tenant_user_or_run_labels_exist():
    """The label vocabulary is closed: nothing customer-specific can leak."""
    allowed = {
        "method", "route", "status", "kind", "outcome",
    }
    for name in (
        "flowform_http_requests_total",
        "flowform_runs_total",
        "flowform_runs_reaped_total",
    ):
        for labels, _ in _samples(name):
            assert set(labels) <= allowed, (name, labels)
    # And no label value looks like an identifier.
    id_like = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
    for labels, _ in _samples("flowform_http_requests_total"):
        assert not any(id_like.match(v or "") for v in labels.values()), labels
