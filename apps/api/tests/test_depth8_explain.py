"""Depth slice 8: real facility capacity duals + why-opened/closed explain cards."""

from __future__ import annotations

import copy
import time

import pytest
from fastapi.testclient import TestClient

from app.explain import explain_options, fmt_money_m
from app.main import app
from app.solver import solve_optimize

from .enterprise_payload import load_enterprise_pack, pack_to_optimize_payload

client = TestClient(app)


def _two_dc(
    *,
    dc1_cap: float = 600.0,
    demand: float = 1000.0,
    hard: bool = False,
    candidate: bool = False,
    single: bool = False,
) -> dict:
    """dc1 (cheap, $1/unit) + dc2 (expensive, $3/unit) → c1; optional candidate dc3."""
    nodes = [
        {"id": "dc1", "name": "DC1", "kind": "dc", "lat": 33.0, "lng": -97.0},
        {"id": "dc2", "name": "DC2", "kind": "dc", "lat": 34.0, "lng": -97.0},
        {"id": "c1", "name": "C1", "kind": "demand", "lat": 33.5, "lng": -97.2},
    ]
    lanes = [
        {"id": "L1", "from": "dc1", "to": "c1", "costPerUnit": 1.0},
        {"id": "L2", "from": "dc2", "to": "c1", "costPerUnit": 3.0},
    ]
    facilities = [
        {"nodeId": "dc1", "status": "open", "capacityMax": dc1_cap, "fixedCapexM": 0, "fixedOpexM": 0.5},
        {"nodeId": "dc2", "status": "open", "capacityMax": 5000, "fixedCapexM": 0, "fixedOpexM": 0.5},
    ]
    if single:
        nodes, lanes, facilities = [nodes[0], nodes[2]], lanes[:1], facilities[:1]
    if candidate:
        nodes.append({"id": "dc3", "name": "DC3", "kind": "candidate", "lat": 33.4, "lng": -97.1})
        lanes.append({"id": "L3", "from": "dc3", "to": "c1", "costPerUnit": 0.5})
        facilities.append(
            {"nodeId": "dc3", "status": "candidate", "capacityMax": 5000, "fixedCapexM": 6.0, "fixedOpexM": 0.9}
        )
    return {
        "network": {"nodes": nodes, "lanes": lanes, "demandVolume": {"c1": demand}},
        "constraints": {
            "serviceRadiusMiles": 300,
            "capexBudgetM": 20,
            "maxFacilities": 3,
            "hardServiceConstraints": hard,
            "facilities": facilities,
        },
    }


def _sp(body: dict, fid: str) -> dict:
    return next(s for s in body["shadowPrices"] if s["facilityId"] == fid)


def _fx(body: dict, fid: str) -> dict:
    return next(f for f in body["explain"]["facilities"] if f["facilityId"] == fid)


# --- Duals ------------------------------------------------------------------


def test_binding_facility_capacity_dual_is_real_highs_dual():
    body = solve_optimize(_two_dc())
    assert body["ok"] and body["status"] == "Optimal"
    assert sorted(body["openIds"]) == ["dc1", "dc2"]
    sp1 = _sp(body, "dc1")
    # One more unit at dc1 displaces one unit from dc2: saves $3 − $1 = 0.002 model-$M
    assert sp1["method"] == "lp-dual"
    assert sp1["shadowPrice"] == pytest.approx(-0.002, abs=1e-6)
    assert sp1["binding"] is True and sp1["slack"] == pytest.approx(0.0)
    sp2 = _sp(body, "dc2")
    assert sp2["shadowPrice"] == pytest.approx(0.0, abs=1e-9)
    assert sp2["binding"] is False
    assert body["sensitivity"]["method"] == "lp-dual"
    # The legacy flat −0.08 proxy is gone
    assert all(s["shadowPrice"] != pytest.approx(-0.08) for s in body["shadowPrices"])


def test_dual_tracks_cost_gap_and_slack_capacity_has_zero_dual():
    net = _two_dc()
    net["network"]["lanes"][1]["costPerUnit"] = 7.5
    body = solve_optimize(net)
    assert _sp(body, "dc1")["shadowPrice"] == pytest.approx(-0.0065, abs=1e-6)
    roomy = solve_optimize(_two_dc(dc1_cap=5000))
    sp = _sp(roomy, "dc1")
    assert sp["shadowPrice"] == pytest.approx(0.0, abs=1e-9)
    assert sp["binding"] is False and sp["method"] == "lp-dual"


def test_closed_facility_reports_zero_dual():
    body = solve_optimize(_two_dc(dc1_cap=5000))
    assert "dc2" not in body["openIds"]
    sp = _sp(body, "dc2")
    assert sp["shadowPrice"] == 0.0 and sp["binding"] is False and sp.get("closed") is True


# --- Counterfactuals ---------------------------------------------------------


def test_counterfactual_close_delta_sign_and_magnitude():
    body = solve_optimize({**_two_dc(), "explain": True})
    ex = body["explain"]
    assert ex["baseCostM"] == pytest.approx(2.8, abs=1e-6)  # 0.6 + 1.2 + 2×0.5
    cf = _fx(body, "dc1")["counterfactual"]
    assert cf["evaluated"] and cf["status"] == "optimal" and cf["flipTo"] == "closed"
    # dc1 closed: 1000 × 0.003 + 0.5 opex = 3.5 → +0.7
    assert cf["deltaM"] == pytest.approx(0.7, abs=1e-6)
    assert cf["fixedDeltaM"] == pytest.approx(-0.5, abs=1e-6)
    assert cf["variableDeltaM"] == pytest.approx(1.2, abs=1e-6)
    assert cf["servicePct"] == pytest.approx(100.0)
    fx = _fx(body, "dc1")
    assert fx["flipCostM"] == pytest.approx(0.7, abs=1e-6)
    assert fx["capacityDual"] == pytest.approx(-0.002, abs=1e-6)
    texts = [r["text"] for r in fx["reasons"]]
    assert any("Closing it raises cost by $700k" in t for t in texts), texts
    # Dual is $M per model unit (1,000 units): −0.002 → $2.00 per physical unit
    # (= $3 − $1 lane rates), no longer mislabelled "$2.0k per unit".
    assert any("Capacity binding" in t and "$2.00/unit" in t for t in texts), texts
    assert any("lowest landed cost" in t for t in texts), texts


def test_counterfactual_open_candidate_is_positive_and_matches_resolve():
    body = solve_optimize({**_two_dc(candidate=True), "explain": True})
    assert "dc3" not in body["openIds"]
    fx = _fx(body, "dc3")
    assert fx["decision"] == "kept-closed"
    cf = fx["counterfactual"]
    assert cf["flipTo"] == "open"
    # Opening dc3 alone: 1000×0.0005 + 6 capex + 0.9 opex = 7.4 vs 2.8 → +4.6
    assert cf["deltaM"] == pytest.approx(4.6, abs=1e-6)
    assert sorted(cf["alsoCloses"]) == ["dc1", "dc2"]
    texts = " | ".join(r["text"] for r in fx["reasons"])
    assert "Opening it raises cost by $4.6M" in texts
    assert "Would add fixed cost of $6.9M" in texts


def test_counterfactual_matches_independent_forced_closed_solve():
    net = _two_dc(candidate=True)
    body = solve_optimize({**net, "explain": True})
    forced = copy.deepcopy(net)
    for f in forced["constraints"]["facilities"]:
        if f["nodeId"] == "dc2":
            f["status"] = "closed"
    ref = solve_optimize(forced)
    cf = _fx(body, "dc2")["counterfactual"]
    assert cf["costM"] == pytest.approx(ref["objectiveBreakdown"]["totalM"], abs=1e-4)


def test_counterfactual_service_impact_soft_and_infeasible_hard():
    soft = solve_optimize({**_two_dc(single=True, dc1_cap=5000), "explain": True})
    cf = _fx(soft, "dc1")["counterfactual"]
    assert cf["servicePct"] == pytest.approx(0.0)
    assert cf["unservedDeltaUnits"] == pytest.approx(1000.0)
    assert cf["serviceDeltaPct"] == pytest.approx(-100.0)
    assert cf["penaltyDeltaM"] > 0 and cf["deltaM"] > 0
    # 1,000 model units = 1.0M physical units (volume unit = 1,000 units)
    assert "strands 1.0M units" in _fx(soft, "dc1")["headline"]
    # $15/unit default penalty: 1,000 model units × 0.015 $M = $15M
    assert cf["penaltyDeltaM"] == pytest.approx(15.0, abs=1e-6)

    hard = solve_optimize({**_two_dc(single=True, dc1_cap=5000, hard=True), "explain": True})
    fx = _fx(hard, "dc1")
    assert fx["counterfactual"]["status"] == "infeasible"
    assert fx["headline"].startswith("Required: closing it makes the network infeasible")


def test_explain_does_not_change_base_solution_and_is_off_by_default():
    pack = load_enterprise_pack("stress-120-demand.enterprise.json")
    payload = pack_to_optimize_payload(pack)
    off = solve_optimize(copy.deepcopy(payload))
    assert "explain" not in off
    on = solve_optimize({**copy.deepcopy(payload), "explain": True})
    for key in (
        "openIds", "openedIds", "closedIds", "flows", "objectiveBreakdown",
        "shadowPrices", "laneCapacity", "openFacilities", "productBreakdown",
    ):
        assert on[key] == off[key], key
    # Shadow-price row shape unchanged (web reads these fields)
    for sp in off["shadowPrices"]:
        assert {"facilityId", "constraint", "shadowPrice", "unit", "binding", "slack", "method"} <= set(sp)
    assert off["sensitivity"]["method"] == "lp-dual"


def test_counterfactual_cap_and_options():
    assert explain_options({})["enabled"] is False
    assert explain_options({"explain": True})["maxCounterfactuals"] == 12
    o = explain_options({"explain": {"maxCounterfactuals": 3, "budgetSec": 5}})
    assert o["enabled"] and o["maxCounterfactuals"] == 3 and o["budgetSec"] == 5
    assert fmt_money_m(0.7) == "$700k" and fmt_money_m(4.6) == "$4.6M"

    payload = pack_to_optimize_payload(load_enterprise_pack("stress-200-demand.enterprise.json"))
    body = solve_optimize({**payload, "explain": {"maxCounterfactuals": 2}})
    facs = body["explain"]["facilities"]
    assert sum(1 for f in facs if f["counterfactual"]["evaluated"]) == 2
    assert body["explain"]["timing"]["counterfactualCount"] == 2
    assert any("outside top 2" in (f["counterfactual"].get("reason") or "") for f in facs)


def test_stress_200_explain_timing_and_reasons():
    payload = pack_to_optimize_payload(load_enterprise_pack("stress-200-demand.enterprise.json"))
    t0 = time.perf_counter()
    body = solve_optimize({**payload, "explain": True})
    wall = time.perf_counter() - t0
    ex = body["explain"]
    assert wall < 90
    assert ex["timing"]["counterfactualCount"] == len(ex["facilities"])  # 11 ≤ 12 cap
    for f in ex["facilities"]:
        assert f["reasons"], f["facilityId"]
        cf = f["counterfactual"]
        assert cf["status"] in ("optimal", "time-limit", "infeasible")
        if cf.get("deltaM") is not None:
            # Base is MIP-optimal: flipping can't be meaningfully cheaper
            assert cf["deltaM"] >= -ex["gapToleranceM"]
    assert ex["headline"].startswith("The MIP")
    assert ex["topOpenedIds"]
    print(
        f"\n[explain stress-200] wall={wall:.2f}s cf={ex['timing']['counterfactualCount']} "
        f"cfSeconds={ex['timing']['counterfactualSeconds']}"
    )


def test_api_explain_endpoints():
    net = _two_dc()
    r = client.post("/optimize", json=net)
    assert r.status_code == 200 and "explain" not in r.json()
    r = client.post("/optimize", json={**net, "explain": True})
    assert r.status_code == 200 and r.json()["explain"]["enabled"] is True
    r = client.post("/optimize/explain", json={**net, "explainOptions": {"maxCounterfactuals": 1}})
    assert r.status_code == 200
    ex = r.json()["explain"]
    assert ex["timing"]["counterfactualCount"] == 1
    assert client.get("/health").json()["model"].endswith("+explain-v1")
