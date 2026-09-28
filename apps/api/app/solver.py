"""
Facility open/close MIP via PuLP.

Prefers HiGHS (highspy) when available, else PuLP's bundled CBC.
OR-Tools CP-SAT is optional and not required for this MVP.
"""

from __future__ import annotations

import math
import re
from typing import Any

import pulp

MILES_PER_UNIT = 12.0


def _dist_miles(a: dict[str, Any], b: dict[str, Any]) -> float:
    if (
        a.get("lat") is not None
        and a.get("lng") is not None
        and b.get("lat") is not None
        and b.get("lng") is not None
    ):
        lat1, lon1 = math.radians(float(a["lat"])), math.radians(float(a["lng"]))
        lat2, lon2 = math.radians(float(b["lat"])), math.radians(float(b["lng"]))
        dlat, dlon = lat2 - lat1, lon2 - lon1
        h = (
            math.sin(dlat / 2) ** 2
            + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
        )
        return 3958.8 * 2 * math.asin(min(1.0, math.sqrt(h)))
    ax, ay = float(a.get("x", 0)), float(a.get("y", 0))
    bx, by = float(b.get("x", 0)), float(b.get("y", 0))
    return math.hypot(ax - bx, ay - by) * MILES_PER_UNIT


def _parse_volume(capacity: str | None, fallback: float = 1000.0) -> float:
    if not capacity:
        return fallback
    m = re.search(r"([\d.]+)", str(capacity).replace(",", ""))
    if not m:
        return fallback
    v = float(m.group(1))
    if "k" in str(capacity).lower():
        v *= 1000
    return v


def _parse_money(raw: Any, fallback: float) -> float:
    if raw is None:
        return fallback
    m = re.search(r"([\d.]+)", str(raw).replace(",", ""))
    return float(m.group(1)) if m else fallback


def _pick_solver(log: list[str]) -> tuple[Any, str]:
    available = set(pulp.listSolvers(onlyAvailable=True))
    if "HiGHS" in available:
        log.append("Solver: PuLP + HiGHS (highspy).")
        return pulp.HiGHS(msg=False), "pulp-highs"
    if "PULP_CBC_CMD" in available:
        log.append("Solver: PuLP + CBC (bundled).")
        return pulp.PULP_CBC_CMD(msg=False, timeLimit=30), "pulp-cbc"
    raise RuntimeError(
        "No MIP solver available. Install highspy (pip install highspy) "
        "or ensure PuLP CBC binaries are present. "
        "Optional alternative: Google OR-Tools CP-SAT (not wired in this MVP)."
    )


def _facility_status(f: dict[str, Any], cmap: dict[str, Any]) -> str:
    c = cmap.get(f["id"], {})
    status = c.get("status")
    if status is None:
        return "candidate" if f.get("kind") == "candidate" else "open"
    return status


def _open_cost(fid: str, fac_by_id: dict[str, Any], cmap: dict[str, Any]) -> float:
    c = cmap.get(fid, {})
    f = fac_by_id[fid]
    status = _facility_status(f, cmap)
    if status == "open":
        return 0.0
    return float(c.get("fixedCapexM") or (6 if f.get("kind") == "candidate" else 4))


def solve_optimize(payload: dict[str, Any]) -> dict[str, Any]:
    """
    MIP: open/close facilities, assign demand within service radius.

    Objective: minimize fixed CapEx + transport (distance × volume proxy)
    subject to CapEx budget, max facilities, forced closed, with uncovered
    demand heavily penalized (soft service target).
    """
    log: list[str] = ["Flowform MIP optimize (PuLP)."]
    network = payload.get("network") or {}
    constraints = payload.get("constraints") or {}
    nodes = list(network.get("nodes") or [])
    demand_volume = dict(network.get("demandVolume") or {})

    facilities = [n for n in nodes if n.get("kind") in ("dc", "plant", "candidate")]
    demands = [n for n in nodes if n.get("kind") == "demand"]
    if not facilities:
        raise ValueError("No facility nodes (dc/plant/candidate) in network.")
    if not demands:
        raise ValueError("No demand nodes in network.")

    fac_by_id = {f["id"]: f for f in facilities}
    cmap = {f["nodeId"]: f for f in (constraints.get("facilities") or [])}

    radius = float(constraints.get("serviceRadiusMiles", 250))
    budget = float(constraints.get("capexBudgetM", 30))
    max_fac = int(constraints.get("maxFacilities", max(3, len(facilities))))
    target_pct = float(constraints.get("serviceTargetPct", 95))

    dem_loads: list[tuple[dict[str, Any], float]] = []
    for d in demands:
        vol = float(demand_volume.get(d["id"], _parse_volume(d.get("capacity"))))
        dem_loads.append((d, max(0.0, vol)))
    total_demand = sum(v for _, v in dem_loads) or 1.0

    edges: list[tuple[str, str, float]] = []
    for f in facilities:
        for d, _vol in dem_loads:
            miles = _dist_miles(f, d)
            if miles <= radius + 1e-6:
                edges.append((f["id"], d["id"], miles))

    log.append(
        f"Model: {len(facilities)} facilities · {len(demands)} demand · "
        f"{len(edges)} reachability arcs · radius {radius} mi · "
        f"budget ${budget}M · max {max_fac}."
    )

    solver, solver_name = _pick_solver(log)

    prob = pulp.LpProblem("flowform_footprint", pulp.LpMinimize)
    y = pulp.LpVariable.dicts("open", [f["id"] for f in facilities], cat="Binary")
    x = pulp.LpVariable.dicts(
        "flow",
        [(fi, di) for fi, di, _ in edges],
        lowBound=0,
        cat="Continuous",
    )
    uncovered = pulp.LpVariable.dicts(
        "uncov",
        [d["id"] for d, _ in dem_loads],
        lowBound=0,
        cat="Continuous",
    )

    for f in facilities:
        if _facility_status(f, cmap) == "closed":
            prob += y[f["id"]] == 0, f"forced_closed_{f['id']}"

    dem_map = {d["id"]: vol for d, vol in dem_loads}
    for d_id, vol in dem_map.items():
        inbound = [x[(fi, di)] for fi, di, _ in edges if di == d_id]
        if inbound:
            prob += pulp.lpSum(inbound) + uncovered[d_id] == vol, f"dem_{d_id}"
        else:
            prob += uncovered[d_id] == vol, f"dem_isol_{d_id}"

    for fi, di, _miles in edges:
        prob += x[(fi, di)] <= dem_map[di] * y[fi], f"link_{fi}_{di}"

    for f in facilities:
        c = cmap.get(f["id"], {})
        cap_max = float(c.get("capacityMax") or 1e9)
        outbound = [x[(fi, di)] for fi, di, _ in edges if fi == f["id"]]
        if outbound:
            prob += pulp.lpSum(outbound) <= cap_max * y[f["id"]], f"cap_{f['id']}"

    costs = {f["id"]: _open_cost(f["id"], fac_by_id, cmap) for f in facilities}
    prob += pulp.lpSum(costs[fid] * y[fid] for fid in y) <= budget, "capex_budget"
    prob += pulp.lpSum(y[fid] for fid in y) <= max_fac, "max_facilities"

    transport = pulp.lpSum(miles * 0.001 * x[(fi, di)] for fi, di, miles in edges)
    capex_obj = pulp.lpSum(costs[fid] * y[fid] for fid in y)
    uncov_pen = pulp.lpSum(50.0 * uncovered[d_id] for d_id in uncovered)
    keep_bonus = pulp.lpSum(
        -0.05 * y[f["id"]]
        for f in facilities
        if _facility_status(f, cmap) == "open"
    )
    prob += transport + capex_obj + uncov_pen + keep_bonus

    status_code = prob.solve(solver)
    status_name = pulp.LpStatus.get(status_code, str(status_code))
    log.append(f"Solve status: {status_name}.")

    open_ids = [
        fid for fid in y if pulp.value(y[fid]) is not None and pulp.value(y[fid]) > 0.5
    ]
    seed_open = [f["id"] for f in facilities if _facility_status(f, cmap) == "open"]
    opened_ids = [i for i in open_ids if i not in seed_open]
    closed_ids = [i for i in seed_open if i not in open_ids]
    kept_open = [i for i in open_ids if i in seed_open]

    flows = []
    for fi, di, miles in edges:
        val = pulp.value(x[(fi, di)]) or 0.0
        if val > 1e-4:
            flows.append(
                {
                    "from": fi,
                    "to": di,
                    "volume": round(float(val), 2),
                    "miles": round(miles, 1),
                }
            )

    uncovered_total = sum(float(pulp.value(uncovered[d_id]) or 0.0) for d_id in uncovered)
    covered = total_demand - uncovered_total
    service_pct = max(0.0, min(100.0, (covered / total_demand) * 100))
    capex_used = sum(costs[i] for i in open_ids)

    ref = payload.get("reference") or {}
    ref_kpis = ref.get("kpis") or {}
    ref_cost = _parse_money((ref_kpis.get("cost") or {}).get("value"), 48.2)
    ref_co2 = _parse_money(
        str((ref_kpis.get("co2") or {}).get("value", "12.4")).replace("kt", ""),
        12.4,
    )
    transport_save = min(
        6.0,
        max(
            -3.0,
            (service_pct - 94.0) * 0.35
            + len(closed_ids) * 0.4
            - len(opened_ids) * 0.15,
        ),
    )
    cost_m = max(20.0, ref_cost - transport_save + capex_used * 0.12 * 0.25)
    co2_kt = max(4.0, ref_co2 - len(opened_ids) * 0.35 - len(closed_ids) * 0.15)

    log.append(
        f"Done: {len(open_ids)} open · CapEx ${capex_used:.1f}M / ${budget}M · "
        f"service {service_pct:.1f}% (target {target_pct}%) · flows {len(flows)}."
    )
    if service_pct + 0.05 < target_pct:
        log.append(
            f"Note: service {service_pct:.1f}% below target {target_pct}% "
            "(radius / budget / max facilities binding)."
        )

    return {
        "ok": True,
        "solver": solver_name,
        "status": status_name,
        "openedIds": opened_ids,
        "closedIds": closed_ids,
        "keptOpenIds": kept_open,
        "openIds": open_ids,
        "flows": flows,
        "kpis": {
            "servicePct": round(service_pct, 1),
            "capexUsedM": round(capex_used, 1),
            "costM": round(cost_m, 1),
            "co2Kt": round(co2_kt, 1),
            "uncoveredDemand": round(uncovered_total, 1),
            "targetPct": target_pct,
        },
        "log": log,
    }
