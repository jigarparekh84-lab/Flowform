"""Unit weights → tonne-miles → CO2 / carbon cost (one basis everywhere)."""

from __future__ import annotations

import copy

import pytest

from app.solver import (
    DEFAULT_EMISSION_KG_PER_TON_MILE,
    DEFAULT_UNIT_WEIGHT_KG,
    KM_PER_MILE,
    _dist_miles,
    resolve_unit_weights,
    solve_optimize,
    weight_issues,
)

from .enterprise_payload import load_enterprise_pack, pack_to_optimize_payload
from .test_demo_cost_scaling import sample_payload

DC = {"id": "dc", "name": "DC", "kind": "dc", "lat": 41.88, "lng": -87.63, "capacity": "100k"}
CU = {"id": "cu", "name": "Cust", "kind": "demand", "lat": 39.10, "lng": -94.58, "capacity": "1k"}


def _one_lane(weight_sku=None, weight_group=None, default=None, price=0.0, explicit=None):
    mode = {"mode": "Truck", "costPerUnit": 1.0, "leadDays": 2}
    if explicit is not None:
        mode["co2KgPerUnit"] = explicit
    sku = {"id": "s1", "name": "S1", "groupId": "g1"}
    grp = {"id": "g1", "name": "G1"}
    if weight_sku is not None:
        sku["unitWeightKg"] = weight_sku
    if weight_group is not None:
        grp["unitWeightKg"] = weight_group
    cons = {
        "serviceRadiusMiles": 2000, "capexBudgetM": 10, "maxFacilities": 2,
        "facilities": [{"nodeId": "dc", "status": "open", "capacityMax": 100000, "fixedOpexM": 0}],
        "carbonPricePerTonne": price,
    }
    if default is not None:
        cons["defaultUnitWeightKg"] = default
    return {
        "network": {
            "nodes": [DC, CU],
            "lanes": [{"id": "l1", "from": "dc", "to": "cu", "mode": "Truck", "costPerUnit": 1.0,
                       "leadDays": 2, "modes": [mode]}],
            "demandVolume": {"cu": 1000},
            "demandByProduct": [{"customerId": "cu", "productId": "s1", "volume": 1000}],
            "skus": [sku],
            "productGroups": [grp],
        },
        "constraints": cons,
    }


def _expected_kg(weight_kg: float, model_units: float = 1000) -> float:
    miles = _dist_miles(DC, CU)
    return miles * DEFAULT_EMISSION_KG_PER_TON_MILE["truck"] * (weight_kg / 1000) * model_units * 1000


def test_co2_is_tonne_miles_times_factor_using_sku_weight():
    body = solve_optimize(_one_lane(weight_sku=2.5))
    assert body["status"] == "Optimal"
    exp = _expected_kg(2.5)
    assert body["kpis"]["transportCo2Tonnes"] == pytest.approx(exp / 1000, rel=1e-4)
    tm = _dist_miles(DC, CU) * 1000 * 1000 * 2.5 / 1000
    assert body["co2Basis"]["transportTonneMiles"] == pytest.approx(tm, rel=1e-4)
    assert body["kpis"]["transportTonneKm"] == pytest.approx(tm * KM_PER_MILE, rel=1e-4)
    # g CO2 / tonne-km = truck factor (kg/t-mi) converted
    assert body["kpis"]["co2GPerTonneKm"] == pytest.approx(161 / KM_PER_MILE, rel=1e-3)


def test_weight_priority_sku_then_group_then_default_then_builtin():
    assert solve_optimize(_one_lane(weight_sku=3, weight_group=9, default=7))["co2Basis"]["byCommodity"]["s1"] == 3
    assert solve_optimize(_one_lane(weight_group=9, default=7))["co2Basis"]["byCommodity"]["s1"] == 9
    b = solve_optimize(_one_lane(default=7))
    assert b["co2Basis"]["byCommodity"]["s1"] == 7
    assert b["co2Basis"]["missingWeightCommodities"] == ["s1"]
    b = solve_optimize(_one_lane())
    assert b["co2Basis"]["byCommodity"]["s1"] == DEFAULT_UNIT_WEIGHT_KG == 20.0
    assert b["co2Basis"]["defaultSource"] == "built-in default"


def test_carbon_cost_uses_same_tonnes_as_co2():
    body = solve_optimize(_one_lane(weight_sku=2.0, price=100))
    t = body["kpis"]["transportCo2Tonnes"]
    assert body["objectiveBreakdown"]["carbonM"] == pytest.approx(100 * t / 1e6, abs=1e-4)
    # doubling weight doubles both
    b2 = solve_optimize(_one_lane(weight_sku=4.0, price=100))
    assert b2["kpis"]["transportCo2Tonnes"] == pytest.approx(2 * t, rel=1e-6)
    assert b2["objectiveBreakdown"]["carbonM"] == pytest.approx(2 * body["objectiveBreakdown"]["carbonM"], rel=1e-3)


def test_explicit_lane_mode_co2_per_unit_is_weight_independent():
    a = solve_optimize(_one_lane(weight_sku=2.0, explicit=1.5))
    b = solve_optimize(_one_lane(weight_sku=8.0, explicit=1.5))
    assert a["kpis"]["transportCo2Tonnes"] == pytest.approx(1.5 * 1000 * 1000 / 1000)
    assert b["kpis"]["transportCo2Tonnes"] == a["kpis"]["transportCo2Tonnes"]


def test_backward_compat_legacy_tons_per_unit_and_legacy_1t_flag():
    p = _one_lane()
    p["constraints"]["tonsPerUnit"] = 0.5  # legacy project default (t/unit)
    b = solve_optimize(p)
    assert b["co2Basis"]["byCommodity"]["s1"] == 500.0
    assert "legacy" in b["co2Basis"]["defaultSource"]
    # legacy-1t reproduces the pre-weights sample CO2 (2703.5 kt)
    q = sample_payload()
    q["constraints"]["co2WeightBasis"] = "legacy-1t"
    assert solve_optimize(q)["kpis"]["co2Kt"] == pytest.approx(2703.5, abs=0.1)


def test_weight_validation_codes():
    p = _one_lane(weight_sku=-1, weight_group=5000, default=0)
    codes = {i["code"] for i in weight_issues(p)}
    assert codes == {"SKU_WEIGHT_INVALID", "GROUP_WEIGHT_IMPLAUSIBLE", "DEFAULT_WEIGHT_INVALID"}
    p["network"]["skus"][0]["unitWeightKg"] = "heavy"
    p["network"]["productGroups"][0]["unitWeightKg"] = 0.001
    codes = {i["code"] for i in weight_issues(p)}
    assert {"SKU_WEIGHT_INVALID", "GROUP_WEIGHT_IMPLAUSIBLE"} <= codes
    # invalid values are ignored by the resolver (fall back down the chain)
    w, info = resolve_unit_weights(_one_lane(weight_sku=-1, weight_group=4), ["s1"], {"s1": "g1"})
    assert w["s1"] == pytest.approx(0.004)
    assert any(i["code"] == "SKU_WEIGHT_INVALID" for i in info["issues"])
    body = solve_optimize(_one_lane(weight_sku=-1, weight_group=4))
    assert any("SKU_WEIGHT_INVALID" in ln for ln in body["log"])


def _consistency(body):
    k = body["kpis"]
    mix_kg = sum(m["co2Kg"] for m in body["objectiveBreakdown"]["modeMix"])
    lane_kg = sum(lf["co2Kg"] for lf in body["laneFlows"])
    flow_kg = sum(f.get("co2Kg", 0.0) for f in body["flows"])
    for kg in (mix_kg, lane_kg, flow_kg):
        assert kg / 1e6 == pytest.approx(k["transportCo2Kt"], rel=1e-3)
    assert k["co2Kt"] == pytest.approx(k["transportCo2Kt"], abs=0.05)


def test_sample_co2_plausible_and_consistent():
    p = sample_payload()
    body = solve_optimize(p)
    k = body["kpis"]
    assert 1.0 <= k["co2Kt"] <= 20.0  # low-kt range for 27.7M units/yr
    assert k["co2Kt"] == pytest.approx(5.5, abs=0.05)
    assert 20 <= k["co2GPerTonneKm"] <= 110  # truck/rail/intermodal blend
    assert body["co2Basis"]["byCommodity"] == {"sku-ambient": 2.0, "sku-chilled": 1.5, "sku-hazmat": 3.5}
    _consistency(body)
    p["constraints"]["carbonPricePerTonne"] = 100
    b = solve_optimize(p)
    assert b["objectiveBreakdown"]["carbonM"] == pytest.approx(0.5495, abs=0.002)
    _consistency(b)


def test_stress_200_co2_plausible_and_consistent():
    body = solve_optimize(pack_to_optimize_payload(load_enterprise_pack("stress-200-demand.enterprise.json")))
    k = body["kpis"]
    assert 20.0 <= k["co2Kt"] <= 120.0
    assert k["co2Kt"] == pytest.approx(51.0, abs=0.5)
    assert 20 <= k["co2GPerTonneKm"] <= 110
    _consistency(body)
