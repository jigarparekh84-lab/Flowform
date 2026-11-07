"""CR-005: per-tenant project quota, snapshot retention and the storage cap.

Needs Postgres/PostGIS: ``docker compose up -d db`` and
``DATABASE_URL=postgresql+psycopg://flowform:flowform@127.0.0.1:5433/flowform``.
Skipped when DATABASE_URL is unset (CI sets it with a PostGIS service).
"""

from __future__ import annotations

import os
import uuid
from pathlib import Path

import pytest

if not os.environ.get("DATABASE_URL"):
    pytest.skip("DATABASE_URL not set (Postgres tests)", allow_module_level=True)

from alembic import command  # noqa: E402
from alembic.config import Config  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import func, select  # noqa: E402

from app.db.models import ProjectVersion  # noqa: E402
from app.db.session import tenant_session  # noqa: E402
from app.main import app  # noqa: E402

API_DIR = Path(__file__).resolve().parents[1]


@pytest.fixture(scope="module", autouse=True)
def _migrated():
    cfg = Config(str(API_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(API_DIR / "alembic"))
    command.upgrade(cfg, "head")


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setenv("AUTH_MODE", "dev")
    return TestClient(app)


def _h(tenant: uuid.UUID) -> dict[str, str]:
    return {"X-Dev-Tenant": str(tenant), "Content-Type": "application/json"}


def _versions(tenant: uuid.UUID, project_id: str) -> list[int]:
    with tenant_session(tenant) as s:
        rows = s.execute(
            select(ProjectVersion.version)
            .where(ProjectVersion.project_id == uuid.UUID(project_id))
            .order_by(ProjectVersion.version)
        ).scalars()
        return list(rows)


def _bytes(tenant: uuid.UUID) -> int:
    with tenant_session(tenant) as s:
        return int(
            s.execute(
                select(func.coalesce(func.sum(func.length(ProjectVersion.snapshot_raw)), 0))
            ).scalar()
            or 0
        )


def test_project_quota_refuses_the_next_create_without_storing_it(client, monkeypatch):
    monkeypatch.setenv("MAX_PROJECTS_PER_TENANT", "2")
    t = uuid.uuid4()
    first = client.post("/v1/projects", content=b'{"name": "One"}', headers=_h(t))
    second = client.post("/v1/projects", content=b'{"name": "Two"}', headers=_h(t))
    assert (first.status_code, second.status_code) == (201, 201)

    refused = client.post("/v1/projects", content=b'{"name": "Three"}', headers=_h(t))
    assert refused.status_code == 403, refused.text
    assert refused.headers["x-quota-limit"] == "projects"
    assert "MAX_PROJECTS_PER_TENANT" in refused.json()["detail"]
    # The refusal rolled back: nothing was created and the message is actionable.
    assert [p["name"] for p in client.get("/v1/projects", headers=_h(t)).json()["projects"]] == [
        "Two",
        "One",
    ]

    # Deleting a project frees a slot.
    assert client.delete(f"/v1/projects/{first.json()['id']}", headers=_h(t)).status_code == 204
    assert client.post("/v1/projects", content=b'{"name": "Three"}', headers=_h(t)).status_code == 201


def test_retention_keeps_the_newest_versions_and_prunes_the_rest(client, monkeypatch):
    monkeypatch.setenv("MAX_VERSIONS_PER_PROJECT", "3")
    t = uuid.uuid4()
    pid = client.post("/v1/projects", content=b'{"name": "R v1"}', headers=_h(t)).json()["id"]
    for n in range(2, 7):
        saved = client.put(
            f"/v1/projects/{pid}", content=f'{{"name": "R v{n}"}}'.encode(), headers=_h(t)
        )
        assert saved.status_code == 200, saved.text
        assert saved.json()["version"] == n

    assert _versions(t, pid) == [4, 5, 6]
    # Pruned history is gone, not hidden behind an error: the version simply 404s.
    assert client.get(f"/v1/projects/{pid}/snapshot?version=3", headers=_h(t)).status_code == 404
    assert client.get(f"/v1/projects/{pid}/snapshot?version=4", headers=_h(t)).json()["name"] == "R v4"
    assert client.get(f"/v1/projects/{pid}/snapshot", headers=_h(t)).json()["name"] == "R v6"
    # The current version is never pruned, and versioning keeps advancing.
    assert client.get(f"/v1/projects/{pid}", headers=_h(t)).json()["version"] == 6


def test_storage_cap_rejects_the_write_that_would_cross_it(client, monkeypatch):
    body = b'{"name": "S", "state": {"blob": "' + b"x" * 300 + b'"}}'
    # Two snapshots fit, a third does not.
    monkeypatch.setenv("MAX_TENANT_STORAGE_BYTES", str(len(body) * 2 + 10))
    t = uuid.uuid4()
    pid = client.post("/v1/projects", content=body, headers=_h(t)).json()["id"]
    assert client.put(f"/v1/projects/{pid}", content=body, headers=_h(t)).status_code == 200

    refused = client.put(f"/v1/projects/{pid}", content=body, headers=_h(t))
    assert refused.status_code == 403, refused.text
    assert refused.headers["x-quota-limit"] == "storage"
    assert "MAX_TENANT_STORAGE_BYTES" in refused.json()["detail"]

    # The whole write rolled back: no version bump, no orphan row, no bytes.
    assert client.get(f"/v1/projects/{pid}", headers=_h(t)).json()["version"] == 2
    assert _versions(t, pid) == [1, 2]
    assert _bytes(t) == len(body) * 2


def test_retention_runs_before_the_storage_check(client, monkeypatch):
    """A save that also compacts history must not be refused for being too big."""
    body = b'{"name": "P", "state": {"blob": "' + b"y" * 900 + b'"}}'
    monkeypatch.setenv("MAX_VERSIONS_PER_PROJECT", "2")
    # Room for exactly two snapshots, so an unbounded history would trip the cap.
    monkeypatch.setenv("MAX_TENANT_STORAGE_BYTES", str(len(body) * 2))
    t = uuid.uuid4()
    pid = client.post("/v1/projects", content=body, headers=_h(t)).json()["id"]
    for n in range(2, 5):
        saved = client.put(f"/v1/projects/{pid}", content=body, headers=_h(t))
        assert saved.status_code == 200, saved.text
        assert saved.json()["version"] == n
        assert _versions(t, pid) == list(range(max(1, n - 1), n + 1))
    assert _bytes(t) == len(body) * 2
