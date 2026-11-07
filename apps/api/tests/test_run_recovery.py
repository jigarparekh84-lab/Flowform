"""CR-004: run leases, idempotent dispatch and crash recovery.

Covers the three failure modes that used to leave a run stuck forever:
duplicate queue delivery, a worker that dies mid-solve, and a queue message
that is lost after the row is committed.

Needs Postgres: ``docker compose up -d db`` and ``DATABASE_URL`` set; skipped
otherwise (the CI job sets it).
"""

from __future__ import annotations

import os
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import pytest

if not os.environ.get("DATABASE_URL"):
    pytest.skip("DATABASE_URL not set (Postgres tests)", allow_module_level=True)

from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import func, select  # noqa: E402

from app.db.models import AuditEvent, Run  # noqa: E402
from app.db.session import tenant_session  # noqa: E402
from app.jobs import queue as q  # noqa: E402
from app.jobs import runner  # noqa: E402
from app.jobs.reaper import reap_once  # noqa: E402
from app.main import app  # noqa: E402

from .test_demo_cost_scaling import sample_payload  # noqa: E402
from .test_projects_api import _h, _migrated  # noqa: E402,F401

#: Queued rows from other suites are old enough to be re-dispatched by a real
#: sweep; tests that should not touch them pass a huge queued threshold.
NO_ORPHANS = 100_000.0


@pytest.fixture(autouse=True)
def _reset_queue():
    yield
    q.get_queue.cache_clear()


def _client(monkeypatch) -> TestClient:
    monkeypatch.setenv("AUTH_MODE", "dev")
    monkeypatch.setenv("QUEUE_BACKEND", "manual")
    q.get_queue.cache_clear()
    return TestClient(app)


def _new_run(c: TestClient, t: uuid.UUID) -> tuple[str, str]:
    pid = c.post("/v1/projects", content=b'{"name": "recovery"}', headers=_h(t)).json()["id"]
    r = c.post(f"/v1/projects/{pid}/runs", json={"payload": sample_payload()}, headers=_h(t))
    assert r.status_code == 202, r.text
    return pid, r.json()["id"]


def _stale(t: uuid.UUID, rid: str, *, attempts: int = 1, age_s: float = 3600) -> None:
    """Make the row look like a worker claimed it and then died."""
    now = datetime.now(timezone.utc)
    with tenant_session(t) as s:
        r = s.get(Run, uuid.UUID(rid))
        r.status, r.attempts, r.progress = "running", attempts, 0.1
        r.started_at = now - timedelta(seconds=age_s)
        r.heartbeat_at = now - timedelta(seconds=age_s)


def _old_dispatch(t: uuid.UUID, rid: str, age_s: float = 3600) -> None:
    with tenant_session(t) as s:
        s.get(Run, uuid.UUID(rid)).dispatched_at = datetime.now(timezone.utc) - timedelta(
            seconds=age_s
        )


def _row(t: uuid.UUID, rid: str) -> dict:
    with tenant_session(t) as s:
        r = s.get(Run, uuid.UUID(rid))
        return {
            "status": r.status,
            "attempts": r.attempts,
            "message": r.message,
            "result": r.result,
            "finished_at": r.finished_at,
        }


def _audit(t: uuid.UUID, action: str) -> int:
    with tenant_session(t) as s:
        return s.execute(
            select(func.count()).select_from(AuditEvent).where(AuditEvent.action == action)
        ).scalar_one()


def test_duplicate_delivery_solves_once(monkeypatch):
    c, t = _client(monkeypatch), uuid.uuid4()
    _, rid = _new_run(c, t)

    assert runner.execute_run(uuid.UUID(rid), t) == "succeeded"
    # The manual queue still holds the original message: replaying it must not
    # re-solve or bump the attempt counter.
    assert q.get_queue().drain() == ["succeeded"]
    assert runner.execute_run(uuid.UUID(rid), t) == "succeeded"

    row = _row(t, rid)
    assert row["status"] == "succeeded" and row["attempts"] == 1
    assert row["result"]["objectiveBreakdown"]["totalM"] == 98.2706


def test_concurrent_delivery_is_claimed_by_one_worker(monkeypatch):
    c, t = _client(monkeypatch), uuid.uuid4()
    _, rid = _new_run(c, t)

    solves: list[int] = []
    lock = threading.Lock()

    def slow(_payload):
        with lock:
            solves.append(1)
        time.sleep(0.2)
        return {"status": "ok", "objectiveBreakdown": {"totalM": 1.0}}

    monkeypatch.setitem(runner.KINDS, "optimize", slow)
    barrier = threading.Barrier(2)

    def deliver() -> str:
        barrier.wait()
        return runner.execute_run(uuid.UUID(rid), t)

    with ThreadPoolExecutor(max_workers=2) as pool:
        statuses = [f.result() for f in [pool.submit(deliver) for _ in range(2)]]

    assert len(solves) == 1, statuses
    assert "succeeded" in statuses
    assert _row(t, rid)["attempts"] == 1


def test_reaper_requeues_an_interrupted_run_and_the_retry_completes(monkeypatch):
    c, t = _client(monkeypatch), uuid.uuid4()
    _, rid = _new_run(c, t)
    q.get_queue().jobs.clear()  # the original dispatch is gone with the worker
    _stale(t, rid, attempts=1)

    result = reap_once(stale_after_s=60, queued_after_s=NO_ORPHANS, max_attempts=2)

    assert rid in result.requeued
    assert _row(t, rid)["status"] == "queued"
    assert _audit(t, "run.requeue") >= 1
    # The sweep is global, so drain only this tenant's job: other suites leave
    # recoverable rows behind on purpose.
    mine = [job for job in q.get_queue().jobs if job[0] == uuid.UUID(rid)]
    assert len(mine) == 1
    assert [runner.execute_run(*mine[0])] == ["succeeded"]
    row = _row(t, rid)
    assert row["status"] == "succeeded" and row["attempts"] == 2
    assert row["result"]["objectiveBreakdown"]["totalM"] == 98.2706


def test_reaper_fails_a_stale_run_at_the_retry_limit(monkeypatch):
    c, t = _client(monkeypatch), uuid.uuid4()
    _, rid = _new_run(c, t)
    q.get_queue().jobs.clear()
    _stale(t, rid, attempts=2)

    result = reap_once(stale_after_s=60, queued_after_s=NO_ORPHANS, max_attempts=2)

    assert rid in result.failed
    row = _row(t, rid)
    assert row["status"] == "failed"
    assert "interrupted" in (row["message"] or "").lower()
    assert row["finished_at"] is not None
    assert _audit(t, "run.interrupted") >= 1


def test_late_result_from_a_reclaimed_worker_is_discarded(monkeypatch):
    """A partitioned worker must not overwrite the attempt that replaced it."""
    c, t = _client(monkeypatch), uuid.uuid4()
    _, rid = _new_run(c, t)
    q.get_queue().jobs.clear()
    _stale(t, rid, attempts=1)
    reap_once(stale_after_s=60, queued_after_s=NO_ORPHANS, max_attempts=2)

    run_uuid = uuid.UUID(rid)
    assert runner.claim(t, run_uuid) == 2
    now = datetime.now(timezone.utc)
    assert (
        runner.finish(
            t,
            run_uuid,
            1,  # the dead worker's attempt
            status="succeeded",
            progress=1.0,
            message="stale",
            result={"objectiveBreakdown": {"totalM": -1}},
            finished_at=now,
        )
        is None
    )
    row = _row(t, rid)
    assert row["status"] == "running" and row["result"] is None and row["attempts"] == 2


def test_heartbeat_and_finish_stop_after_cancel(monkeypatch):
    c, t = _client(monkeypatch), uuid.uuid4()
    pid, rid = _new_run(c, t)
    run_uuid = uuid.UUID(rid)

    assert runner.claim(t, run_uuid) == 1
    assert runner.heartbeat(t, run_uuid, 1) is True
    assert c.post(f"/v1/projects/{pid}/runs/{rid}/cancel", headers=_h(t)).json()["status"] == "cancelled"
    assert runner.heartbeat(t, run_uuid, 1) is False
    assert (
        runner.finish(
            t,
            run_uuid,
            1,
            status="succeeded",
            progress=1.0,
            result={"objectiveBreakdown": {"totalM": 1}},
            finished_at=datetime.now(timezone.utc),
        )
        is None
    )
    row = _row(t, rid)
    assert row["status"] == "cancelled" and row["result"] is None


def test_reaper_redispatches_a_lost_queue_message(monkeypatch):
    c, t = _client(monkeypatch), uuid.uuid4()
    _, rid = _new_run(c, t)
    q.get_queue().jobs.clear()  # the row committed but the dispatch vanished
    _old_dispatch(t, rid)

    result = reap_once(stale_after_s=60, queued_after_s=1, max_attempts=2)

    assert rid in result.redispatched
    assert _row(t, rid)["status"] == "queued"
    assert _audit(t, "run.dispatch_retry") >= 1
    assert any(job[0] == uuid.UUID(rid) for job in q.get_queue().jobs)


def test_reaper_leaves_a_live_run_alone(monkeypatch):
    c, t = _client(monkeypatch), uuid.uuid4()
    _, rid = _new_run(c, t)
    q.get_queue().jobs.clear()
    _stale(t, rid, attempts=1, age_s=0)  # heartbeat just refreshed

    result = reap_once(stale_after_s=60, queued_after_s=NO_ORPHANS, max_attempts=2)

    assert rid not in result.requeued and rid not in result.failed
    assert _row(t, rid)["status"] == "running"


def test_a_second_sweep_does_not_repeat_its_work(monkeypatch):
    c, t = _client(monkeypatch), uuid.uuid4()
    _, rid = _new_run(c, t)
    q.get_queue().jobs.clear()
    _stale(t, rid, attempts=1)

    first = reap_once(stale_after_s=60, queued_after_s=NO_ORPHANS, max_attempts=2)
    second = reap_once(stale_after_s=60, queued_after_s=NO_ORPHANS, max_attempts=2)

    assert rid in first.requeued
    assert rid not in second.requeued and rid not in second.redispatched
    assert [job[0] for job in q.get_queue().jobs].count(uuid.UUID(rid)) == 1


def test_run_payload_exposes_the_lease(monkeypatch):
    c, t = _client(monkeypatch), uuid.uuid4()
    pid, rid = _new_run(c, t)

    body = c.get(f"/v1/projects/{pid}/runs/{rid}", headers=_h(t)).json()
    assert body["attempts"] == 0
    assert body["dispatchedAt"] is not None
    assert body["startedAt"] is None and body["heartbeatAt"] is None
