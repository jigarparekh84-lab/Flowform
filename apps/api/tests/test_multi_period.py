"""Depth slice 5: multi-period CapEx NPV optimize (2–3 year toys)."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app
from app.multi_period import solve_multi_period

client = TestClient(app)


def _toy_network_3y() -> dict:
    """
    West DC open from Y0; East candidate can open Y0–Y2.
    Demand grows so late open is cheaper in NPV terms when CapEx is high early,
    or early open when transport savings dominate — solver chooses.
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
                    "capacity": "10k",
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
                    "y": 40,
                    "capacity": "6k",
                },
                {
                    "id": "d_e",
                    "name": "East Demand",
                    "kind": "demand",
                    "x": 75,
                    "y": 40,
                    "capacity": "6k",
                },
            ],
            "lanes": [],
            "demandVolume": {"d_w": 6000, "d_e": 6000},
        },
        "constraints": {
            "serviceTargetPct": 95,
            "serviceRadiusMiles": 500,
            "capexBudgetM": 40,
            "maxFacilities": 4,
            "facilities": [
                {
                    "nodeId": "dc_w",
                    "status": "open",
                    "capacityMin": 0,
                    "capacityMax": 10000,
                    "fixedCapexM": 0,
                    "fixedOpexM": 0.5,
                },
                {
                    "nodeId": "dc_e",
                    "status": "candidate",
                    "capacityMin": 0,
                    "capacityMax": 10000,
                    "fixedCapexM": 8,
                    "fixedOpexM": 0.6,
                },
            ],
        },
    }


def test_health_mentions_multi_period():
    r = client.get("/health")
    assert r.status_code == 200
    assert "multi-period" in r.json().get("model", "")


def test_force_timeline_2_year_toy():
    base = _toy_network_3y()
    payload = {
        **base,
        "roadmap": {
            "baseYearLabel": "FY26",
            "yearCount": 2,
            "discountRate": 0.10,
            "mode": "force_timeline",
            "demandScaleByYear": [1.0, 1.15],
            "enforceCapexBudget": False,
            "events": [
                {
                    "id": "ev-open-east",
                    "name": "Open East DC",
                    "kind": "open",
                    "year": 1,
                    "nodeId": "dc_e",
                    "nodeName": "East DC",
                    "capexM": 8,
                    "capacityDelta": 10000,
                    "facilityKind": "dc",
                }
            ],
        },
    }
    body = solve_multi_period(payload)
    assert body["ok"] is True
    assert body["model"] == "multi-period-run-basis-v2"
    assert body["mode"] == "force_timeline"
    assert body["yearCount"] == 2
    assert len(body["years"]) == 2
    assert "npv" in body and body["npv"]["totalM"] > 0
    # Event forced in Y1
    timing = {e["eventId"]: e["year"] for e in body["eventTiming"]}
    assert timing["ev-open-east"] == 1
    # Y0: only west open; Y1: east also open
    assert "dc_w" in body["years"][0]["openIds"]
    assert "dc_e" not in body["years"][0]["openIds"]
    assert "dc_e" in body["years"][1]["openIds"]
    assert body["years"][1]["capexM"] == 8
    assert body["years"][0]["capexM"] == 0
    # Flows summary present
    assert body["years"][1]["flowsSummary"]["arcCount"] >= 1


def test_choose_timing_prefers_later_when_capex_high():
    """
    Mandatory open event with no service benefit (West alone covers all demand
    inside radius) + high OpEx ⇒ defer open to latest year.
    """
    base = _toy_network_3y()
    base["constraints"]["serviceRadiusMiles"] = 2000  # West reaches everyone
    base["constraints"]["facilities"][0]["capacityMax"] = 30000
    base["network"]["demandVolume"] = {"d_w": 5000, "d_e": 5000}
    # Cheap explicit lanes from West ⇒ East open has no transport upside
    base["network"]["lanes"] = [
        {"id": "lw1", "from": "dc_w", "to": "d_w", "mode": "TL", "costPerUnit": 0.5, "leadDays": 1},
        {"id": "lw2", "from": "dc_w", "to": "d_e", "mode": "TL", "costPerUnit": 0.5, "leadDays": 2},
    ]
    base["constraints"]["facilities"][1]["fixedOpexM"] = 5.0  # painful while open
    payload = {
        **base,
        "roadmap": {
            "baseYearLabel": "FY26",
            "yearCount": 3,
            "discountRate": 0.30,
            "mode": "choose_timing",
            "demandScaleByYear": [1.0, 1.0, 1.0],
            "enforceCapexBudget": False,
            "events": [
                {
                    "id": "ev-open-east",
                    "name": "Open East DC",
                    "kind": "open",
                    "year": 0,
                    "earliestYear": 0,
                    "latestYear": 2,
                    "nodeId": "dc_e",
                    "nodeName": "East DC",
                    "capexM": 20,
                    "capacityDelta": 10000,
                    "facilityKind": "dc",
                }
            ],
        },
    }
    body = solve_multi_period(payload)
    assert body["ok"] is True
    assert body["mode"] == "choose_timing"
    timing = {e["eventId"]: e["year"] for e in body["eventTiming"]}
    assert timing["ev-open-east"] == 2, (timing, body.get("log"), body["npv"])
    assert body["npv"]["totalM"] > 0
    assert len(body["years"]) == 3
    assert body["years"][2]["capexM"] == 20
    assert body["years"][0]["capexM"] == 0


def test_choose_timing_opens_early_when_capacity_required():
    """
    West capacity too small for east demand ⇒ must open east by Y0 (hard service).
    """
    base = _toy_network_3y()
    base["constraints"]["facilities"][0]["capacityMax"] = 7000  # can't cover 12k
    payload = {
        **base,
        "roadmap": {
            "baseYearLabel": "FY26",
            "yearCount": 3,
            "discountRate": 0.10,
            "mode": "choose_timing",
            "hardServiceConstraints": True,
            "demandScaleByYear": [1.0, 1.0, 1.0],
            "enforceCapexBudget": False,
            "events": [
                {
                    "id": "ev-open-east",
                    "name": "Open East DC",
                    "kind": "open",
                    "year": 2,
                    "earliestYear": 0,
                    "latestYear": 2,
                    "nodeId": "dc_e",
                    "nodeName": "East DC",
                    "capexM": 8,
                    "capacityDelta": 10000,
                    "facilityKind": "dc",
                }
            ],
        },
    }
    body = solve_multi_period(payload)
    assert body["ok"] is True, body.get("log")
    timing = {e["eventId"]: e["year"] for e in body["eventTiming"]}
    assert timing["ev-open-east"] == 0  # must open immediately under hard service
    for row in body["years"]:
        assert "dc_e" in row["openIds"]
        assert row["servicePct"] >= 99.0


def test_api_multi_period_endpoint():
    base = _toy_network_3y()
    payload = {
        **base,
        "roadmap": {
            "yearCount": 2,
            "discountRate": 0.1,
            "mode": "force_timeline",
            "enforceCapexBudget": False,
            "events": [
                {
                    "id": "ev1",
                    "kind": "open",
                    "year": 0,
                    "nodeId": "dc_e",
                    "nodeName": "East DC",
                    "capexM": 5,
                    "capacityDelta": 10000,
                }
            ],
        },
    }
    r = client.post("/optimize/multi-period", json=payload)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    assert body["npv"]["totalM"] > 0
    assert len(body["years"]) == 2


def test_expand_increases_capacity_over_years():
    base = _toy_network_3y()
    # Only west; expand in Y1
    base["network"]["nodes"] = [
        n for n in base["network"]["nodes"] if n["id"] != "dc_e"
    ]
    base["constraints"]["facilities"] = [
        f for f in base["constraints"]["facilities"] if f["nodeId"] != "dc_e"
    ]
    base["constraints"]["facilities"][0]["capacityMax"] = 8000
    # Demand only west cluster so expand helps local volume growth
    base["network"]["demandVolume"] = {"d_w": 7000, "d_e": 500}
    payload = {
        **base,
        "roadmap": {
            "yearCount": 2,
            "discountRate": 0.05,
            "mode": "force_timeline",
            "demandScaleByYear": [1.0, 1.2],
            "enforceCapexBudget": False,
            "events": [
                {
                    "id": "ev-exp",
                    "name": "Expand West",
                    "kind": "expand",
                    "year": 1,
                    "nodeId": "dc_w",
                    "nodeName": "West DC",
                    "capexM": 3,
                    "capacityDelta": 5000,
                }
            ],
        },
    }
    body = solve_multi_period(payload)
    assert body["ok"] is True
    y0_cap = body["years"][0]["capacityByFacility"].get("dc_w", 0)
    y1_cap = body["years"][1]["capacityByFacility"].get("dc_w", 0)
    assert y1_cap >= y0_cap + 4000
    assert body["years"][1]["capexM"] == 3
