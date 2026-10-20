"""Stress-pack MIP benchmark — times optimize and asserts feasibility."""

from __future__ import annotations

import os
import time

import pytest

from app.solver import solve_optimize

from .enterprise_payload import load_enterprise_pack, pack_to_optimize_payload

# Fail if cold solve exceeds this (HiGHS on stress-200 is typically <1s).
STRESS_TIMEOUT_S = float(os.environ.get("STRESS_TIMEOUT_S", "60"))


@pytest.mark.parametrize(
    "fixture_name,min_demand",
    [
        ("stress-120-demand.enterprise.json", 100),
        ("stress-200-demand.enterprise.json", 180),
    ],
)
def test_stress_pack_optimize_benchmark(fixture_name: str, min_demand: int):
    pack = load_enterprise_pack(fixture_name)
    payload = pack_to_optimize_payload(pack)
    demand_n = len(payload["network"]["demandVolume"])
    assert demand_n >= min_demand, f"expected ≥{min_demand} demand, got {demand_n}"

    t0 = time.perf_counter()
    body = solve_optimize(payload)
    wall_s = time.perf_counter() - t0

    assert body.get("ok") is True
    status = body.get("status") or ""
    assert status in ("Optimal", "Optimal Solution Found", "Not Solved") or body[
        "kpis"
    ]["servicePct"] >= 90, f"unexpected status {status}"

    # Unexpected infeasibility: service collapse or huge uncovered penalty
    bd = body["objectiveBreakdown"]
    assert body["kpis"]["servicePct"] >= 90, body["kpis"]
    assert bd["uncoveredPenaltyM"] < 1e6

    open_count = len(body.get("openIds") or [])
    assert open_count >= 1

    solve_s = float(body.get("solveSeconds") or wall_s)
    assert (
        solve_s <= STRESS_TIMEOUT_S
    ), f"solveSeconds {solve_s}s exceeded timeout {STRESS_TIMEOUT_S}s"
    assert wall_s <= STRESS_TIMEOUT_S + 30, f"wall {wall_s}s too slow (incl. duals)"

    # Record for pytest -s / CI logs
    print(
        f"\n[benchmark {fixture_name}] demand={demand_n} "
        f"objective={bd['totalM']:.4f} transport={bd['transportM']:.4f} "
        f"open={open_count} solveSeconds={solve_s:.3f} wall={wall_s:.3f}s "
        f"status={status} model={body.get('model')}"
    )


def test_stress_200_primary_benchmark_summary():
    """Primary depth-slice benchmark on stress-200 — single clear assert block."""
    pack = load_enterprise_pack("stress-200-demand.enterprise.json")
    payload = pack_to_optimize_payload(pack)
    body = solve_optimize(payload)

    assert body["ok"] is True
    assert body["model"] == "fixed-charge-multi-echelon-v1"
    assert body["status"] in ("Optimal", "Optimal Solution Found")
    assert body["solveSeconds"] <= STRESS_TIMEOUT_S
    assert len(body["openIds"]) >= 1
    assert body["objectiveBreakdown"]["totalM"] > 0
    assert body["kpis"]["servicePct"] >= 95
    assert any(f.get("echelon") == "dc→customer" for f in body["flows"])
