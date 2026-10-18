"""
Two-stage scenario-tree network design (stochastic / robust).

First stage: shared open/close binaries (here-and-now).
Second stage: flows (+ uncovered) per demand/cost scenario.

Objectives:
  - expected:   fixed + Σ_s p_s · variable_s
  - minimax:    min z  s.t. z ≥ fixed + variable_s  ∀s
  - cvar_lite:  (1−α)·E[total_s] + α·max_s total_s

Also computes a wait-and-see bound (perfect information per scenario)
and an EVPI-ish gap: here-and-now expected cost − E[wait-and-see].
"""

from __future__ import annotations

import time
from typing import Any

import pulp

from .solver import (
    UNCOVERED_PENALTY,
    _facility_status,
    _open_capex,
    _open_opex,
    _parse_volume,
    _pick_solver,
    _safe_name,
    _transport_unit_cost,
    _lane_cost_map,
    resolve_cost_scale,
)


def _as_float(v: Any, default: float = 0.0) -> float:
    try:
        if v is None:
            return default
        return float(v)
    except (TypeError, ValueError):
        return default


def _normalize_scenarios(
    raw: list[dict[str, Any]],
    base_demand: dict[str, float],
) -> list[dict[str, Any]]:
    if not raw:
        raise ValueError("Provide 2–5 scenarios with probabilities.")
    if len(raw) < 2 or len(raw) > 5:
        raise ValueError(f"Need 2–5 scenarios, got {len(raw)}.")

    scenarios: list[dict[str, Any]] = []
    for i, s in enumerate(raw):
        sid = str(s.get("id") or f"s{i}")
        name = str(s.get("name") or f"Scenario {i + 1}")
        p = max(0.0, _as_float(s.get("probability"), 0.0))
        demand_scale = max(0.0, _as_float(s.get("demandScale"), 1.0))
        cost_scale = max(0.0, _as_float(s.get("costScale"), 1.0))
        override = s.get("demandVolume")
        if isinstance(override, dict) and override:
            dem = {str(k): max(0.0, _as_float(v, 0.0)) for k, v in override.items()}
            # Fill missing customers from scaled base
            for cid, base in base_demand.items():
                dem.setdefault(cid, base * demand_scale)
        else:
            dem = {cid: vol * demand_scale for cid, vol in base_demand.items()}
        scenarios.append(
            {
                "id": sid,
                "name": name,
                "probability": p,
                "demandScale": demand_scale,
                "costScale": cost_scale,
                "demandVolume": dem,
            }
        )

    total_p = sum(s["probability"] for s in scenarios)
    if total_p <= 1e-12:
        eq = 1.0 / len(scenarios)
        for s in scenarios:
            s["probability"] = eq
    else:
        for s in scenarios:
            s["probability"] = s["probability"] / total_p
    return scenarios


def _build_arcs(
    fac_by_id: dict[str, dict[str, Any]],
    dem_nodes: dict[str, dict[str, Any]],
    cust_ids: list[str],
    lane_costs: dict[tuple[str, str], float],
    radius: float,
    log: list[str],
    per_mile_m: float | None = None,
) -> tuple[list[tuple[str, str]], dict[tuple[str, str], float], dict[tuple[str, str], float]]:
    arcs: list[tuple[str, str, float, float]] = []
    for fid, f in fac_by_id.items():
        for cid in cust_ids:
            dnode = dem_nodes[cid]
            cost, miles = _transport_unit_cost(f, dnode, lane_costs, per_mile_m)
            key = (fid, cid)
            within = miles <= radius + 1e-6 or key in lane_costs
            if within:
                arcs.append((fid, cid, cost, miles))
    if not arcs:
        log.append(f"No arcs within radius {radius}; relaxing to all facility→customer pairs.")
        for fid, f in fac_by_id.items():
            for cid in cust_ids:
                dnode = dem_nodes[cid]
                cost, miles = _transport_unit_cost(f, dnode, lane_costs, per_mile_m)
                arcs.append((fid, cid, cost, miles))
    arc_keys = [(a[0], a[1]) for a in arcs]
    unit_cost = {(a[0], a[1]): a[2] for a in arcs}
    miles_map = {(a[0], a[1]): a[3] for a in arcs}
    return arc_keys, unit_cost, miles_map


def _solve_wait_and_see_one(
    *,
    scenario: dict[str, Any],
    fac_by_id: dict[str, dict[str, Any]],
    cmap: dict[str, Any],
    forced_open: dict[str, int],
    decidable_ids: list[str],
    arc_keys: list[tuple[str, str]],
    unit_cost: dict[tuple[str, str], float],
    cap: dict[str, float],
    opex: dict[str, float],
    capex: dict[str, float],
    cust_ids: list[str],
    budget: float,
    max_fac: int,
    hard_service: bool,
    solver: Any,
    uncovered_penalty: float = UNCOVERED_PENALTY,
) -> dict[str, Any]:
    """Deterministic optimize for one scenario (perfect information)."""
    dem = scenario["demandVolume"]
    cscale = scenario["costScale"]
    prob = pulp.LpProblem(
        _safe_name("ws", scenario["id"]), pulp.LpMinimize
    )
    open_v = {
        fid: pulp.LpVariable(_safe_name("ws_o", scenario["id"], fid), cat="Binary")
        for fid in decidable_ids
    }
    for fid, fo in forced_open.items():
        if fo and fid in open_v:
            prob += open_v[fid] == 1, _safe_name("ws_force", scenario["id"], fid)

    x = {
        (fid, cid): pulp.LpVariable(
            _safe_name("ws_x", scenario["id"], fid, cid), lowBound=0, cat="Continuous"
        )
        for (fid, cid) in arc_keys
    }
    if hard_service:
        uncovered = None
    else:
        uncovered = {
            cid: pulp.LpVariable(
                _safe_name("ws_u", scenario["id"], cid), lowBound=0, cat="Continuous"
            )
            for cid in cust_ids
        }

    for cid in cust_ids:
        inbound = [x[(fid, cid)] for (fid, c) in arc_keys if c == cid]
        d = dem.get(cid, 0.0)
        if hard_service:
            if inbound:
                prob += pulp.lpSum(inbound) == d, _safe_name("ws_dem", scenario["id"], cid)
            elif d > 1e-9:
                prob += 0 == 1, _safe_name("ws_isol", scenario["id"], cid)
        else:
            assert uncovered is not None
            if inbound:
                prob += (
                    pulp.lpSum(inbound) + uncovered[cid] == d,
                    _safe_name("ws_dem", scenario["id"], cid),
                )
            else:
                prob += uncovered[cid] == d, _safe_name("ws_isol", scenario["id"], cid)

    for fid in decidable_ids:
        thr = pulp.lpSum(x[(fid, cid)] for (f, cid) in arc_keys if f == fid)
        prob += thr <= cap[fid] * open_v[fid], _safe_name("ws_cap", scenario["id"], fid)

    prob += pulp.lpSum(open_v[fid] for fid in decidable_ids) <= max_fac, _safe_name(
        "ws_maxf", scenario["id"]
    )
    prob += (
        pulp.lpSum(capex[fid] * open_v[fid] for fid in decidable_ids) <= budget,
        _safe_name("ws_bud", scenario["id"]),
    )

    fixed = pulp.lpSum(
        (capex[fid] + opex[fid]) * open_v[fid] for fid in decidable_ids
    )
    transport = pulp.lpSum(
        cscale * unit_cost[(fid, cid)] * x[(fid, cid)] for (fid, cid) in arc_keys
    )
    if uncovered is not None:
        uncov = uncovered_penalty * pulp.lpSum(uncovered[cid] for cid in cust_ids)
    else:
        uncov = 0
    prob += fixed + transport + uncov
    status = prob.solve(solver)
    status_name = pulp.LpStatus.get(status, str(status))

    def _val(var: Any) -> float:
        try:
            v = pulp.value(var)
            return float(v) if v is not None else 0.0
        except Exception:
            return 0.0

    if status_name == "Infeasible":
        return {
            "ok": False,
            "status": "Infeasible",
            "costM": None,
            "openIds": [],
            "capexM": 0.0,
            "opexM": 0.0,
            "transportM": 0.0,
            "uncoveredPenaltyM": 0.0,
            "uncoveredDemand": 0.0,
            "servicePct": 0.0,
        }

    open_ids = [fid for fid in decidable_ids if _val(open_v[fid]) > 0.5]
    transport_m = sum(
        cscale * unit_cost[(fid, cid)] * _val(x[(fid, cid)]) for (fid, cid) in arc_keys
    )
    capex_m = sum(capex[fid] for fid in open_ids)
    opex_m = sum(opex[fid] for fid in open_ids)
    uncov_dem = 0.0
    uncov_pen = 0.0
    if uncovered is not None:
        uncov_dem = sum(_val(uncovered[cid]) for cid in cust_ids)
        uncov_pen = uncovered_penalty * uncov_dem
    total_dem = sum(dem.values()) or 1.0
    served = total_dem - uncov_dem
    return {
        "ok": True,
        "status": status_name,
        "costM": round(capex_m + opex_m + transport_m + uncov_pen, 6),
        "openIds": open_ids,
        "capexM": round(capex_m, 6),
        "opexM": round(opex_m, 6),
        "transportM": round(transport_m, 6),
        "uncoveredPenaltyM": round(uncov_pen, 6),
        "uncoveredDemand": round(uncov_dem, 2),
        "servicePct": round(100.0 * served / total_dem, 2),
    }


def solve_stochastic(payload: dict[str, Any]) -> dict[str, Any]:
    t0 = time.perf_counter()
    log: list[str] = ["Flowform stochastic scenario-tree MIP (PuLP)."]

    network = payload.get("network") or {}
    constraints = payload.get("constraints") or {}
    tree = payload.get("scenarioTree") or payload.get("scenarios") or {}
    if isinstance(tree, list):
        tree = {"scenarios": tree, "objective": payload.get("objective", "expected")}

    objective = str(
        tree.get("objective") or payload.get("objective") or "expected"
    ).lower()
    if objective not in ("expected", "minimax", "cvar_lite"):
        objective = "expected"
    cvar_alpha = _as_float(tree.get("cvarAlpha") or payload.get("cvarAlpha"), 0.3)
    cvar_alpha = max(0.0, min(1.0, cvar_alpha))
    compute_evpi = bool(tree.get("computeEvpi", payload.get("computeEvpi", True)))

    nodes = list(network.get("nodes") or [])
    lanes = list(network.get("lanes") or [])
    demand_volume = {
        str(k): float(v) for k, v in dict(network.get("demandVolume") or {}).items()
    }
    lane_costs = _lane_cost_map(lanes)
    cost_scale = resolve_cost_scale(payload)
    off_lane_m = cost_scale["offLaneRateM"]
    uncovered_penalty = cost_scale["uncoveredPenaltyM"]
    cmap = {f["nodeId"]: f for f in (constraints.get("facilities") or []) if f.get("nodeId")}

    demands = [n for n in nodes if n.get("kind") == "demand"]
    if not demands:
        raise ValueError("No demand nodes in network.")
    for d in demands:
        demand_volume.setdefault(str(d["id"]), _parse_volume(d.get("capacity"), 1000.0))

    fac_kinds = ("dc", "candidate", "plant")
    facilities = [n for n in nodes if n.get("kind") in fac_kinds]
    if not facilities:
        raise ValueError("No facility nodes (dc/plant/candidate) in network.")
    fac_by_id = {str(f["id"]): f for f in facilities}

    scenarios = _normalize_scenarios(list(tree.get("scenarios") or []), demand_volume)

    radius = float(constraints.get("serviceRadiusMiles", 400))
    budget = float(constraints.get("capexBudgetM", 30))
    max_fac = int(constraints.get("maxFacilities", max(3, len(fac_by_id))))
    hard_service = bool(constraints.get("hardServiceConstraints", False))

    dem_nodes = {str(d["id"]): d for d in demands}
    cust_ids = [str(d["id"]) for d in demands]

    # Decidable opens: candidates / closed / all DCs; force-open status=open non-candidates
    decidable_ids: list[str] = []
    forced_open: dict[str, int] = {}
    cap: dict[str, float] = {}
    opex: dict[str, float] = {}
    capex: dict[str, float] = {}
    for fid, f in fac_by_id.items():
        st = _facility_status(f, cmap)
        c = cmap.get(fid, {})
        cap_max = c.get("capacityMax")
        cap[fid] = float(cap_max) if cap_max is not None else _parse_volume(
            f.get("capacity"), 10000.0
        )
        opex[fid] = _open_opex(fid, fac_by_id, cmap)
        capex[fid] = _open_capex(fid, fac_by_id, cmap)
        if st == "open" and f.get("kind") != "candidate":
            forced_open[fid] = 1
            decidable_ids.append(fid)
        elif st in ("closed", "candidate") or f.get("kind") == "candidate":
            forced_open[fid] = 0
            decidable_ids.append(fid)
        else:
            # open plants etc. still decidable but forced
            forced_open[fid] = 1 if st == "open" else 0
            decidable_ids.append(fid)

    arc_keys, unit_cost, miles_map = _build_arcs(
        fac_by_id, dem_nodes, cust_ids, lane_costs, radius, log, off_lane_m
    )

    log.append(
        f"Objective={objective}"
        + (f" α={cvar_alpha:.2f}" if objective == "cvar_lite" else "")
        + f" · scenarios={len(scenarios)} · facilities={len(decidable_ids)} · arcs={len(arc_keys)}."
    )
    for s in scenarios:
        log.append(
            f"  · {s['id']} p={s['probability']:.3f} demandScale={s['demandScale']:.2f} "
            f"costScale={s['costScale']:.2f} totalDem={sum(s['demandVolume'].values()):.0f}"
        )

    solver, solver_name = _pick_solver(log)
    prob = pulp.LpProblem("flowform_stochastic", pulp.LpMinimize)

    open_v = {
        fid: pulp.LpVariable(_safe_name("open", fid), cat="Binary")
        for fid in decidable_ids
    }
    for fid, fo in forced_open.items():
        if fo:
            prob += open_v[fid] == 1, _safe_name("force_open", fid)

    x: dict[tuple[str, str, str], Any] = {
        (fid, cid, s["id"]): pulp.LpVariable(
            _safe_name("x", fid, cid, s["id"]), lowBound=0, cat="Continuous"
        )
        for (fid, cid) in arc_keys
        for s in scenarios
    }
    uncovered: dict[tuple[str, str], Any] | None
    if hard_service:
        uncovered = None
        log.append("Hard service ON — uncovered forbidden in every scenario.")
    else:
        uncovered = {
            (cid, s["id"]): pulp.LpVariable(
                _safe_name("u", cid, s["id"]), lowBound=0, cat="Continuous"
            )
            for cid in cust_ids
            for s in scenarios
        }

    for s in scenarios:
        sid = s["id"]
        dem = s["demandVolume"]
        for cid in cust_ids:
            inbound = [x[(fid, cid, sid)] for (fid, c) in arc_keys if c == cid]
            d = dem.get(cid, 0.0)
            if hard_service:
                if inbound:
                    prob += pulp.lpSum(inbound) == d, _safe_name("dem", cid, sid)
                elif d > 1e-9:
                    prob += 0 == 1, _safe_name("dem_isol", cid, sid)
            else:
                assert uncovered is not None
                if inbound:
                    prob += (
                        pulp.lpSum(inbound) + uncovered[(cid, sid)] == d,
                        _safe_name("dem", cid, sid),
                    )
                else:
                    prob += uncovered[(cid, sid)] == d, _safe_name("dem_isol", cid, sid)

        for fid in decidable_ids:
            thr = pulp.lpSum(
                x[(fid, cid, sid)] for (f, cid) in arc_keys if f == fid
            )
            prob += thr <= cap[fid] * open_v[fid], _safe_name("cap", fid, sid)

    prob += pulp.lpSum(open_v[fid] for fid in decidable_ids) <= max_fac, "max_facilities"
    prob += (
        pulp.lpSum(capex[fid] * open_v[fid] for fid in decidable_ids) <= budget,
        "capex_budget",
    )

    fixed_expr = pulp.lpSum(
        (capex[fid] + opex[fid]) * open_v[fid] for fid in decidable_ids
    )

    transport_by_s: dict[str, Any] = {}
    uncov_by_s: dict[str, Any] = {}
    total_by_s: dict[str, Any] = {}
    for s in scenarios:
        sid = s["id"]
        cscale = s["costScale"]
        transport_by_s[sid] = pulp.lpSum(
            cscale * unit_cost[(fid, cid)] * x[(fid, cid, sid)]
            for (fid, cid) in arc_keys
        )
        if uncovered is not None:
            uncov_by_s[sid] = uncovered_penalty * pulp.lpSum(
                uncovered[(cid, sid)] for cid in cust_ids
            )
        else:
            uncov_by_s[sid] = 0
        total_by_s[sid] = fixed_expr + transport_by_s[sid] + uncov_by_s[sid]

    if objective == "expected":
        expected_var = pulp.lpSum(
            s["probability"] * (transport_by_s[s["id"]] + uncov_by_s[s["id"]])
            for s in scenarios
        )
        prob += fixed_expr + expected_var
    elif objective == "minimax":
        z = pulp.LpVariable("robust_z", lowBound=0, cat="Continuous")
        for s in scenarios:
            prob += z >= total_by_s[s["id"]], _safe_name("mm", s["id"])
        prob += z
    else:  # cvar_lite
        z = pulp.LpVariable("cvar_worst", lowBound=0, cat="Continuous")
        for s in scenarios:
            prob += z >= total_by_s[s["id"]], _safe_name("cv", s["id"])
        expected_total = pulp.lpSum(
            s["probability"] * total_by_s[s["id"]] for s in scenarios
        )
        prob += (1.0 - cvar_alpha) * expected_total + cvar_alpha * z

    status = prob.solve(solver)
    status_name = pulp.LpStatus.get(status, str(status))
    solve_seconds = round(time.perf_counter() - t0, 3)

    def _val(var: Any) -> float:
        try:
            v = pulp.value(var)
            return float(v) if v is not None else 0.0
        except Exception:
            return 0.0

    if status_name == "Infeasible":
        log.append("Stochastic model infeasible.")
        return {
            "ok": False,
            "solver": solver_name,
            "status": "Infeasible",
            "model": "stochastic-scenario-tree-v1",
            "objective": objective,
            "cvarAlpha": cvar_alpha if objective == "cvar_lite" else None,
            "solveSeconds": solve_seconds,
            "openedIds": [],
            "closedIds": list(decidable_ids),
            "firstStage": {"openIds": [], "capexM": 0.0, "opexM": 0.0},
            "scenarios": [],
            "objectiveValueM": 0.0,
            "expectedCostM": 0.0,
            "worstCostM": 0.0,
            "evpi": None,
            "kpis": {"expectedCostM": 0.0, "worstCostM": 0.0, "scenarioCount": len(scenarios)},
            "log": log,
            "infeasibilityReport": {
                "status": "Infeasible",
                "summary": "Stochastic scenario-tree model infeasible.",
                "hints": [
                    {
                        "code": "STOCHASTIC_INFEASIBLE",
                        "severity": "error",
                        "message": "No shared open set covers all scenarios under current constraints.",
                        "hint": "Relax radius/budget, lower surge demand, or disable hard service.",
                    }
                ],
                "method": "status-only",
            },
        }

    open_ids = [fid for fid in decidable_ids if _val(open_v[fid]) > 0.5]
    closed_ids = [fid for fid in decidable_ids if fid not in open_ids]
    first_capex = sum(capex[fid] for fid in open_ids)
    first_opex = sum(opex[fid] for fid in open_ids)
    fixed_m = first_capex + first_opex

    scenario_rows: list[dict[str, Any]] = []
    costs_for_expect: list[float] = []
    for s in scenarios:
        sid = s["id"]
        cscale = s["costScale"]
        flows: list[dict[str, Any]] = []
        transport_m = 0.0
        total_vol = 0.0
        for (fid, cid) in arc_keys:
            vol = _val(x[(fid, cid, sid)])
            if vol <= 1e-6:
                continue
            tc = cscale * unit_cost[(fid, cid)] * vol
            transport_m += tc
            total_vol += vol
            flows.append(
                {
                    "from": fid,
                    "to": cid,
                    "volume": round(vol, 2),
                    "miles": round(miles_map[(fid, cid)], 1),
                    "unitCost": round(cscale * unit_cost[(fid, cid)], 6),
                    "transportCostM": round(tc, 6),
                    "echelon": "facility-customer",
                }
            )
        flows.sort(key=lambda r: -r["volume"])
        uncov_dem = 0.0
        uncov_pen = 0.0
        if uncovered is not None:
            uncov_dem = sum(_val(uncovered[(cid, sid)]) for cid in cust_ids)
            uncov_pen = uncovered_penalty * uncov_dem
        total_dem = sum(s["demandVolume"].values()) or 1.0
        served = total_dem - uncov_dem
        total_cost = fixed_m + transport_m + uncov_pen
        costs_for_expect.append(total_cost)
        scenario_rows.append(
            {
                "id": sid,
                "name": s["name"],
                "probability": round(s["probability"], 6),
                "demandScale": s["demandScale"],
                "costScale": s["costScale"],
                "capexM": round(first_capex, 6),
                "opexM": round(first_opex, 6),
                "transportM": round(transport_m, 6),
                "uncoveredPenaltyM": round(uncov_pen, 6),
                "uncoveredDemand": round(uncov_dem, 2),
                "totalCostM": round(total_cost, 6),
                "servicePct": round(100.0 * served / total_dem, 2),
                "openIds": list(open_ids),
                "flows": flows[:40],
                "flowsSummary": {
                    "arcCount": len(flows),
                    "totalVolume": round(total_vol, 2),
                    "topFlows": flows[:8],
                },
            }
        )

    expected_cost = sum(
        s["probability"] * row["totalCostM"]
        for s, row in zip(scenarios, scenario_rows)
    )
    worst_cost = max((row["totalCostM"] for row in scenario_rows), default=0.0)
    if objective == "expected":
        obj_value = expected_cost
    elif objective == "minimax":
        obj_value = worst_cost
    else:
        obj_value = (1.0 - cvar_alpha) * expected_cost + cvar_alpha * worst_cost

    # Wait-and-see + EVPI
    evpi_block: dict[str, Any] | None = None
    ws_rows: list[dict[str, Any]] = []
    if compute_evpi:
        ws_expected = 0.0
        ws_ok = True
        for s in scenarios:
            ws = _solve_wait_and_see_one(
                scenario=s,
                fac_by_id=fac_by_id,
                cmap=cmap,
                forced_open=forced_open,
                decidable_ids=decidable_ids,
                arc_keys=arc_keys,
                unit_cost=unit_cost,
                cap=cap,
                opex=opex,
                capex=capex,
                cust_ids=cust_ids,
                budget=budget,
                max_fac=max_fac,
                hard_service=hard_service,
                solver=solver,
                uncovered_penalty=uncovered_penalty,
            )
            ws_rows.append(
                {
                    "id": s["id"],
                    "name": s["name"],
                    "probability": round(s["probability"], 6),
                    "ok": ws["ok"],
                    "costM": ws["costM"],
                    "openIds": ws["openIds"],
                    "servicePct": ws["servicePct"],
                }
            )
            if not ws["ok"] or ws["costM"] is None:
                ws_ok = False
            else:
                ws_expected += s["probability"] * float(ws["costM"])

        if ws_ok:
            gap = max(0.0, expected_cost - ws_expected)
            # Opens that appear in every wait-and-see solution
            ws_sets = [set(r["openIds"]) for r in ws_rows if r["ok"]]
            stable_ws = set.intersection(*ws_sets) if ws_sets else set()
            first_set = set(open_ids)
            evpi_block = {
                "hereAndNowExpectedM": round(expected_cost, 6),
                "waitAndSeeExpectedM": round(ws_expected, 6),
                "evpiGapM": round(gap, 6),
                "note": (
                    "EVPI-ish ≈ E[here-and-now cost] − E[wait-and-see]. "
                    "Wait-and-see re-optimizes opens per scenario (perfect information)."
                ),
                "waitAndSeeByScenario": ws_rows,
                "stableWaitAndSeeOpenIds": sorted(stable_ws),
                "robustOpenIds": sorted(first_set),
                "opensOnlyInRobust": sorted(first_set - stable_ws),
                "opensOnlyInWaitAndSeeStable": sorted(stable_ws - first_set),
            }
            log.append(
                f"EVPI-ish gap ${gap:.3f}M (HN ${expected_cost:.3f}M − WS ${ws_expected:.3f}M)."
            )
        else:
            log.append("Wait-and-see infeasible for at least one scenario; EVPI skipped.")
            evpi_block = {
                "hereAndNowExpectedM": round(expected_cost, 6),
                "waitAndSeeExpectedM": None,
                "evpiGapM": None,
                "note": "Wait-and-see infeasible for at least one scenario.",
                "waitAndSeeByScenario": ws_rows,
            }

    open_facilities = [
        {
            "id": fid,
            "name": fac_by_id[fid].get("name", fid),
            "kind": fac_by_id[fid].get("kind"),
            "fixedCapexM": round(capex[fid], 4),
            "fixedOpexM": round(opex[fid], 4),
            "capacityMax": round(cap[fid], 2),
            "throughput": round(
                sum(
                    scenarios[i]["probability"]
                    * sum(
                        _val(x[(fid, cid, scenarios[i]["id"])])
                        for (f, cid) in arc_keys
                        if f == fid
                    )
                    for i in range(len(scenarios))
                ),
                2,
            ),
        }
        for fid in open_ids
    ]

    solve_seconds = round(time.perf_counter() - t0, 3)
    log.append(
        f"Done · status={status_name} · opens={len(open_ids)} · "
        f"obj=${obj_value:.3f}M · E[cost]=${expected_cost:.3f}M · "
        f"worst=${worst_cost:.3f}M · {solve_seconds}s."
    )

    return {
        "ok": True,
        "solver": solver_name,
        "status": status_name,
        "model": "stochastic-scenario-tree-v1",
        "objective": objective,
        "cvarAlpha": cvar_alpha if objective == "cvar_lite" else None,
        "solveSeconds": solve_seconds,
        "openedIds": open_ids,
        "closedIds": closed_ids,
        "openIds": open_ids,
        "openFacilities": open_facilities,
        "firstStage": {
            "openIds": open_ids,
            "capexM": round(first_capex, 6),
            "opexM": round(first_opex, 6),
            "fixedCostM": round(fixed_m, 6),
        },
        "scenarios": scenario_rows,
        "objectiveValueM": round(obj_value, 6),
        "expectedCostM": round(expected_cost, 6),
        "worstCostM": round(worst_cost, 6),
        "evpi": evpi_block,
        "kpis": {
            "expectedCostM": round(expected_cost, 6),
            "worstCostM": round(worst_cost, 6),
            "objectiveValueM": round(obj_value, 6),
            "scenarioCount": len(scenarios),
            "openCount": len(open_ids),
            "evpiGapM": evpi_block.get("evpiGapM") if evpi_block else None,
            "servicePctMin": min((r["servicePct"] for r in scenario_rows), default=0.0),
        },
        "log": log,
    }
