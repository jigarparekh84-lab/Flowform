"""FF-104: scenarios CRUD + runs listing, tenant-scoped. Needs DATABASE_URL."""

from __future__ import annotations

import os
import uuid

import pytest

if not os.environ.get("DATABASE_URL"):
    pytest.skip("DATABASE_URL not set (Postgres tests)", allow_module_level=True)

from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import select  # noqa: E402

from app.db.models import Run, Scenario  # noqa: E402
from app.db.session import tenant_session  # noqa: E402
from app.main import app  # noqa: E402

from .test_projects_api import _h, _migrated  # noqa: E402,F401


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setenv("AUTH_MODE", "dev")
    return TestClient(app)


def _project(client, t) -> str:
    return client.post("/v1/projects", content=b'{"name": "P"}', headers=_h(t)).json()["id"]


def test_scenario_crud(client):
    t = uuid.uuid4()
    pid = _project(client, t)
    r = client.post(f"/v1/projects/{pid}/scenarios", json={"name": "Base", "spec": {"demandScale": 1.0}}, headers=_h(t))
    assert r.status_code == 201, r.text
    sid = r.json()["id"]
    assert [x["name"] for x in client.get(f"/v1/projects/{pid}/scenarios", headers=_h(t)).json()["scenarios"]] == ["Base"]
    r = client.put(f"/v1/projects/{pid}/scenarios/{sid}", json={"name": "Surge", "spec": {"demandScale": 1.25}}, headers=_h(t))
    assert r.json()["spec"] == {"demandScale": 1.25}
    assert client.get(f"/v1/projects/{pid}/scenarios/{sid}", headers=_h(t)).json()["name"] == "Surge"
    assert client.post(f"/v1/projects/{pid}/scenarios", json={"name": ""}, headers=_h(t)).status_code == 422
    assert client.delete(f"/v1/projects/{pid}/scenarios/{sid}", headers=_h(t)).status_code == 204
    assert client.get(f"/v1/projects/{pid}/scenarios/{sid}", headers=_h(t)).status_code == 404


def test_scenarios_and_runs_are_tenant_scoped(client):
    a, b = uuid.uuid4(), uuid.uuid4()
    pid = _project(client, a)
    sid = client.post(f"/v1/projects/{pid}/scenarios", json={"name": "A"}, headers=_h(a)).json()["id"]
    with tenant_session(a) as s:
        s.add(Run(tenant_id=a, project_id=uuid.UUID(pid), kind="optimize", status="succeeded"))
    assert len(client.get(f"/v1/projects/{pid}/runs", headers=_h(a)).json()["runs"]) == 1
    for path in (f"/v1/projects/{pid}/scenarios", f"/v1/projects/{pid}/scenarios/{sid}", f"/v1/projects/{pid}/runs"):
        assert client.get(path, headers=_h(b)).status_code == 404, path
    assert client.post(f"/v1/projects/{pid}/scenarios", json={"name": "x"}, headers=_h(b)).status_code == 404
    client.get("/v1/projects", headers=_h(b))
    with tenant_session(b) as s:  # RLS, no app filter
        assert s.execute(select(Scenario)).scalars().all() == []
        assert s.execute(select(Run)).scalars().all() == []
