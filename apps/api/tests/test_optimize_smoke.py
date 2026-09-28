"""Smoke tests for Flowform optimize API (health + POST /optimize)."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health():
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["service"] == "flowform-api"


def test_optimize_smoke():
    payload = {
        "network": {
            "nodes": [
                {
                    "id": "f1",
                    "name": "DC A",
                    "kind": "dc",
                    "x": 40,
                    "y": 40,
                    "capacity": "10k",
                },
                {
                    "id": "f2",
                    "name": "Cand B",
                    "kind": "candidate",
                    "x": 70,
                    "y": 40,
                    "capacity": "10k",
                },
                {
                    "id": "d1",
                    "name": "Demand",
                    "kind": "demand",
                    "x": 55,
                    "y": 40,
                    "capacity": "5k",
                },
            ],
            "lanes": [],
            "demandVolume": {"d1": 5000},
        },
        "constraints": {
            "serviceTargetPct": 95,
            "serviceRadiusMiles": 250,
            "capexBudgetM": 30,
            "maxFacilities": 4,
            "facilities": [
                {
                    "nodeId": "f1",
                    "status": "open",
                    "capacityMin": 0,
                    "capacityMax": 20000,
                    "fixedCapexM": 0,
                },
                {
                    "nodeId": "f2",
                    "status": "candidate",
                    "capacityMin": 0,
                    "capacityMax": 20000,
                    "fixedCapexM": 6,
                },
            ],
        },
    }
    r = client.post("/optimize", json=payload)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get("ok") is True
    assert "solver" in body
    assert "kpis" in body
    assert "servicePct" in body["kpis"]
    assert isinstance(body.get("openedIds"), list) or isinstance(
        body.get("keptOpenIds"), list
    )
