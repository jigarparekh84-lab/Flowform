"""Depth slice 4: multi-SKU flows + hard service / infeasibility diagnostics."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app
from app.solver import solve_optimize

from .enterprise_payload import load_enterprise_pack, pack_to_optimize_payload

client = TestClient(app)


def _multi_sku_payload(*, hard: bool = False, radius: float = 400.0) -> dict:
    """Two SKUs (ambient + chilled groups), two DCs with capability split."""
    return {
        "enterpriseSchemaVersion": "enterprise-data-v1",
        "network": {
            "nodes": [
                {
                    "id": "dc_amb",
                    "name": "Ambient DC",
                    "kind": "dc",
                    "x": 30,
                    "y": 40,
                    "lat": 33.0,
                    "lng": -97.0,
                    "capacity": "20k",
                },
                {
                    "id": "dc_chl",
                    "name": "Chilled DC",
                    "kind": "candidate",
                    "x": 70,
                    "y": 40,
                    "lat": 33.0,
                    "lng": -84.0,
                    "capacity": "20k",
                },
                {
                    "id": "d_w",
                    "name": "West Cust",
                    "kind": "demand",
                    "x": 35,
                    "y": 40,
                    "lat": 33.1,
                    "lng": -96.5,
                    "capacity": "5k",
                },
                {
                    "id": "d_e",
                    "name": "East Cust",
                    "kind": "demand",
                    "x": 65,
                    "y": 40,
                    "lat": 33.1,
                    "lng": -84.5,
                    "capacity": "5k",
                },
            ],
            "lanes": [],
            "demandVolume": {"d_w": 5000, "d_e": 5000},
            "skus": [
                {"id": "sku-a", "name": "FG A", "code": "A", "groupId": "ambient"},
                {"id": "sku-b", "name": "FG B", "code": "B", "groupId": "chilled"},
            ],
            "productGroups": [
                {"id": "ambient", "name": "Ambient", "code": "AMB"},
                {"id": "chilled", "name": "Chilled", "code": "CHL"},
            ],
            "demandByProduct": [
                {"customerId": "d_w", "productId": "sku-a", "volume": 4000},
                {"customerId": "d_w", "productId": "sku-b", "volume": 1000},
                {"customerId": "d_e", "productId": "sku-a", "volume": 1000},
                {"customerId": "d_e", "productId": "sku-b", "volume": 4000},
            ],
        },
        "constraints": {
            "serviceTargetPct": 95,
            "serviceRadiusMiles": radius,
            "capexBudgetM": 30,
            "maxFacilities": 4,
            "hardServiceConstraints": hard,
            "aggregateProductsByGroup": False,
            "facilities": [
                {
                    "nodeId": "dc_amb",
                    "status": "open",
                    "capacityMin": 0,
                    "capacityMax": 20000,
                    "fixedCapexM": 0,
                    "fixedOpexM": 0.5,
                    "capableProductIds": ["ambient", "sku-a"],
                },
                {
                    "nodeId": "dc_chl",
                    "status": "candidate",
                    "capacityMin": 0,
                    "capacityMax": 20000,
                    "fixedCapexM": 5,
                    "fixedOpexM": 0.6,
                    "capableProductIds": ["chilled", "sku-b"],
                },
            ],
        },
    }


def test_multi_sku_flows_and_breakdown():
    body = solve_optimize(_multi_sku_payload(hard=False, radius=900))
    assert body["ok"] is True
    assert body["status"] in ("Optimal", "Optimal Solution Found")
    assert body.get("commodityMode") in ("sku", "product-group")
    pb = body.get("productBreakdown") or []
    assert len(pb) >= 2
    ids = {r["productId"] for r in pb}
    assert "sku-a" in ids and "sku-b" in ids
    # Flows tagged with productId
    tagged = [f for f in body["flows"] if f.get("productId")]
    assert len(tagged) >= 2
    # Capability: ambient DC should not ship chilled SKU in volume meaningfully
    # (model forbids arcs); chilled demand served from dc_chl when open
    assert "dc_chl" in set(body["openIds"]) or body["kpis"]["servicePct"] < 100
    assert body["kpis"]["servicePct"] >= 90
    assert sum(r["demand"] for r in pb) == 10000


def test_multi_sku_via_http():
    r = client.post("/optimize", json=_multi_sku_payload(radius=900))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    assert len(body.get("productBreakdown") or []) >= 2


def test_hard_service_infeasible_radius_diagnostics():
    """Tiny radius + hard service ⇒ Infeasible with structured conflict hints."""
    payload = _multi_sku_payload(hard=True, radius=5)
    body = solve_optimize(payload)
    assert body["ok"] is False
    assert body["status"] == "Infeasible"
    report = body.get("infeasibilityReport")
    assert report is not None
    assert report.get("summary")
    codes = {h["code"] for h in report.get("hints") or []}
    assert codes & {
        "UNREACHABLE_DEMAND",
        "SERVICE_RADIUS_TOO_TIGHT",
        "HARD_SERVICE_INFEASIBLE",
        "CAPACITY_SHORTFALL",
    }
    assert report.get("method") == "structural-best-effort"
    assert body.get("hardServiceConstraints") is True


def test_hard_service_feasible_when_radius_ok():
    body = solve_optimize(_multi_sku_payload(hard=True, radius=900))
    assert body["ok"] is True
    assert body["status"] in ("Optimal", "Optimal Solution Found")
    assert body["kpis"]["uncoveredDemand"] == 0
    assert body["kpis"]["servicePct"] >= 99.9
    assert body.get("infeasibilityReport") is None


def test_enterprise_pack_multi_sku_stress_slice():
    """Stress pack carries SKU demand into MIP commodity space."""
    pack = load_enterprise_pack("stress-120-demand.enterprise.json")
    payload = pack_to_optimize_payload(pack)
    assert payload["network"].get("demandByProduct")
    assert len(payload["network"]["demandByProduct"]) >= 100
    assert payload["network"].get("skus")
    body = solve_optimize(payload)
    assert body["ok"] is True
    assert body["status"] in ("Optimal", "Optimal Solution Found")
    pb = body.get("productBreakdown") or []
    assert len(pb) >= 2
    assert body["kpis"]["productCount"] >= 2
    assert body["kpis"]["servicePct"] >= 90
