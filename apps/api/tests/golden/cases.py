"""Golden cases (FF-102, IMPLEMENTATION_PLAN §10.2).

Each case builds a payload, runs the engine, and *extracts* a stable summary
(objective breakdown, decisions, KPIs, explain headline). The summary is
checked in as ``<name>.json`` and ``test_golden.py`` compares fresh results
against it.

Regenerate (only when a result change is intended and reviewed):

    cd apps/api && .venv/bin/python -m tests.golden.regenerate
"""

from __future__ import annotations

import json
from typing import Any, Callable

from app.multi_period import solve_multi_period
from app.solver import solve_optimize
from app.stochastic import solve_stochastic

from ..enterprise_payload import load_enterprise_pack, pack_to_optimize_payload
from ..test_demo_cost_scaling import SAMPLE_PROJECT, sample_payload

BREAKDOWN_KEYS = (
    "totalM", "transportM", "fixedCapexM", "fixedOpexM",
    "uncoveredPenaltyM", "laneFixedM", "carbonM",
)
KPI_KEYS = (
    "servicePct", "objectiveTotalM", "transportCostM", "uncoveredDemand",
    "transportCo2Kt", "bindingLaneCount",
)

SHOCKS = [
    {"id": "base", "name": "Base", "probability": 0.4, "demandScale": 1.0, "costScale": 1.0},
    {"id": "soft", "name": "Soft", "probability": 0.3, "demandScale": 0.85, "costScale": 1.0},
    {"id": "surge", "name": "Surge", "probability": 0.3, "demandScale": 1.25, "costScale": 1.0},
]


def _optimize_summary(body: dict[str, Any], *, co2: bool = True) -> dict[str, Any]:
    """``co2=False`` drops transportCo2Kt: with carbon price 0 it is not part of
    the objective, so alternate optima (seen Linux vs macOS on stress-200)
    move CO2 without changing cost."""
    bd = body["objectiveBreakdown"]
    k = body["kpis"]
    return {
        "status": body["status"],
        "model": body["model"],
        "openIds": sorted(body["openIds"]),
        "closedIds": sorted(body.get("closedIds") or []),
        "objectiveBreakdown": {key: bd[key] for key in BREAKDOWN_KEYS},
        "kpis": {key: k[key] for key in KPI_KEYS if key in k and (co2 or key != "transportCo2Kt")},
        "bindingLaneCapacities": sorted(
            (b.get("laneId") or b.get("id") or json.dumps(b, sort_keys=True))
            for b in (body.get("bindingLaneCapacities") or [])
        ),
    }


def _stress(name: str) -> dict[str, Any]:
    return pack_to_optimize_payload(load_enterprise_pack(name))


def g_sample() -> dict[str, Any]:
    return _optimize_summary(solve_optimize(sample_payload()))


def g_m120() -> dict[str, Any]:
    return _optimize_summary(solve_optimize(_stress("stress-120-demand.enterprise.json")), co2=False)


def g_m200() -> dict[str, Any]:
    return _optimize_summary(solve_optimize(_stress("stress-200-demand.enterprise.json")), co2=False)


def g_inf() -> dict[str, Any]:
    out: dict[str, Any] = {}
    p = sample_payload()
    p["network"]["lanes"] = [l for l in p["network"]["lanes"] if l["id"] != "l9"]
    rep = solve_optimize(p)["infeasibilityReport"]
    out["noL9"] = {"rootCauses": rep["rootCauses"], "firstShortfall": rep["hints"][0]["shortfalls"][0]}
    p = sample_payload()
    for lane in p["network"]["lanes"]:
        if lane["id"] == "l9":
            lane["capacityUnits"] = 1000
    body = solve_optimize(p)
    rep = body["infeasibilityReport"]
    hints = {h["code"]: h for h in rep["hints"]}
    lane = hints["LANE_CAPACITY_CONFLICT"]
    out["l9Cap1000"] = {
        "status": body["status"],
        "rootCauses": sorted(rep["rootCauses"]),
        "laneEntities": lane["entities"],
        "laneCustomers": lane["customers"],
        "laneShortfalls": lane["shortfalls"],
    }
    return out


def _roadmap_payload(mode: str) -> dict[str, Any]:
    rm = json.loads(SAMPLE_PROJECT.read_text())["state"]["capexRoadmap"]
    force = mode == "force_timeline"
    yc = rm["yearCount"]
    p = sample_payload()
    p["roadmap"] = {
        "baseYearLabel": "FY26", "yearCount": yc, "discountRate": 0.10, "mode": mode,
        "enforceCapexBudget": False, "compareRun": True,
        "events": [
            {**e, "earliestYear": e["year"] if force else 0,
             "latestYear": e["year"] if force else yc - 1, "locked": force}
            for e in rm["events"]
        ],
    }
    return p


def g_roadmap() -> dict[str, Any]:
    out = {}
    for mode in ("choose_timing", "force_timeline"):
        b = solve_multi_period(_roadmap_payload(mode))
        out[mode] = {
            "status": b["status"],
            "model": b["model"],
            "npvTotalM": b["npv"]["totalM"],
            "eventTiming": [{"eventId": t["eventId"], "year": t["year"]} for t in b["eventTiming"]],
            "yearOpenIds": [sorted(y["openIds"]) for y in b["years"]],
        }
    return out


def g_robust() -> dict[str, Any]:
    out = {}
    for obj in ("expected", "minimax", "cvar_lite"):
        p = sample_payload()
        p["scenarioTree"] = {"objective": obj, "cvarAlpha": 0.3, "scenarios": SHOCKS}
        b = solve_stochastic(p)
        out[obj] = {
            "modelBasis": b["modelBasis"],
            "firstStageOpenIds": sorted(b["firstStage"]["openIds"]),
            "expectedCostM": b["expectedCostM"],
            "worstCostM": b["worstCostM"],
            "objectiveValueM": b["objectiveValueM"],
            "scenarioCostM": {r["id"]: r["totalCostM"] for r in b["scenarios"]},
        }
    return out


def _explain_summary(body: dict[str, Any]) -> dict[str, Any]:
    ex = body["explain"]
    return {
        "headline": ex["headline"],
        "baseCostM": ex["baseCostM"],
        "topOpenedIds": ex["topOpenedIds"],
        "topClosedIds": ex["topClosedIds"],
        "facilities": {
            f["facilityId"]: {
                "decision": f["decision"],
                "headline": f["headline"],
                "cfStatus": f["counterfactual"].get("status"),
                "cfDeltaM": f["counterfactual"].get("deltaM"),
                "capacityDual": f.get("capacityDual"),
            }
            for f in ex["facilities"]
        },
    }


def g_explain_sample() -> dict[str, Any]:
    return _explain_summary(solve_optimize({**sample_payload(), "explain": True}))


def g_explain_m200() -> dict[str, Any]:
    return _explain_summary(solve_optimize({**_stress("stress-200-demand.enterprise.json"), "explain": True}))


CASES: dict[str, Callable[[], dict[str, Any]]] = {
    "G-S": g_sample,
    "G-M120": g_m120,
    "G-M200": g_m200,
    "G-INF": g_inf,
    "G-RMP": g_roadmap,
    "G-ROB": g_robust,
    "G-EXP-S": g_explain_sample,
    "G-EXP-M200": g_explain_m200,
}
