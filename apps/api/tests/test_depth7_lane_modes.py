"""Depth slice 7: lane capacity + transport mode choice inside the MIP."""

from __future__ import annotations

import copy

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.solver import solve_optimize

from .enterprise_payload import load_enterprise_pack, pack_to_optimize_payload

client = TestClient(app)

TRUCK = {"mode": "truck", "costPerUnit": 2.0, "leadDays": 2, "co2KgPerUnit": 30}
RAIL = {"mode": "rail", "costPerUnit": 1.0, "leadDays": 5, "co2KgPerUnit": 5}


def _net(
    modes: list[dict] | None,
    *,
    lane_cap: float | None = None,
    hard: bool = False,
    max_lead: float | None = None,
    backup_dc: bool = True,
    demand: float = 1000.0,
    extra_constraints: dict | None = None,
) -> dict:
    """dc1 → c1 multi-mode lane; optional dc2 → c1 expensive truck backup."""
    lane: dict = {"id": "L1", "from": "dc1", "to": "c1"}
    if modes is not None:
        lane["modes"] = copy.deepcopy(modes)
    else:
        lane.update({"mode": "Truck", "costPerUnit": 2.0, "leadDays": 2})
    if lane_cap is not None:
        lane["capacity"] = lane_cap
    nodes = [
        {"id": "dc1", "name": "DC1", "kind": "dc", "lat": 33.0, "lng": -97.0, "capacity": "5k"},
        {"id": "dc2", "name": "DC2", "kind": "dc", "lat": 34.0, "lng": -97.0, "capacity": "5k"},
        {"id": "c1", "name": "C1", "kind": "demand", "lat": 33.5, "lng": -97.2, "capacity": "1k"},
    ]
    lanes = [
        lane,
        {"id": "L2", "from": "dc2", "to": "c1", "mode": "Truck", "costPerUnit": 4.0, "leadDays": 1},
    ]
    facilities = [
        {"nodeId": "dc1", "status": "open", "capacityMax": 5000, "fixedCapexM": 0, "fixedOpexM": 0.5},
        {"nodeId": "dc2", "status": "open", "capacityMax": 5000, "fixedCapexM": 0, "fixedOpexM": 0.5},
    ]
    if not backup_dc:
        nodes = [nodes[0], nodes[2]]
        lanes = lanes[:1]
        facilities = facilities[:1]
    constraints: dict = {
        "serviceRadiusMiles": 300,
        "capexBudgetM": 10,
        "maxFacilities": 2,
        "hardServiceConstraints": hard,
        "facilities": facilities,
    }
    if max_lead is not None:
        constraints["maxLeadTimeDays"] = max_lead
    constraints.update(extra_constraints or {})
    return {
        "network": {"nodes": nodes, "lanes": lanes, "demandVolume": {"c1": demand}},
        "constraints": constraints,
    }


def _vol_by_mode(body: dict, frm: str = "dc1") -> dict[str, float]:
    out: dict[str, float] = {}
    for f in body["flows"]:
        if f["from"] == frm:
            out[f["mode"]] = out.get(f["mode"], 0.0) + f["volume"]
    return out


def test_mode_choice_picks_cheaper_mode_when_feasible():
    body = solve_optimize(_net([TRUCK, RAIL]))
    assert body["ok"] and body["status"] == "Optimal"
    assert _vol_by_mode(body) == {"Rail": 1000.0}
    mix = body["objectiveBreakdown"]["modeMix"]
    assert mix[0]["mode"] == "Rail" and mix[0]["sharePct"] == 100.0
    assert mix[0]["co2Kg"] == pytest.approx(5000.0)
    assert body["objectiveBreakdown"]["transportM"] == pytest.approx(1.0)
    assert body["modeChoice"]["enabled"] is True
    rail_flow = next(f for f in body["flows"] if f["mode"] == "Rail")
    assert rail_flow["laneId"] == "L1" and rail_flow["leadDays"] == 5


def test_mode_capacity_forces_split_with_binding_dual():
    rail = {**RAIL, "capacity": 600}
    body = solve_optimize(_net([TRUCK, rail]))
    assert body["status"] == "Optimal"
    assert _vol_by_mode(body) == {"Rail": 600.0, "Truck": 400.0}
    binding = body["bindingLaneCapacities"]
    assert len(binding) == 1
    row = binding[0]
    assert row["scope"] == "lane-mode" and row["mode"] == "Rail"
    assert row["utilizationPct"] == 100.0
    # One more rail unit displaces truck: saves (2.0 - 1.0) / 1000 $M
    assert row["shadowPrice"] == pytest.approx(-0.001, abs=1e-6)
    assert body["sensitivity"]["laneMethod"] == "lp-dual"
    util = body["laneUtilization"][0]
    assert util["laneId"] == "L1" and util["binding"] is True
    assert {m["mode"] for m in util["modes"]} == {"Rail", "Truck"}


def test_lane_capacity_forces_split_across_lanes():
    rail = {**RAIL, "capacity": 600}
    body = solve_optimize(_net([TRUCK, rail], lane_cap=800))
    assert body["status"] == "Optimal"
    by_mode = _vol_by_mode(body)
    assert by_mode["Rail"] == 600.0 and by_mode["Truck"] == 200.0
    assert _vol_by_mode(body, "dc2") == {"Truck": 200.0}
    lane_row = next(r for r in body["laneCapacity"] if r["scope"] == "lane")
    assert lane_row["binding"] and lane_row["volume"] == 800.0
    # Extra lane unit replaces dc2 truck ($4) with dc1 truck ($2)
    assert lane_row["shadowPrice"] == pytest.approx(-0.002, abs=1e-6)
    assert body["kpis"]["bindingLaneCount"] == 2


def test_hard_service_forces_faster_mode():
    body = solve_optimize(_net([TRUCK, RAIL], hard=True, max_lead=3))
    assert body["status"] == "Optimal"
    assert _vol_by_mode(body) == {"Truck": 1000.0}
    assert body["modeChoice"]["serviceFilteredModes"] >= 1
    assert all(f.get("leadDays", 0) <= 3 for f in body["flows"])


def test_service_plus_capacity_conflict_is_diagnosed():
    truck = {**TRUCK, "capacity": 500}
    body = solve_optimize(
        _net([truck, RAIL], hard=True, max_lead=3, backup_dc=False)
    )
    assert body["ok"] is False and body["status"] == "Infeasible"
    codes = {h["code"] for h in body["infeasibilityReport"]["hints"]}
    assert "LANE_CAPACITY_SHORTFALL" in codes
    assert "MODE_SERVICE_CAPACITY_CONFLICT" in codes
    assert body["infeasibilityReport"]["metrics"]["laneShortfallVolume"] == 500.0
    assert body["laneCapacityShortfalls"]["customers"][0]["customerId"] == "c1"


def test_soft_service_lane_shortfall_reports_uncovered():
    truck = {**TRUCK, "capacity": 500}
    body = solve_optimize(_net([truck, RAIL], max_lead=3, backup_dc=False))
    assert body["ok"] is True
    assert body["kpis"]["uncoveredDemand"] == pytest.approx(500.0)
    assert body["laneCapacityShortfalls"]["customers"][0]["shortfall"] == 500.0
    assert body["bindingLaneCapacities"][0]["mode"] == "Truck"


def test_fixed_lane_mode_charge_can_outweigh_cheaper_rate():
    rail = {**RAIL, "fixedCostM": 5.0}  # rate saving = 1000 u × $0.001M/u = $1M < $5M
    body = solve_optimize(_net([TRUCK, rail]))
    assert _vol_by_mode(body) == {"Truck": 1000.0}
    assert body["objectiveBreakdown"]["laneFixedM"] == 0.0
    cheap = {**RAIL, "fixedCostM": 0.1}
    body2 = solve_optimize(_net([TRUCK, cheap]))
    assert _vol_by_mode(body2) == {"Rail": 1000.0}
    assert body2["objectiveBreakdown"]["laneFixedM"] == pytest.approx(0.1)
    assert body2["modeChoice"]["laneModeBinaries"] == 1


def test_duplicate_lane_rows_with_distinct_modes_become_alternatives():
    payload = _net(None)
    payload["network"]["lanes"].insert(
        1,
        {"id": "L1r", "from": "dc1", "to": "c1", "mode": "Rail",
         "costPerUnit": 1.0, "leadDays": 5, "capacity": 300},
    )
    body = solve_optimize(payload)
    assert _vol_by_mode(body) == {"Rail": 300.0, "Truck": 700.0}
    assert body["modeChoice"]["mergedDuplicateLanes"] == 1


def test_carbon_price_shifts_mode_choice():
    # Truck $2 / 30 kg vs rail-like slow mode $2.5 / 2 kg: carbon $100/t flips it
    green = {"mode": "intermodal", "costPerUnit": 2.5, "leadDays": 3, "co2KgPerUnit": 2}
    base = solve_optimize(_net([TRUCK, green]))
    assert _vol_by_mode(base) == {"Truck": 1000.0}
    priced = solve_optimize(
        _net([TRUCK, green], extra_constraints={"carbonPricePerTonne": 100})
    )
    assert _vol_by_mode(priced) == {"Intermodal": 1000.0}
    assert priced["objectiveBreakdown"]["carbonM"] > 0


def test_backward_compat_no_mode_data_matches_legacy_model():
    """No modes / no lane capacity → identical pre-slice-7 objective + flows."""
    pack = load_enterprise_pack("stress-200-demand.enterprise.json")
    payload = pack_to_optimize_payload(pack)
    for lane in payload["network"]["lanes"]:
        lane.pop("modes", None)
        lane.pop("capacityUnits", None)
    body = solve_optimize(payload)
    assert body["status"] == "Optimal"
    # Anchors recorded from master @ 650098f (pre depth-7)
    assert body["objectiveBreakdown"]["totalM"] == pytest.approx(423.6946, abs=1e-3)
    assert body["objectiveBreakdown"]["transportM"] == pytest.approx(402.4946, abs=1e-3)
    assert len(body["openIds"]) == 11
    assert body["modeChoice"]["enabled"] is False
    assert body["modeChoice"]["laneModeBinaries"] == 0
    assert body["laneCapacity"] == [] and body["bindingLaneCapacities"] == []
    assert not any("modeKey" in f for f in body["flows"])
    assert body["objectiveBreakdown"]["laneFixedM"] == 0.0

    legacy_single = solve_optimize(_net(None))
    assert _vol_by_mode(legacy_single) == {"Truck": 1000.0}
    assert legacy_single["objectiveBreakdown"]["transportM"] == pytest.approx(2.0)
    assert legacy_single["laneCapacity"] == []


def test_enforce_lane_capacity_flag_off_ignores_caps():
    rail = {**RAIL, "capacity": 600}
    body = solve_optimize(
        _net([TRUCK, rail], lane_cap=800, extra_constraints={"enforceLaneCapacity": False})
    )
    assert _vol_by_mode(body) == {"Rail": 1000.0}
    assert body["laneCapacity"] == []


def test_stress_200_mode_mix_and_binding_lanes():
    pack = load_enterprise_pack("stress-200-demand.enterprise.json")
    payload = pack_to_optimize_payload(pack)
    body = solve_optimize(payload)
    assert body["status"] == "Optimal"
    assert body["kpis"]["servicePct"] >= 95
    modes = {m["mode"] for m in body["objectiveBreakdown"]["modeMix"]}
    assert {"Truck", "Rail"} <= modes
    assert body["modeChoice"]["lanesWithModes"] == 24
    assert body["bindingLaneCapacities"], "rail caps should bind on plant→DC lanes"
    assert all(
        r["shadowPrice"] is None or r["shadowPrice"] <= 1e-9
        for r in body["bindingLaneCapacities"]
    )
    assert body["solveSeconds"] <= 60


def test_api_endpoint_returns_lane_fields():
    rail = {**RAIL, "capacity": 600}
    res = client.post("/optimize", json=_net([TRUCK, rail]))
    assert res.status_code == 200
    body = res.json()
    for key in ("laneFlows", "laneUtilization", "laneCapacity", "bindingLaneCapacities", "modeChoice"):
        assert key in body
    assert body["objectiveBreakdown"]["modeMix"]
    assert any(f["mode"] == "Rail" for f in body["laneFlows"])
