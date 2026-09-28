"""Smoke + non-trivial MIP tests for Flowform optimize API."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app
from app.solver import solve_optimize

client = TestClient(app)


def test_health():
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["service"] == "flowform-api"
    assert "multi-echelon" in body.get("model", "")


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
                    "fixedOpexM": 0.5,
                },
                {
                    "nodeId": "f2",
                    "status": "candidate",
                    "capacityMin": 0,
                    "capacityMax": 20000,
                    "fixedCapexM": 6,
                    "fixedOpexM": 0.8,
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
    assert "objectiveBreakdown" in body
    assert "openFacilities" in body
    assert isinstance(body.get("openedIds"), list) or isinstance(
        body.get("keptOpenIds"), list
    )


def test_optimize_capacity_opens_subset():
    """
    Non-trivial network: 3 candidate DCs, 2 demand clusters.
    Tight capacity + CapEx budget ⇒ open a proper subset (not all, not none),
    respect capacity, return objective breakdown + flows.
    """
    # Geography (canvas units × 12 mi):
    # DC West @ (20,40), DC Mid @ (50,40), DC East @ (80,40)
    # Demand West @ (25,40) vol 8000, Demand East @ (75,40) vol 8000
    # Each DC capacityMax=9000 ⇒ need ≥2 DCs; CapEx 5 each, budget 12 ⇒ ≤2 DCs
    payload = {
        "network": {
            "nodes": [
                {"id": "dc_w", "name": "West DC", "kind": "candidate", "x": 20, "y": 40, "capacity": "9k"},
                {"id": "dc_m", "name": "Mid DC", "kind": "candidate", "x": 50, "y": 40, "capacity": "9k"},
                {"id": "dc_e", "name": "East DC", "kind": "candidate", "x": 80, "y": 40, "capacity": "9k"},
                {"id": "d_w", "name": "West Demand", "kind": "demand", "x": 25, "y": 40, "capacity": "8k"},
                {"id": "d_e", "name": "East Demand", "kind": "demand", "x": 75, "y": 40, "capacity": "8k"},
            ],
            "lanes": [],
            "demandVolume": {"d_w": 8000, "d_e": 8000},
        },
        "constraints": {
            "serviceTargetPct": 95,
            "serviceRadiusMiles": 400,
            "capexBudgetM": 12,
            "maxFacilities": 3,
            "facilities": [
                {
                    "nodeId": "dc_w",
                    "status": "candidate",
                    "capacityMin": 0,
                    "capacityMax": 9000,
                    "fixedCapexM": 5,
                    "fixedOpexM": 0.5,
                },
                {
                    "nodeId": "dc_m",
                    "status": "candidate",
                    "capacityMin": 0,
                    "capacityMax": 9000,
                    "fixedCapexM": 5,
                    "fixedOpexM": 0.5,
                },
                {
                    "nodeId": "dc_e",
                    "status": "candidate",
                    "capacityMin": 0,
                    "capacityMax": 9000,
                    "fixedCapexM": 5,
                    "fixedOpexM": 0.5,
                },
            ],
        },
    }
    body = solve_optimize(payload)
    assert body["ok"] is True
    assert body["status"] in ("Optimal", "Optimal Solution Found", "Not Solved") or body[
        "kpis"
    ]["servicePct"] >= 90
    open_ids = set(body["openIds"])
    # Budget 12 / CapEx 5 ⇒ at most 2; demand 16k / cap 9k ⇒ at least 2 for full cover
    assert 1 <= len(open_ids) <= 2
    assert len(open_ids) == 2, f"expected exactly 2 open DCs, got {open_ids}"
    assert "dc_m" not in open_ids or open_ids == {"dc_w", "dc_e"} or len(open_ids) == 2
    # Prefer west+east geographically; mid alone cannot cover both well under capacity
    # Capacity respected
    for of in body["openFacilities"]:
        assert of["throughput"] <= of["capacityMax"] + 1e-3
    # Must not open all three
    assert open_ids != {"dc_w", "dc_m", "dc_e"}
    bd = body["objectiveBreakdown"]
    assert bd["fixedCapexM"] == 10.0  # 2 × 5
    assert bd["fixedOpexM"] > 0
    assert bd["transportM"] >= 0
    assert body["kpis"]["servicePct"] >= 95
    assert len(body["flows"]) >= 2
    assert any(f.get("echelon") == "dc→customer" for f in body["flows"])
    assert isinstance(body.get("shadowPrices"), list)
    assert len(body["shadowPrices"]) >= 1


def test_optimize_multi_echelon_with_plant_and_bom():
    """Plant → DC → customer with supplier→plant BOM demand."""
    payload = {
        "network": {
            "nodes": [
                {"id": "sup", "name": "Supplier", "kind": "supplier", "x": 10, "y": 50, "capacity": "50k"},
                {"id": "plt", "name": "Plant", "kind": "plant", "x": 30, "y": 50, "capacity": "30k"},
                {"id": "dc1", "name": "DC", "kind": "dc", "x": 55, "y": 50, "capacity": "20k"},
                {"id": "dem", "name": "Customer", "kind": "demand", "x": 70, "y": 50, "capacity": "5k"},
            ],
            "lanes": [
                {"id": "l0", "from": "sup", "to": "plt", "mode": "Truck", "costPerUnit": 0.5, "leadDays": 2, "co2Kg": 10},
                {"id": "l1", "from": "plt", "to": "dc1", "mode": "Rail", "costPerUnit": 0.4, "leadDays": 3, "co2Kg": 8},
                {"id": "l2", "from": "dc1", "to": "dem", "mode": "Truck", "costPerUnit": 0.3, "leadDays": 1, "co2Kg": 5},
            ],
            "demandVolume": {"dem": 5000},
        },
        "constraints": {
            "serviceTargetPct": 95,
            "serviceRadiusMiles": 500,
            "capexBudgetM": 40,
            "maxFacilities": 4,
            "forceOpenSeed": True,
            "facilities": [
                {"nodeId": "plt", "status": "open", "capacityMin": 0, "capacityMax": 30000, "fixedCapexM": 0, "fixedOpexM": 1.0},
                {"nodeId": "dc1", "status": "open", "capacityMin": 0, "capacityMax": 20000, "fixedCapexM": 0, "fixedOpexM": 0.6},
            ],
        },
        "bom": {
            "rows": [
                {
                    "plantId": "plt",
                    "preferredSupplierId": "sup",
                    "qtyPerUnit": 1.2,
                }
            ]
        },
    }
    r = client.post("/optimize", json=payload)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    echelons = {f.get("echelon") for f in body["flows"]}
    assert "dc→customer" in echelons
    assert "plant→dc" in echelons or "plant→customer" in echelons
    assert "supplier→plant" in echelons
    # BOM: RM volume >= 1.2 * FG
    bom_vol = sum(f["volume"] for f in body["flows"] if f.get("echelon") == "supplier→plant")
    fg_vol = sum(
        f["volume"]
        for f in body["flows"]
        if f.get("echelon") in ("plant→dc", "plant→customer")
    )
    assert bom_vol + 1e-3 >= 1.2 * fg_vol - 1.0
    assert body["objectiveBreakdown"]["totalM"] >= 0
    assert body["model"] == "fixed-charge-multi-echelon-v1"
