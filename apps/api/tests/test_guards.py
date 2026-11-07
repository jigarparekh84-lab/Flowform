"""Guards added after review: input caps, solver time limit, error mapping.

These are the protections that keep an unauthenticated ``/optimize`` from
pinning a worker, and that stop a time-limited solve from being reported as a
complete, zero-cost network.
"""

from __future__ import annotations

import copy

import pulp
import pytest
from fastapi.testclient import TestClient

from app import main
from app.main import app
from flowform_engine import PayloadTooLarge, guard_payload
from flowform_engine.limits import (
    DEFAULT_TIME_LIMIT_SEC,
    MAX_TIME_LIMIT_SEC,
    MIN_TIME_LIMIT_SEC,
    time_limit_sec,
)
from flowform_engine.solver import solve_optimize

from .test_demo_cost_scaling import sample_payload

CLIENT = TestClient(app)


# --- payload size caps -------------------------------------------------------


def test_normal_payload_passes_the_guard() -> None:
    guard_payload(sample_payload())  # no raise


@pytest.mark.parametrize(
    "network,constraints,needle",
    [
        ({"nodes": [{"id": f"n{i}"} for i in range(5)], "lanes": []},
         {"maxNetworkNodes": 4}, "Network nodes"),
        ({"nodes": [], "lanes": [{"id": f"l{i}"} for i in range(3)]},
         {"maxNetworkLanes": 2}, "Network lanes"),
        ({"nodes": [], "lanes": [], "demandVolume": {"a": 1, "b": 2, "c": 3}},
         {"maxDemandRows": 2}, "Demand rows"),
        ({"nodes": [], "lanes": [], "skus": [{"id": "s1"}, {"id": "s2"}]},
         {"maxCommodities": 1}, "SKUs"),
    ],
)
def test_guard_rejects_oversized_networks(network, constraints, needle) -> None:
    with pytest.raises(PayloadTooLarge) as exc:
        guard_payload({"network": network, "constraints": constraints})
    assert needle in str(exc.value)
    # The message must tell the caller what to do about it.
    assert "constraints." in str(exc.value)


def test_guard_covers_roadmap_events_and_scenarios() -> None:
    payload = {
        "network": {"nodes": [], "lanes": []},
        "constraints": {"maxRoadmapEvents": 1, "maxScenarios": 1},
        "roadmap": {"events": [{"id": "e1"}, {"id": "e2"}]},
        "scenarioTree": {"scenarios": [{"id": "s1"}, {"id": "s2"}]},
    }
    with pytest.raises(PayloadTooLarge, match="Roadmap events"):
        guard_payload(payload, roadmap=True)
    with pytest.raises(PayloadTooLarge, match="Scenarios"):
        guard_payload(payload, scenarios=True)


def test_guard_rejects_non_object_payload() -> None:
    with pytest.raises(PayloadTooLarge):
        guard_payload(["not", "a", "payload"])


# --- solver time limit -------------------------------------------------------


def test_time_limit_defaults_clamps_and_ignores_garbage() -> None:
    assert time_limit_sec({}) == DEFAULT_TIME_LIMIT_SEC
    assert time_limit_sec({"constraints": {"solverTimeLimitSec": 30}}) == 30
    # A caller cannot switch the guard off, nor ask for an unbounded solve.
    assert time_limit_sec({"constraints": {"solverTimeLimitSec": 0}}) == MIN_TIME_LIMIT_SEC
    assert time_limit_sec({"constraints": {"solverTimeLimitSec": -5}}) == MIN_TIME_LIMIT_SEC
    assert time_limit_sec({"constraints": {"solverTimeLimitSec": 1e9}}) == MAX_TIME_LIMIT_SEC
    assert time_limit_sec({"constraints": {"solverTimeLimitSec": "abc"}}) == DEFAULT_TIME_LIMIT_SEC


def test_time_limit_is_actually_passed_to_the_solver(monkeypatch) -> None:
    seen: list[float] = []
    real_solve = pulp.LpProblem.solve

    def spy(prob, solver=None, *a, **kw):
        seen.append(getattr(solver, "timeLimit", None))
        return real_solve(prob, solver, *a, **kw)

    monkeypatch.setattr(pulp.LpProblem, "solve", spy)
    solve_optimize({**sample_payload(), "constraints": {
        **sample_payload()["constraints"], "solverTimeLimitSec": 42,
    }})
    assert seen and seen[0] == pytest.approx(42.0)


def test_time_limited_solve_raises_instead_of_reporting_a_fake_optimum(monkeypatch) -> None:
    """PuLP leaves values at 0.0 when it hits the limit; never report that."""

    def timed_out(prob, solver=None, *a, **kw):
        prob.status = 0  # "Not Solved"
        for var in prob.variables():
            var.varValue = 0.0
        return 0

    monkeypatch.setattr(pulp.LpProblem, "solve", timed_out)
    with pytest.raises(RuntimeError, match="time limit"):
        solve_optimize(sample_payload())


# --- capacityMax = 0 means zero, not unlimited -------------------------------


def test_explicit_zero_capacity_is_not_treated_as_unlimited() -> None:
    """Regression: ``capacityMax: 0`` used to fall through to the 1e9 fallback.

    With every facility at zero capacity (and no minimum throughput forcing them
    open) the model must serve nothing; the bug served everything for free.
    """
    payload = copy.deepcopy(sample_payload())
    for facility in payload["constraints"]["facilities"]:
        facility["capacityMax"] = 0
        facility["capacityMin"] = 0
        facility.pop("capacityByProduct", None)
    body = solve_optimize(payload)
    assert body["status"] == "Optimal", body.get("infeasibilityReport")
    assert body["kpis"]["servicePct"] == pytest.approx(0.0)
    assert body["flows"] == []  # nothing can move through a zero-capacity site
    assert body["objectiveBreakdown"]["uncoveredPenaltyM"] > 0


# --- HTTP error mapping ------------------------------------------------------


def test_engine_value_error_is_400() -> None:
    r = CLIENT.post("/optimize", json={
        "network": {"nodes": [{"id": "p1", "kind": "plant"}], "lanes": []},
        "constraints": {},
    })
    assert r.status_code == 400, r.text
    assert "demand" in r.json()["detail"].lower()


def test_oversized_payload_is_400_not_500() -> None:
    r = CLIENT.post("/optimize", json={
        "network": {"nodes": [], "lanes": [{"id": "l1"}, {"id": "l2"}, {"id": "l3"}]},
        "constraints": {"maxNetworkLanes": 2},
    })
    assert r.status_code == 400, r.text
    assert "Network lanes" in r.json()["detail"]


def test_internal_error_is_logged_but_not_returned(monkeypatch) -> None:
    def boom(payload):
        raise KeyError("internal-secret-path")

    monkeypatch.setattr(main, "solve_optimize", boom)
    r = CLIENT.post("/optimize", json={"network": {"nodes": []}, "constraints": {}})
    assert r.status_code == 500
    assert "internal-secret-path" not in r.text
    assert "logged on the server" in r.json()["detail"]


def test_solver_limit_error_is_503(monkeypatch) -> None:
    def boom(payload):
        raise RuntimeError("Solver time limit (1s) reached before any solution was proven.")

    monkeypatch.setattr(main, "solve_optimize", boom)
    r = CLIENT.post("/optimize", json={"network": {"nodes": []}, "constraints": {}})
    assert r.status_code == 503
    assert "time limit" in r.json()["detail"]


def test_concurrency_slots_return_429_when_full(monkeypatch) -> None:
    monkeypatch.setattr(main, "SOLVE_QUEUE_WAIT_S", 0.0)
    for _ in range(main.MAX_CONCURRENT_SOLVES):
        main._SOLVE_SLOTS.acquire()
    try:
        r = CLIENT.post("/optimize", json={"network": {"nodes": []}, "constraints": {}})
        assert r.status_code == 429
        assert r.headers.get("retry-after") == "2"
    finally:
        for _ in range(main.MAX_CONCURRENT_SOLVES):
            main._SOLVE_SLOTS.release()


def test_validate_without_deep_never_takes_a_solve_slot(monkeypatch) -> None:
    monkeypatch.setattr(main, "SOLVE_QUEUE_WAIT_S", 0.0)
    for _ in range(main.MAX_CONCURRENT_SOLVES):
        main._SOLVE_SLOTS.acquire()
    try:
        r = CLIENT.post("/optimize/validate", json={
            "network": {"nodes": [], "lanes": []},
            "constraints": {},
        })
        assert r.status_code == 200, r.text
        assert r.json()["blocking"] is True
    finally:
        for _ in range(main.MAX_CONCURRENT_SOLVES):
            main._SOLVE_SLOTS.release()
