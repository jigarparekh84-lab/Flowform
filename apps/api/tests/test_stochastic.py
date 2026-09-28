"""Depth slice 6: stochastic / scenario-tree optimize (2-scenario toy)."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app
from app.stochastic import solve_stochastic

client = TestClient(app)


def _toy_2scenario() -> dict:
    """
    West DC open (forced); East candidate optional.
    Soft demand: West alone is fine.
    Surge demand: need East (or pay huge uncovered) — robust should open East.
    """
    return {
        "network": {
            "nodes": [
                {
                    "id": "dc_w",
                    "name": "West DC",
                    "kind": "dc",
                    "x": 20,
                    "y": 40,
                    "capacity": "8k",
                },
                {
                    "id": "dc_e",
                    "name": "East DC",
                    "kind": "candidate",
                    "x": 80,
                    "y": 40,
                    "capacity": "10k",
                },
                {
                    "id": "d_w",
                    "name": "West Demand",
                    "kind": "demand",
                    "x": 25,
                    "y": 45,
                    "capacity": "5k",
                },
                {
                    "id": "d_e",
                    "name": "East Demand",
                    "kind": "demand",
                    "x": 75,
                    "y": 45,
                    "capacity": "5k",
                },
            ],
            "lanes": [],
            "demandVolume": {"d_w": 5000, "d_e": 5000},
        },
        "constraints": {
            "serviceTargetPct": 95,
            "serviceRadiusMiles": 500,
            "capexBudgetM": 40,
            "maxFacilities": 4,
            "hardServiceConstraints": False,
            "facilities": [
                {
                    "nodeId": "dc_w",
                    "status": "open",
                    "capacityMin": 0,
                    "capacityMax": 8000,
                    "fixedCapexM": 0,
                    "fixedOpexM": 0.4,
                },
                {
                    "nodeId": "dc_e",
                    "status": "candidate",
                    "capacityMin": 0,
                    "capacityMax": 10000,
                    "fixedCapexM": 5,
                    "fixedOpexM": 0.5,
                },
            ],
        },
    }


def test_health_mentions_stochastic():
    r = client.get("/health")
    assert r.status_code == 200
    assert "stochastic" in r.json().get("model", "")


def test_expected_2_scenario_toy():
    base = _toy_2scenario()
    # Soft: base demand; Surge: 1.6x — West capacity 8k can't cover 16k alone
    payload = {
        **base,
        "scenarioTree": {
            "objective": "expected",
            "computeEvpi": True,
            "scenarios": [
                {
                    "id": "soft",
                    "name": "Soft",
                    "probability": 0.5,
                    "demandScale": 0.7,
                },
                {
                    "id": "surge",
                    "name": "Surge",
                    "probability": 0.5,
                    "demandScale": 1.6,
                },
            ],
        },
    }
    body = solve_stochastic(payload)
    assert body["ok"] is True
    assert body["model"] == "stochastic-scenario-tree-v1"
    assert body["objective"] == "expected"
    assert set(body["firstStage"]["openIds"]) >= {"dc_w"}
    # Shared first-stage: every scenario row reports same opens
    opens = body["firstStage"]["openIds"]
    for row in body["scenarios"]:
        assert row["openIds"] == opens
    assert len(body["scenarios"]) == 2
    assert body["expectedCostM"] > 0
    # Surge should cost more variable (transport/uncov) than soft
    by_id = {r["id"]: r for r in body["scenarios"]}
    assert by_id["surge"]["totalCostM"] >= by_id["soft"]["totalCostM"]
    # EVPI present and non-negative when computed
    assert body["evpi"] is not None
    assert body["evpi"]["evpiGapM"] is not None
    assert body["evpi"]["evpiGapM"] >= -1e-6
    assert body["evpi"]["waitAndSeeExpectedM"] is not None
    assert body["evpi"]["waitAndSeeExpectedM"] <= body["evpi"]["hereAndNowExpectedM"] + 1e-4


def test_minimax_opens_for_worst_case():
    """Minimax should open East to hedge surge (capacity shortfall + penalty)."""
    base = _toy_2scenario()
    # Make East CapEx moderate; uncovered penalty dominates if closed in surge
    base["constraints"]["facilities"][1]["fixedCapexM"] = 3
    payload = {
        **base,
        "scenarioTree": {
            "objective": "minimax",
            "computeEvpi": True,
            "scenarios": [
                {"id": "soft", "name": "Soft", "probability": 0.6, "demandScale": 0.8},
                {"id": "surge", "name": "Surge", "probability": 0.4, "demandScale": 1.7},
            ],
        },
    }
    body = solve_stochastic(payload)
    assert body["ok"] is True
    assert body["objective"] == "minimax"
    assert "dc_e" in body["firstStage"]["openIds"], (body["firstStage"], body.get("log"))
    assert body["worstCostM"] >= body["expectedCostM"] - 1e-6


def test_api_stochastic_endpoint():
    base = _toy_2scenario()
    payload = {
        **base,
        "scenarioTree": {
            "objective": "cvar_lite",
            "cvarAlpha": 0.4,
            "computeEvpi": False,
            "scenarios": [
                {"id": "a", "probability": 0.5, "demandScale": 1.0},
                {"id": "b", "probability": 0.5, "demandScale": 1.2, "costScale": 1.1},
            ],
        },
    }
    r = client.post("/optimize/stochastic", json=payload)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    assert body["objective"] == "cvar_lite"
    assert body["cvarAlpha"] == 0.4
    assert len(body["scenarios"]) == 2
    assert "dc_w" in body["openedIds"]


def test_rejects_single_scenario():
    base = _toy_2scenario()
    payload = {
        **base,
        "scenarioTree": {
            "objective": "expected",
            "scenarios": [{"id": "only", "probability": 1.0, "demandScale": 1.0}],
        },
    }
    r = client.post("/optimize/stochastic", json=payload)
    assert r.status_code == 400
