"""Demo fixes: feasible built-in sample + network-consistent cost scaling.

Money is $M; lane costPerUnit is $/unit and one model volume unit is 1,000
physical units (see ``app.solver`` header). Off-lane arcs are priced at the
network's median lane $/unit-mile × ``offLanePremium`` and unmet demand at
``uncoveredPenaltyPerUnit`` $/unit — both configurable.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from app.solver import (
    DEFAULT_OFF_LANE_PREMIUM,
    DEFAULT_UNCOVERED_PENALTY_PER_UNIT,
    resolve_cost_scale,
    solve_optimize,
)

from .enterprise_payload import load_enterprise_pack, pack_to_optimize_payload

SAMPLE_PROJECT = (
    Path(__file__).resolve().parents[2]
    / "web"
    / "public"
    / "samples"
    / "na-footprint-2027.flowform.json"
)


def sample_payload() -> dict:
    """Optimize payload from the built-in sample project, shaped like the web's
    packToOptimizePayload: one SKU per product group (``sku-<group>``) with
    group-level facility capability."""
    st = json.loads(SAMPLE_PROJECT.read_text())["state"]
    net, pm, cons = st["network"], st["productMix"], st["constraints"]
    caps = {c["nodeId"]: c for c in pm["facilityCaps"]}
    dbp = [
        {
            "customerId": row["nodeId"],
            "productId": f"sku-{gid}",
            "skuId": f"sku-{gid}",
            "volume": round(net["demandVolume"][row["nodeId"]] * share / 100),
        }
        for row in pm["demandMix"]
        for gid, share in row["shares"].items()
        if share > 0
    ]
    facilities = []
    for f in cons["facilities"]:
        c = caps.get(f["nodeId"])
        facilities.append(
            {
                **f,
                **(
                    {
                        "capableProductIds": c["capableGroupIds"],
                        "capacityByProduct": c["capacityByGroup"],
                    }
                    if c
                    else {}
                ),
            }
        )
    bom_demand = [
        {"supplierId": r["preferredSupplierId"], "plantId": r["plantId"], "qtyPerUnit": r["qtyPerUnit"]}
        for r in st["bom"]["rows"]
        if r.get("preferredSupplierId") and r.get("plantId")
    ]
    return {
        "network": {
            "nodes": net["nodes"],
            "lanes": net["lanes"],
            "demandVolume": net["demandVolume"],
            "demandByProduct": dbp,
            "bomDemand": bom_demand,
            "skus": [
                {"id": f"sku-{g['id']}", "name": g["name"], "groupId": g["id"]}
                for g in pm["groups"]
            ],
            "productGroups": [{"id": g["id"], "name": g["name"]} for g in pm["groups"]],
        },
        "constraints": {**cons, "facilities": facilities},
    }


# --- Issue 1: built-in sample is feasible -------------------------------------


def test_sample_network_solves_optimal_with_full_service_and_closes_reno():
    body = solve_optimize({**sample_payload(), "explain": True})
    assert body["status"] == "Optimal", body.get("infeasibilityReport")
    assert body["kpis"]["servicePct"] == pytest.approx(100.0)
    assert all(p["servicePct"] == pytest.approx(100.0) for p in body["productBreakdown"])
    # Global service radius untouched — fixed in data (Columbus → NYC hazmat lane)
    assert sample_payload()["constraints"]["serviceRadiusMiles"] == 250
    hazmat_nyc = [
        f for f in body["flows"] if f["to"] == "n6" and f.get("productId") == "sku-hazmat"
    ]
    assert hazmat_nyc and {f["from"] for f in hazmat_nyc} == {"n2"}
    assert "n8" in body["closedIds"]  # Reno DC has no customers within 250 mi
    reno = next(f for f in body["explain"]["facilities"] if f["facilityId"] == "n8")
    assert reno["decision"] == "closed"
    assert any("No customers within service radius" in r["text"] for r in reno["reasons"])
    assert body["explain"]["topClosedIds"] == ["n8"]


def test_sample_without_hazmat_lane_reproduces_the_original_infeasibility():
    p = sample_payload()
    p["network"]["lanes"] = [l for l in p["network"]["lanes"] if l["id"] != "l9"]
    body = solve_optimize(p)
    assert body["status"] == "Infeasible"
    # D-02: the root cause is facility minimum throughput, not the soft
    # unreachable demand (which is still reported, as context).
    hints = body["infeasibilityReport"]["hints"]
    assert hints[0]["code"] == "MIN_THROUGHPUT_CONFLICT" and hints[0]["rootCause"]
    assert "n2" in hints[0]["entities"]
    assert hints[0]["relaxedServicePct"] == pytest.approx(91.8)
    assert hints[0]["relaxedObjectiveM"] == pytest.approx(122.76, abs=0.01)
    unreach = next(h for h in hints if h["code"] == "UNREACHABLE_DEMAND")
    assert unreach["entities"] == ["n6/sku-hazmat"] and unreach["rootCause"] is False


# --- Issue 2: cost scaling ----------------------------------------------------


def _one_dc(lane_to_c2: bool) -> dict:
    """DC → c1 on a rated lane; DC → c2 (same distance) with or without one."""
    nodes = [
        {"id": "dc", "name": "DC", "kind": "dc", "lat": 35.0, "lng": -90.0},
        {"id": "c1", "name": "C1", "kind": "demand", "lat": 36.5, "lng": -90.0},
        {"id": "c2", "name": "C2", "kind": "demand", "lat": 33.5, "lng": -90.0},
    ]
    lanes = [{"id": "L1", "from": "dc", "to": "c1", "costPerUnit": 0.5}]
    if lane_to_c2:
        lanes.append({"id": "L2", "from": "dc", "to": "c2", "costPerUnit": 0.5})
    return {
        "network": {"nodes": nodes, "lanes": lanes, "demandVolume": {"c1": 100, "c2": 100}},
        "constraints": {
            "serviceRadiusMiles": 250,
            "facilities": [{"nodeId": "dc", "status": "open", "capacityMax": 1000, "fixedOpexM": 0.1}],
        },
    }


def test_off_lane_rate_is_median_lane_rate_times_premium():
    body = solve_optimize(_one_dc(lane_to_c2=False))
    cs = body["costScale"]
    on = next(f for f in body["flows"] if f["to"] == "c1")
    off = next(f for f in body["flows"] if f["to"] == "c2")
    assert cs["offLaneRateSource"] == "median-lane×premium"
    assert cs["offLanePremium"] == DEFAULT_OFF_LANE_PREMIUM
    # Same distance: the off-lane arc costs the lane rate × 1.35 — not ~1,000×
    assert off["unitCost"] / on["unitCost"] == pytest.approx(1.35, rel=0.01)
    assert 1.25 <= off["unitCost"] / on["unitCost"] <= 1.5


def test_cost_knobs_are_configurable_and_legacy_penalty_is_ignored():
    p = _one_dc(lane_to_c2=False)
    p["constraints"].update(offLanePremium=1.5, uncoveredPenaltyPerUnit=40)
    p["network"]["costFactors"] = {"uncoveredPenaltyM": 80}
    cs = resolve_cost_scale(p)
    assert cs["offLanePremium"] == 1.5
    assert cs["uncoveredPenaltyPerUnit"] == 40 and cs["uncoveredPenaltySource"] == "configured"
    assert cs["uncoveredPenaltyM"] == pytest.approx(0.04)  # $M per model unit
    body = solve_optimize(p)
    assert any("legacy costFactors.uncoveredPenaltyM ignored" in l for l in body["log"])
    p2 = copy.deepcopy(p)
    p2["constraints"]["offLaneRatePerUnitMile"] = 0.01
    assert resolve_cost_scale(p2)["offLaneRateSource"] == "configured"
    bare = {"network": {"nodes": [], "lanes": []}, "constraints": {}}
    cs0 = resolve_cost_scale(bare)
    assert cs0["offLaneRateSource"].startswith("default")
    assert cs0["uncoveredPenaltyPerUnit"] == DEFAULT_UNCOVERED_PENALTY_PER_UNIT


def test_unmet_penalty_sits_well_above_landed_cost():
    payload = pack_to_optimize_payload(load_enterprise_pack("stress-200-demand.enterprise.json"))
    cs = resolve_cost_scale(payload)
    assert cs["uncoveredPenaltyPerUnit"] >= 10 * cs["medianLaneCostPerUnit"]
    body = solve_optimize(payload)
    landed = [
        f["landedCostPerUnit"] * 1000  # $M per model unit → $ per unit
        for f in solve_optimize({**payload, "explain": {"maxCounterfactuals": 0}})["explain"][
            "facilities"
        ]
        if f["landedCostPerUnit"] is not None and f["tier"] == "dc"
    ]
    assert landed and max(landed) * 3 < cs["uncoveredPenaltyPerUnit"]
    assert body["objectiveBreakdown"]["uncoveredPenaltyM"] == 0.0


def test_stress_200_flip_costs_are_believable():
    payload = pack_to_optimize_payload(load_enterprise_pack("stress-200-demand.enterprise.json"))
    body = solve_optimize({**payload, "explain": True})
    assert body["status"] == "Optimal"
    bd = body["objectiveBreakdown"]
    # ~197.5M units/period across NA: total in the low $100Ms, transport-led
    assert 100 < bd["totalM"] < 300
    assert bd["transportM"] / bd["totalM"] > 0.8
    assert body["kpis"]["servicePct"] == pytest.approx(100.0)
    ex = body["explain"]
    non_stranding = [
        f["counterfactual"]
        for f in ex["facilities"]
        if f["counterfactual"].get("deltaPct") is not None
        and (f["counterfactual"].get("unservedDeltaUnits") or 0) <= 0.5
    ]
    assert non_stranding
    for cf in non_stranding:
        assert 0 <= cf["deltaPct"] < 25, cf
        assert cf["deltaM"] < 50
    for f in ex["facilities"]:
        op = f["counterfactual"].get("operatingDeltaM")
        if op is not None:
            assert abs(op) < bd["totalM"], f  # no more "thousands of $M"
    assert ex["topClosedIds"], "candidate DCs stay closed at realistic rates"
