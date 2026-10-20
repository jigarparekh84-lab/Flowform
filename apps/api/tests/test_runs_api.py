"""FF-105: async run API via the queue interface. Needs DATABASE_URL.
Inline/manual queues run in CI without Redis; the Arq test needs REDIS_URL."""

from __future__ import annotations

import asyncio
import json
import os
import time
import uuid

import pytest

if not os.environ.get("DATABASE_URL"):
    pytest.skip("DATABASE_URL not set (Postgres tests)", allow_module_level=True)

from fastapi.testclient import TestClient  # noqa: E402

from app.jobs import queue as q  # noqa: E402
from app.main import app  # noqa: E402

from .enterprise_payload import load_enterprise_pack, pack_to_optimize_payload  # noqa: E402
from .golden.cases import SHOCKS  # noqa: E402
from .test_demo_cost_scaling import sample_payload  # noqa: E402
from .test_projects_api import _h, _migrated  # noqa: E402,F401

GOLDEN_DIR = os.path.join(os.path.dirname(__file__), "golden")


def _client(monkeypatch, backend: str) -> TestClient:
    monkeypatch.setenv("AUTH_MODE", "dev")
    monkeypatch.setenv("QUEUE_BACKEND", backend)
    q.get_queue.cache_clear()
    return TestClient(app)


@pytest.fixture(autouse=True)
def _reset_queue():
    yield
    q.get_queue.cache_clear()


def _project(c, t) -> str:
    return c.post("/v1/projects", content=b'{"name": "jobs"}', headers=_h(t)).json()["id"]


def _wait(c, t, pid, rid, timeout=120.0) -> dict:
    end = time.time() + timeout
    while time.time() < end:
        r = c.get(f"/v1/projects/{pid}/runs/{rid}", headers=_h(t)).json()
        if r["status"] in ("succeeded", "failed", "cancelled"):
            return r
        time.sleep(0.1)
    raise AssertionError(f"run {rid} did not finish")


def test_stress_200_via_job_api_matches_golden(monkeypatch):
    c, t = _client(monkeypatch, "inline"), uuid.uuid4()
    pid = _project(c, t)
    payload = pack_to_optimize_payload(load_enterprise_pack("stress-200-demand.enterprise.json"))
    r = c.post(f"/v1/projects/{pid}/runs", json={"kind": "optimize", "payload": payload}, headers=_h(t))
    assert r.status_code == 202 and r.json()["status"] == "queued"
    assert len(r.json()["inputHash"]) == 64 and "flowform-engine" in r.json()["engineVersion"]
    done = _wait(c, t, pid, r.json()["id"])
    assert done["status"] == "succeeded", done
    golden = json.load(open(os.path.join(GOLDEN_DIR, "G-M200.json")))
    assert abs(done["result"]["objectiveBreakdown"]["totalM"] - golden["objectiveBreakdown"]["totalM"]) <= 1.5e-4
    assert c.get(f"/v1/projects/{pid}/runs", headers=_h(t)).json()["runs"][0]["id"] == done["id"]


def test_multi_period_and_stochastic_kinds(monkeypatch):
    c, t = _client(monkeypatch, "inline"), uuid.uuid4()
    pid = _project(c, t)
    p = sample_payload()
    p["scenarioTree"] = {"objective": "expected", "scenarios": SHOCKS}
    rid = c.post(f"/v1/projects/{pid}/runs", json={"kind": "stochastic", "payload": p}, headers=_h(t)).json()["id"]
    assert _wait(c, t, pid, rid)["result"]["ok"] is True
    r = c.post(f"/v1/projects/{pid}/runs", json={"kind": "optimize", "payload": {"bad": True}}, headers=_h(t))
    assert r.status_code == 422  # same request validation as the sync endpoint


def test_job_and_sync_endpoint_give_identical_results(monkeypatch):
    c, t = _client(monkeypatch, "inline"), uuid.uuid4()
    pid = _project(c, t)
    from .test_defect_fixes import _roadmap_payload

    for kind, path, body in (
        ("optimize", "/optimize", {**sample_payload(), "explain": True}),
        ("multi-period", "/optimize/multi-period", _roadmap_payload("choose_timing")),
        ("stochastic", "/optimize/stochastic", {**sample_payload(), "scenarioTree": {"objective": "minimax", "scenarios": SHOCKS}}),
    ):
        sync = c.post(path, json=body).json()
        rid = c.post(f"/v1/projects/{pid}/runs", json={"kind": kind, "payload": body}, headers=_h(t)).json()["id"]
        job = _wait(c, t, pid, rid)["result"]
        for k in ("solveSeconds", "log", "explain", "timing", "elapsedSeconds"):
            sync.pop(k, None), job.pop(k, None)
        key = {"optimize": "objectiveBreakdown", "multi-period": "npv", "stochastic": "expectedCostM"}[kind]
        assert job[key] == sync[key], kind


def test_five_parallel_runs_complete(monkeypatch):
    c, t = _client(monkeypatch, "inline"), uuid.uuid4()
    pid = _project(c, t)
    ids = [c.post(f"/v1/projects/{pid}/runs", json={"payload": sample_payload()}, headers=_h(t)).json()["id"] for _ in range(5)]
    totals = {_wait(c, t, pid, i)["result"]["objectiveBreakdown"]["totalM"] for i in ids}
    assert totals == {98.2706}


def test_cancel_is_immediate_and_never_overwritten(monkeypatch):
    c, t = _client(monkeypatch, "manual"), uuid.uuid4()
    pid = _project(c, t)
    rid = c.post(f"/v1/projects/{pid}/runs", json={"payload": sample_payload()}, headers=_h(t)).json()["id"]
    t0 = time.perf_counter()
    r = c.post(f"/v1/projects/{pid}/runs/{rid}/cancel", headers=_h(t)).json()
    assert r["status"] == "cancelled" and time.perf_counter() - t0 < 5
    assert q.get_queue().drain() == ["cancelled"]  # worker picks it up late: no result written
    got = c.get(f"/v1/projects/{pid}/runs/{rid}", headers=_h(t)).json()
    assert got["status"] == "cancelled" and got["result"] is None


def test_sse_progress_stream(monkeypatch):
    c, t = _client(monkeypatch, "manual"), uuid.uuid4()
    pid = _project(c, t)
    rid = c.post(f"/v1/projects/{pid}/runs", json={"payload": sample_payload()}, headers=_h(t)).json()["id"]
    q.get_queue().drain()
    with c.stream("GET", f"/v1/projects/{pid}/runs/{rid}/events", headers=_h(t)) as s:
        body = "".join(s.iter_text())
    assert "event: status" in body and '"succeeded"' in body and body.rstrip().endswith("data: {}")


def test_runs_are_tenant_scoped(monkeypatch):
    c, a, b = _client(monkeypatch, "manual"), uuid.uuid4(), uuid.uuid4()
    pid = _project(c, a)
    rid = c.post(f"/v1/projects/{pid}/runs", json={"payload": sample_payload()}, headers=_h(a)).json()["id"]
    assert c.post(f"/v1/projects/{pid}/runs", json={"payload": sample_payload()}, headers=_h(b)).status_code == 404
    assert c.get(f"/v1/projects/{pid}/runs/{rid}", headers=_h(b)).status_code == 404
    assert c.post(f"/v1/projects/{pid}/runs/{rid}/cancel", headers=_h(b)).status_code == 404
    assert c.get(f"/v1/projects/{pid}/runs/{rid}/events", headers=_h(b)).status_code == 404


@pytest.mark.skipif(not os.environ.get("REDIS_URL"), reason="REDIS_URL not set")
def test_arq_backend_end_to_end(monkeypatch):
    from arq.worker import Worker

    from app.jobs.worker import WorkerSettings

    c, t = _client(monkeypatch, "arq"), uuid.uuid4()
    pid = _project(c, t)
    rid = c.post(f"/v1/projects/{pid}/runs", json={"payload": sample_payload()}, headers=_h(t)).json()["id"]

    async def burst():
        w = Worker(functions=WorkerSettings.functions, redis_settings=WorkerSettings.redis_settings,
                   burst=True, poll_delay=0.1, allow_abort_jobs=True)
        await w.main()
        await w.close()

    asyncio.run(burst())
    done = _wait(c, t, pid, rid, timeout=30)
    assert done["status"] == "succeeded" and done["result"]["objectiveBreakdown"]["totalM"] == 98.2706
