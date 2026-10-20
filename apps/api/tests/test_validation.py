"""FF-108: pre-run guardrails."""

from __future__ import annotations

import copy

from fastapi.testclient import TestClient

from app.main import app
from app.solver import solve_optimize
from flowform_engine import validate_optimize

from .enterprise_payload import load_enterprise_pack, pack_to_optimize_payload
from .test_demo_cost_scaling import sample_payload

client = TestClient(app)


def codes(r):
    return {i["code"] for i in r["issues"]}


def test_sample_and_stress_pass_cleanly():
    for p in (sample_payload(), pack_to_optimize_payload(load_enterprise_pack("stress-200-demand.enterprise.json"))):
        r = validate_optimize(p)
        assert r["ok"] and not r["blocking"], r["issues"]


def test_validation_does_not_change_results():
    p = sample_payload()
    before = solve_optimize(copy.deepcopy(p))["objectiveBreakdown"]["totalM"]
    validate_optimize(p, deep=True)
    assert solve_optimize(p)["objectiveBreakdown"]["totalM"] == before == 98.2706


def test_blocking_static_errors():
    p = sample_payload()
    p["network"]["demandVolume"]["n4"] = -5
    p["network"]["lanes"].append({"id": "lx", "from": "n1", "to": "ghost", "costPerUnit": 1})
    p["constraints"]["facilities"][0]["capacityMin"] = 10**9
    r = validate_optimize(p)
    assert r["blocking"]
    assert {"NEGATIVE_VALUE", "UNKNOWN_LANE_ENDPOINT", "MIN_ABOVE_MAX_CAPACITY"} <= codes(r)
    assert r["issues"][0]["level"] == "error" and all(i["fix"] is not None or i["level"] for i in r["issues"])


def test_no_demand_no_facilities():
    r = validate_optimize({"network": {"nodes": [], "lanes": [], "demandVolume": {}}, "constraints": {}})
    assert {"NO_DEMAND", "NO_FACILITIES"} <= codes(r) and r["blocking"]
    assert validate_optimize({})["issues"][0]["code"] == "NO_NETWORK"


def test_unreachable_customer_and_unit_sanity():
    p = sample_payload()
    for n in p["network"]["nodes"]:
        if n["id"] == "n6":
            n.pop("lat", None), n.pop("lng", None)
    p["network"]["lanes"] = [l for l in p["network"]["lanes"] if l["to"] != "n6"]
    p["network"]["demandVolume"]["n5"] = 5e8
    r = validate_optimize(p)
    assert "UNREACHABLE_CUSTOMER" in codes(r) and "UNIT_SANITY" in codes(r)


def test_lane_capacity_shortfall_table():
    p = sample_payload()
    for l in p["network"]["lanes"]:
        if l["to"] == "n6":
            l["capacityUnits"] = 1000
    r = validate_optimize(p)
    row = r["shortfalls"]["laneCapacity"][0]
    assert row["customerId"] == "n6" and row["shortBy"] > 0


def test_deep_reports_engine_root_causes_with_shortfalls():
    p = sample_payload()
    for l in p["network"]["lanes"]:
        if l["id"] == "l9":
            l["capacityUnits"] = 1000
    r = validate_optimize(p, deep=True)
    assert r["blocking"] and r["deep"]["status"] == "Infeasible"
    assert {"MIN_THROUGHPUT_CONFLICT", "LANE_CAPACITY_CONFLICT"} <= codes(r)
    assert r["shortfalls"]["minThroughput"][0] == {"facilityId": "n2", "capacityMin": 10800.0, "feasibleThroughput": 10200.0, "gap": 600.0}
    assert any(s.get("laneId") == "l9" and s["shortBy"] == 1280.0 for s in r["shortfalls"]["laneCapacity"])


def test_validate_endpoint():
    p = sample_payload()
    r = client.post("/optimize/validate", json=p)
    assert r.status_code == 200 and r.json()["ok"] is True
