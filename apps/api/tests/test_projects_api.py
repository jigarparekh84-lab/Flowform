"""FF-104: projects CRUD, snapshot round-trip and tenant isolation (API + RLS).

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
from sqlalchemy import select, text  # noqa: E402
from sqlalchemy.exc import DBAPIError  # noqa: E402

from app.db.models import Project  # noqa: E402
from app.db.session import tenant_session  # noqa: E402
from app.main import app  # noqa: E402

from .test_demo_cost_scaling import SAMPLE_PROJECT  # noqa: E402

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


def test_v1_requires_auth_when_not_dev(monkeypatch):
    monkeypatch.setenv("AUTH_MODE", "off")
    assert TestClient(app).get("/v1/projects").status_code == 401


def test_crud_and_versioning(client):
    t = uuid.uuid4()
    r = client.post("/v1/projects", content=b'{"name": "Alpha", "state": {}}', headers=_h(t))
    assert r.status_code == 201, r.text
    pid = r.json()["id"]
    assert r.json()["version"] == 1 and r.json()["name"] == "Alpha"
    assert [p["id"] for p in client.get("/v1/projects", headers=_h(t)).json()["projects"]] == [pid]

    r = client.put(f"/v1/projects/{pid}", content=b'{"name": "Alpha v2", "state": {"x": 1}}', headers=_h(t))
    assert r.json()["version"] == 2 and r.json()["name"] == "Alpha v2"
    assert client.get(f"/v1/projects/{pid}/snapshot", headers=_h(t)).json() == {"name": "Alpha v2", "state": {"x": 1}}
    assert client.get(f"/v1/projects/{pid}/snapshot?version=1", headers=_h(t)).json()["name"] == "Alpha"

    assert client.post("/v1/projects", content=b"[1,2]", headers=_h(t)).status_code == 422
    # web export format names the project from meta.name (FF-107)
    r = client.post("/v1/projects", content=b'{"format": "flowform-project", "meta": {"name": "From web"}, "state": {}}', headers=_h(t))
    assert r.json()["name"] == "From web"
    assert client.delete(f"/v1/projects/{pid}", headers=_h(t)).status_code == 204
    assert client.get(f"/v1/projects/{pid}", headers=_h(t)).status_code == 404


def test_sample_flowform_json_round_trips_byte_equal(client):
    t = uuid.uuid4()
    raw = SAMPLE_PROJECT.read_bytes()
    pid = client.post("/v1/projects", content=raw, headers=_h(t)).json()["id"]
    got = client.get(f"/v1/projects/{pid}/snapshot", headers=_h(t))
    assert got.status_code == 200 and got.content == raw


def test_cross_tenant_api_access_is_404(client):
    a, b = uuid.uuid4(), uuid.uuid4()
    pid = client.post("/v1/projects", content=b'{"name": "A only"}', headers=_h(a)).json()["id"]
    assert client.get(f"/v1/projects/{pid}", headers=_h(b)).status_code == 404
    assert client.get(f"/v1/projects/{pid}/snapshot", headers=_h(b)).status_code == 404
    assert client.put(f"/v1/projects/{pid}", content=b"{}", headers=_h(b)).status_code == 404
    assert client.delete(f"/v1/projects/{pid}", headers=_h(b)).status_code == 404
    assert client.get("/v1/projects", headers=_h(b)).json()["projects"] == []


def test_rls_denies_cross_tenant_reads_even_without_app_filter(client):
    a, b = uuid.uuid4(), uuid.uuid4()
    client.post("/v1/projects", content=b'{"name": "secret"}', headers=_h(a))
    client.get("/v1/projects", headers=_h(b))  # provision tenant b
    with tenant_session(b) as s:
        # Deliberately unfiltered: RLS must hide tenant a's rows.
        assert s.execute(select(Project)).scalars().all() == []
        assert s.execute(text("SELECT count(*) FROM project_versions")).scalar() == 0
    with tenant_session(a) as s:
        assert [p.name for p in s.execute(select(Project)).scalars()] == ["secret"]


def test_rls_rejects_writes_into_another_tenant(client):
    a, b = uuid.uuid4(), uuid.uuid4()
    client.get("/v1/projects", headers=_h(a))
    client.get("/v1/projects", headers=_h(b))
    with pytest.raises(DBAPIError):
        with tenant_session(b) as s:
            s.add(Project(tenant_id=a, name="smuggled"))
            s.flush()
