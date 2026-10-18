"""Regression tests for workbook defects D-01…D-08 (+ small notes)."""

from __future__ import annotations

import copy
import json

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.multi_period import solve_multi_period
from app.solver import solve_optimize
from app.stochastic import solve_stochastic

from .enterprise_payload import load_enterprise_pack, pack_to_optimize_payload
from .test_demo_cost_scaling import SAMPLE_PROJECT, sample_payload

client = TestClient(app)

SHOCKS = [
    {"id": "base", "name": "Base", "probability": 0.4, "demandScale": 1.0, "costScale": 1.0},
    {"id": "soft", "name": "Soft", "probability": 0.3, "demandScale": 0.85, "costScale": 1.0},
    {"id": "surge", "name": "Surge", "probability": 0.3, "demandScale": 1.25, "costScale": 1.0},
]


def _roadmap_payload(mode: str) -> dict:
    p = sample_payload()
    rm = json.loads(SAMPLE_PROJECT.read_text())["state"]["capexRoadmap"]
    force = mode == "force_timeline"
    p["roadmap"] = {
        "baseYearLabel": rm["baseYearLabel"],
        "yearCount": rm["yearCount"],
        "discountRate": 0.1,
        "mode": mode,
        "events": [
            {
                **e,
                "earliestYear": e["year"] if force else 0,
                "latestYear": e["year"] if force else rm["yearCount"] - 1,
                "locked": force,
            }
            for e in rm["events"]
        ],
    }
    return p


# --- D-01 -----------------------------------------------------------------------


@pytest.mark.parametrize("mode", ["choose_timing", "force_timeline"])
def test_d01_default_roadmap_is_optimal_and_kc_starts_closed(mode):
    body = solve_multi_period(_roadmap_payload(mode))
    assert body["status"] == "Optimal", body.get("log")
    assert body["npv"]["totalM"] > 0
    y0 = body["years"][0]
    kc_year = next(t for t in body["eventTiming"] if t["eventId"] == "ev-open-kc")["year"]
    assert "roadmap-kc-dc" not in y0["openIds"] or kc_year == 0
    assert not any("already open" in line for line in body["log"])
    if mode == "force_timeline":
        assert kc_year == 2


# --- D-02 / D-03 ------------------------------------------------------------------


def test_d03_lane_capacity_infeasibility_names_lane_and_shortfall():
    p = sample_payload()
    for lane in p["network"]["lanes"]:
        if lane["id"] == "l9":
            lane["capacityUnits"] = 1000
    body = solve_optimize(p)
    assert body["status"] == "Infeasible"
    hints = {h["code"]: h for h in body["infeasibilityReport"]["hints"]}
    lane = hints["LANE_CAPACITY_CONFLICT"]
    assert lane["entities"] == ["l9"] and lane["customers"] == ["n6"]
    assert lane["shortfalls"][0]["shortBy"] == pytest.approx(1280.0)
    # Both families bind together → both reported as root causes
    assert "MIN_THROUGHPUT_CONFLICT" in hints
    assert set(body["infeasibilityReport"]["rootCauses"]) == {
        "MIN_THROUGHPUT_CONFLICT",
        "LANE_CAPACITY_CONFLICT",
    }


def test_d02_min_throughput_only_reports_single_root_cause():
    p = sample_payload()
    p["network"]["lanes"] = [l for l in p["network"]["lanes"] if l["id"] != "l9"]
    rep = solve_optimize(p)["infeasibilityReport"]
    assert rep["rootCauses"] == ["MIN_THROUGHPUT_CONFLICT"]
    gap = rep["hints"][0]["shortfalls"][0]
    assert gap["facilityId"] == "n2" and gap["gap"] == pytest.approx(1600.0)


# --- D-04 -------------------------------------------------------------------------


def test_d04_robust_uses_run_model_basis():
    run = solve_optimize(sample_payload())
    for obj in ("expected", "minimax", "cvar_lite"):
        p = sample_payload()
        p["scenarioTree"] = {"objective": obj, "cvarAlpha": 0.3, "scenarios": SHOCKS}
        body = solve_stochastic(p)
        assert body["ok"] and body["modelBasis"] == "full"
        assert "n8" not in body["firstStage"]["openIds"]  # Reno may close, as in Run
        base = next(r for r in body["scenarios"] if r["id"] == "base")
        # Base scenario (×1.0) reproduces the Run objective exactly
        assert base["totalCostM"] == pytest.approx(run["objectiveBreakdown"]["totalM"], abs=1e-3)
        assert body["worstCostM"] >= body["expectedCostM"]
        if obj == "minimax":
            assert body["objectiveValueM"] == pytest.approx(body["worstCostM"])
    assert "basisNote" in body


# --- D-05 -------------------------------------------------------------------------


def test_d05_carbon_cost_equals_price_times_reported_tonnes():
    p = sample_payload()
    p["constraints"]["carbonPricePerTonne"] = 100
    body = solve_optimize(p)
    k = body["kpis"]
    assert body["objectiveBreakdown"]["carbonM"] == pytest.approx(
        100 * k["transportCo2Tonnes"] / 1e6, abs=1e-4
    )
    assert k["transportCo2Kt"] == pytest.approx(k["transportCo2Tonnes"] / 1000, abs=1e-3)
    assert k["co2Kt"] == pytest.approx(k["transportCo2Kt"], abs=0.05)
    # tonsPerUnit scales tonnes and carbon cost together (distance-proxy factors)
    q = copy.deepcopy(p)
    for lane in q["network"]["lanes"]:
        lane.pop("co2Kg", None)
        lane.pop("co2KgPerUnit", None)
    q["constraints"]["tonsPerUnit"] = 0.5
    b2 = solve_optimize(q)
    assert b2["objectiveBreakdown"]["carbonM"] == pytest.approx(
        100 * b2["kpis"]["transportCo2Tonnes"] / 1e6, abs=1e-4
    )


# --- D-06 -------------------------------------------------------------------------


def test_d06_cost_kpi_includes_lane_fixed():
    payload = pack_to_optimize_payload(load_enterprise_pack("stress-200-demand.enterprise.json"))
    body = solve_optimize(payload)
    bd, k = body["objectiveBreakdown"], body["kpis"]
    assert bd["laneFixedM"] > 0
    expected = bd["transportM"] + bd["fixedOpexM"] + bd["fixedCapexM"] * 0.12 + bd["laneFixedM"]
    assert k["costM"] == pytest.approx(expected, abs=0.06)
    assert k["laneFixedM"] == pytest.approx(bd["laneFixedM"], abs=1e-4)


# --- D-07 -------------------------------------------------------------------------


def test_d07_max_facilities_counts_dcs_and_max_plants_is_separate():
    p = sample_payload()
    p["constraints"]["maxFacilities"] = 2
    body = solve_optimize(p)
    dcs = [i for i in body["openIds"] if i in ("n2", "n3", "n8")]
    assert len(dcs) <= 2 and "n1" in body["openIds"]  # plant not counted
    q = sample_payload()
    q["constraints"].update({"optimizePlants": True, "maxPlants": 0, "maxFacilities": 3})
    b = solve_optimize(q)
    assert "n1" not in (b.get("openIds") or [])
    assert any("Max plants 0" in line for line in b["log"])


# --- Baseline KPIs ----------------------------------------------------------------


def test_baseline_block_costs_current_network():
    p = sample_payload()
    p["computeBaseline"] = True
    body = solve_optimize(p)
    base = body["baseline"]
    assert base["status"] == "Optimal"
    assert set(base["openIds"]) == {"n1", "n2", "n3", "n8"}
    # Run closes Reno → cheaper than the as-is network, by Reno's OpEx
    assert body["kpis"]["costM"] < base["kpis"]["costM"]
    assert base["kpis"]["costM"] - body["kpis"]["costM"] == pytest.approx(0.7, abs=0.11)


# --- Small notes ------------------------------------------------------------------


def test_group_capacity_applies_to_sku_commodities():
    p = sample_payload()
    for f in p["constraints"]["facilities"]:
        if f["nodeId"] == "n2":
            f["capacityByProduct"]["hazmat"] = 1000
    p["constraints"]["facilities"] = [
        {**f, "capacityMin": 0} for f in p["constraints"]["facilities"]
    ]
    body = solve_optimize(p)
    hz = sum(
        f["volume"]
        for f in body["flows"]
        if f["from"] == "n2" and f.get("productId") == "sku-hazmat" and f["echelon"] == "dc→customer"
    )
    assert hz <= 1000 + 1e-6


def test_cors_allows_5180_and_5181_preview_only():
    for origin, ok in (
        ("http://localhost:5180", True),
        ("http://127.0.0.1:5180", True),
        ("http://localhost:5181", True),
        ("http://localhost:5173", False),
        ("https://evil.example", False),
    ):
        r = client.options(
            "/optimize",
            headers={"Origin": origin, "Access-Control-Request-Method": "POST"},
        )
        assert (r.headers.get("access-control-allow-origin") == origin) is ok, origin
