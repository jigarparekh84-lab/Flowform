"""Roadmap (multi-period) on the Run model basis: Y0 == Run, timing, compat."""

from __future__ import annotations

import json
import time

import pytest

from app.multi_period import solve_multi_period
from app.solver import solve_optimize

from .enterprise_payload import load_enterprise_pack, pack_to_optimize_payload
from .test_demo_cost_scaling import SAMPLE_PROJECT, sample_payload


def _roadmap(mode: str, events: list[dict], year_count: int, **extra) -> dict:
    force = mode == "force_timeline"
    return {
        "baseYearLabel": "FY26",
        "yearCount": year_count,
        "discountRate": 0.10,
        "mode": mode,
        "enforceCapexBudget": False,
        "compareRun": True,
        "events": [
            {
                **e,
                "earliestYear": e["year"] if force else 0,
                "latestYear": e["year"] if force else year_count - 1,
                "locked": force,
            }
            for e in events
        ],
        **extra,
    }


def _sample_roadmap_payload(mode: str) -> dict:
    rm = json.loads(SAMPLE_PROJECT.read_text())["state"]["capexRoadmap"]
    p = sample_payload()
    p["roadmap"] = _roadmap(mode, rm["events"], rm["yearCount"])
    return p


def test_sample_force_timeline_y0_equals_run():
    run = solve_optimize(sample_payload())
    body = solve_multi_period(_sample_roadmap_payload("force_timeline"))
    assert body["status"] == "Optimal"
    assert body["model"] == "multi-period-run-basis-v2"
    assert body["basis"]["model"] == "run"
    assert body["basis"]["commodityMode"] == "sku" and body["basis"]["commodities"] == 3
    y0 = body["years"][0]
    assert not y0["eventsThisYear"]
    rb, ob = y0["runBreakdown"], run["objectiveBreakdown"]
    for k in ("totalM", "transportM", "fixedCapexM", "fixedOpexM", "uncoveredPenaltyM", "laneFixedM", "carbonM"):
        assert rb[k] == pytest.approx(ob[k], abs=1e-3), k
    assert sorted(y0["openIds"]) == sorted(run["openIds"])
    assert y0["co2Kt"] == pytest.approx(run["kpis"]["transportCo2Kt"], abs=1e-3)
    assert body["runCheck"]["matches"] is True
    assert body["runCheck"]["deltaM"] == pytest.approx(0.0, abs=1e-3)
    # captured values (docs/MANUAL_TEST_WORKBOOK.md RMP-04)
    assert body["npv"]["totalM"] == pytest.approx(496.32, abs=0.05)
    assert [r["year"] for r in body["eventTiming"]] == [1, 2, 3, 4, 5]


def test_sample_choose_timing_defers_unneeded_events_and_beats_force():
    choose = solve_multi_period(_sample_roadmap_payload("choose_timing"))
    force = solve_multi_period(_sample_roadmap_payload("force_timeline"))
    assert choose["status"] == "Optimal"
    # no event adds value in the sample → discounting pushes every event to Y5
    assert {e["year"] for e in choose["eventTiming"]} == {5}
    assert choose["npv"]["totalM"] <= force["npv"]["totalM"] + 1e-6
    assert choose["npv"]["totalM"] == pytest.approx(489.89, abs=0.05)
    assert choose["years"][0]["totalCostM"] == pytest.approx(choose["runCheck"]["runTotalM"], abs=1e-3)


def test_roadmap_periods_respect_run_carbon_price_and_weights():
    p = _sample_roadmap_payload("force_timeline")
    p["constraints"]["carbonPricePerTonne"] = 100
    body = solve_multi_period(p)
    run = solve_optimize({k: v for k, v in p.items() if k != "roadmap"})
    assert body["years"][0]["carbonM"] == pytest.approx(run["objectiveBreakdown"]["carbonM"], abs=1e-3)
    assert body["npv"]["carbonNpvM"] > 0


def test_choose_timing_opens_early_when_it_pays():
    """Open-event site that removes unmet-demand penalty is opened at Y0."""
    p = {
        "network": {
            "nodes": [
                {"id": "w", "name": "W", "kind": "dc", "x": 10, "y": 40, "capacity": "10k"},
                {"id": "e", "name": "E", "kind": "candidate", "x": 90, "y": 40, "capacity": "10k"},
                {"id": "dw", "name": "DW", "kind": "demand", "x": 12, "y": 40, "capacity": "5k"},
                {"id": "de", "name": "DE", "kind": "demand", "x": 88, "y": 40, "capacity": "5k"},
            ],
            "lanes": [],
            "demandVolume": {"dw": 5000, "de": 5000},
        },
        "constraints": {
            "serviceRadiusMiles": 300, "capexBudgetM": 50, "maxFacilities": 3,
            "facilities": [
                {"nodeId": "w", "status": "open", "capacityMax": 10000, "fixedOpexM": 0.5},
                {"nodeId": "e", "status": "candidate", "capacityMax": 10000, "fixedOpexM": 0.5},
            ],
        },
        "roadmap": _roadmap("choose_timing", [{
            "id": "ev-e", "name": "Open E", "kind": "open", "year": 3, "nodeId": "e",
            "nodeName": "E", "capexM": 5, "capacityDelta": 10000,
        }], 4),
    }
    body = solve_multi_period(p)
    assert body["status"] == "Optimal"
    assert body["eventTiming"][0]["year"] == 0
    assert all(r["servicePct"] == pytest.approx(100.0) for r in body["years"])


def test_legacy_aggregate_basis_flag_keeps_old_model():
    p = _sample_roadmap_payload("force_timeline")
    p["roadmap"]["basis"] = "legacy-aggregate"
    body = solve_multi_period(p)
    assert body["model"] == "multi-period-capex-npv-v1"
    assert body["basis"]["model"] == "legacy-aggregate"


def test_stress_200_five_periods_fast_with_gap_and_y0_matches_run():
    pk = load_enterprise_pack("stress-200-demand.enterprise.json")
    p = pack_to_optimize_payload(pk)
    p["roadmap"] = _roadmap("force_timeline", [
        {"id": "ev-exp", "name": "Expand Dallas", "kind": "expand", "year": 1, "nodeId": "dc-2",
         "nodeName": "Dallas DC", "capexM": 3, "capacityDelta": 8000},
        {"id": "ev-open", "name": "Open Seattle", "kind": "open", "year": 2, "nodeId": "dc-7",
         "nodeName": "Seattle DC", "capexM": 6, "capacityDelta": 25000},
    ], 5, demandGrowthPct=3)
    t = time.perf_counter()
    body = solve_multi_period(p)
    dt = time.perf_counter() - t
    assert body["status"] == "Optimal"
    assert dt < 60
    assert body["basis"]["gapRel"] == pytest.approx(2e-3)
    assert body["runCheck"]["matches"] is True
    assert abs(body["runCheck"]["deltaPct"]) <= 0.25  # within the MIP gap
    assert "dc-7" in body["years"][2]["openIds"] and "dc-7" not in body["years"][1]["openIds"]
