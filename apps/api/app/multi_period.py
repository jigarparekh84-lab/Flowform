"""
Multi-period CapEx-linked network design (NPV minimize).

Accepts CapEx roadmap events (open / expand / close) across Y0–Yn.
Modes:
  - force_timeline: apply each event in its stated year
  - choose_timing: choose year for each event in [earliest, latest] (or locked year)

Capacity in year t = cumulative opens/expands − closes through t.
Objective: minimize NPV of CapEx + OpEx + transport (+ uncovered penalty)
  NPV = Σ_t cost_t / (1+r)^t

Returns per-year open set, CapEx spend, flows summary, and total NPV.
"""

from __future__ import annotations

import time
from typing import Any

import pulp

from .solver import (
    _facility_status,
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


def _normalize_events(
    raw_events: list[dict[str, Any]],
    year_count: int,
    mode: str,
) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for i, e in enumerate(raw_events or []):
        kind = str(e.get("kind") or "open").lower()
        if kind not in ("open", "expand", "close"):
            kind = "open"
        year = int(e.get("year") if e.get("year") is not None else 0)
        year = max(0, min(year_count - 1, year))
        locked = bool(e.get("locked") or e.get("fixedYear") is not None)
        if e.get("fixedYear") is not None:
            year = max(0, min(year_count - 1, int(e["fixedYear"])))
            locked = True
        if mode == "force_timeline":
            locked = True
            earliest = latest = year
        else:
            earliest = int(
                e.get("earliestYear")
                if e.get("earliestYear") is not None
                else (year if locked else 0)
            )
            latest = int(
                e.get("latestYear")
                if e.get("latestYear") is not None
                else (year if locked else year_count - 1)
            )
            earliest = max(0, min(year_count - 1, earliest))
            latest = max(earliest, min(year_count - 1, latest))
            if locked:
                earliest = latest = year
        events.append(
            {
                "id": str(e.get("id") or f"ev-{i}"),
                "name": str(e.get("name") or f"Event {i + 1}"),
                "kind": kind,
                "year": year,
                "nodeId": str(e.get("nodeId") or f"node-{i}"),
                "nodeName": str(e.get("nodeName") or e.get("nodeId") or f"Node {i}"),
                "capexM": _as_float(e.get("capexM"), 0.0),
                "capacityDelta": _as_float(e.get("capacityDelta"), 0.0),
                "facilityKind": e.get("facilityKind") or "dc",
                "earliestYear": earliest,
                "latestYear": latest,
                "locked": locked,
                "region": e.get("region"),
                "notes": e.get("notes"),
            }
        )
    return events


def _ensure_facility_nodes(
    nodes: list[dict[str, Any]],
    events: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Materialize open-event nodes missing from the network."""
    by_id = {str(n["id"]): dict(n) for n in nodes}
    out = [dict(n) for n in nodes]
    for e in events:
        if e["kind"] != "open":
            continue
        nid = e["nodeId"]
        if nid in by_id:
            continue
        kind = e.get("facilityKind") or "dc"
        if kind not in ("dc", "plant", "candidate"):
            kind = "dc"
        node = {
            "id": nid,
            "name": e["nodeName"],
            "kind": kind,
            "x": 50.0,
            "y": 40.0,
            "capacity": f"{max(1.0, abs(e['capacityDelta']))}k",
            "region": e.get("region") or "NA",
        }
        out.append(node)
        by_id[nid] = node
    return out


def solve_multi_period(payload: dict[str, Any]) -> dict[str, Any]:
    t0 = time.perf_counter()
    log: list[str] = ["Flowform multi-period CapEx NPV MIP (PuLP)."]

    network = payload.get("network") or {}
    constraints = payload.get("constraints") or {}
    roadmap = payload.get("roadmap") or {}

    year_count = int(roadmap.get("yearCount") or 3)
    year_count = max(2, min(8, year_count))
    discount_rate = _as_float(roadmap.get("discountRate"), 0.10)
    discount_rate = max(0.0, min(0.5, discount_rate))
    mode = str(roadmap.get("mode") or "choose_timing").lower()
    if mode not in ("choose_timing", "force_timeline"):
        mode = "choose_timing"
    base_year_label = str(roadmap.get("baseYearLabel") or "Y0")
    hard_service = bool(
        roadmap.get("hardServiceConstraints", constraints.get("hardServiceConstraints", False))
    )

    events = _normalize_events(list(roadmap.get("events") or []), year_count, mode)
    nodes = _ensure_facility_nodes(list(network.get("nodes") or []), events)
    lanes = list(network.get("lanes") or [])
    demand_volume = {
        str(k): float(v) for k, v in dict(network.get("demandVolume") or {}).items()
    }
    lane_costs = _lane_cost_map(lanes)
    cost_scale = resolve_cost_scale({**payload, "network": {**network, "nodes": nodes}})
    off_lane_m = cost_scale["offLaneRateM"]
    uncovered_penalty = cost_scale["uncoveredPenaltyM"]

    # Optional demand growth / scale by year
    scale_raw = roadmap.get("demandScaleByYear") or constraints.get("demandScaleByYear")
    if isinstance(scale_raw, list) and scale_raw:
        demand_scale = [
            max(0.0, _as_float(scale_raw[min(t, len(scale_raw) - 1)], 1.0))
            for t in range(year_count)
        ]
    else:
        growth = _as_float(roadmap.get("demandGrowthPct"), 0.0) / 100.0
        demand_scale = [max(0.0, (1.0 + growth) ** t) for t in range(year_count)]

    cmap = {f["nodeId"]: f for f in (constraints.get("facilities") or []) if f.get("nodeId")}

    demands = [n for n in nodes if n.get("kind") == "demand"]
    if not demands:
        raise ValueError("No demand nodes in network.")
    for d in demands:
        demand_volume.setdefault(str(d["id"]), _parse_volume(d.get("capacity"), 1000.0))

    # Decidable facilities: DCs / candidates / plants that events touch or are open
    fac_kinds = ("dc", "candidate", "plant")
    facilities = [n for n in nodes if n.get("kind") in fac_kinds]
    event_node_ids = {e["nodeId"] for e in events}
    fac_by_id: dict[str, dict[str, Any]] = {str(f["id"]): f for f in facilities}

    # Ensure every event node is in fac_by_id
    for e in events:
        if e["nodeId"] not in fac_by_id:
            # should have been materialised for opens; expands/closes need existing
            if e["kind"] == "open":
                raise ValueError(f"Open event node {e['nodeId']} missing after materialise.")
            log.append(f"Warning: event {e['id']} targets unknown node {e['nodeId']}; skipped linkage.")

    if not fac_by_id:
        raise ValueError("No facility nodes (dc/plant/candidate) in network.")

    # Baseline open + capacity
    base_open: dict[str, int] = {}
    base_cap: dict[str, float] = {}
    opex: dict[str, float] = {}
    for fid, f in fac_by_id.items():
        st = _facility_status(f, cmap)
        # Candidates that will be opened by events start closed unless status open
        if fid in event_node_ids and any(
            e["kind"] == "open" and e["nodeId"] == fid for e in events
        ):
            base_open[fid] = 1 if st == "open" and f.get("kind") != "candidate" else 0
        else:
            base_open[fid] = 0 if st in ("closed", "candidate") else 1
        c = cmap.get(fid, {})
        cap_max = c.get("capacityMax")
        if cap_max is not None:
            base_cap[fid] = float(cap_max)
        else:
            base_cap[fid] = _parse_volume(f.get("capacity"), 10000.0)
        opex[fid] = _open_opex(fid, fac_by_id, cmap)

    years = list(range(year_count))
    df = [1.0 / ((1.0 + discount_rate) ** t) for t in years]

    radius = float(constraints.get("serviceRadiusMiles", 400))
    dem_nodes = {str(d["id"]): d for d in demands}
    cust_ids = [str(d["id"]) for d in demands]

    # Build arcs facility → customer
    arcs: list[tuple[str, str, float, float]] = []  # fid, cid, unit_cost, miles
    for fid, f in fac_by_id.items():
        for cid in cust_ids:
            dnode = dem_nodes[cid]
            cost, miles = _transport_unit_cost(f, dnode, lane_costs, off_lane_m)
            key = (fid, cid)
            within = miles <= radius + 1e-6 or key in lane_costs
            if within:
                arcs.append((fid, cid, cost, miles))

    if not arcs:
        # Relax radius for connectivity
        log.append(f"No arcs within radius {radius}; relaxing to distance proxy for all pairs.")
        for fid, f in fac_by_id.items():
            for cid in cust_ids:
                dnode = dem_nodes[cid]
                cost, miles = _transport_unit_cost(f, dnode, lane_costs, off_lane_m)
                arcs.append((fid, cid, cost, miles))

    arc_keys = [(a[0], a[1]) for a in arcs]
    unit_cost = {(a[0], a[1]): a[2] for a in arcs}
    miles_map = {(a[0], a[1]): a[3] for a in arcs}

    log.append(
        f"Mode={mode} · years={year_count} · discount={discount_rate:.1%} · "
        f"events={len(events)} · facilities={len(fac_by_id)} · arcs={len(arcs)}."
    )

    solver, solver_name = _pick_solver(log)
    prob = pulp.LpProblem("flowform_multi_period_capex", pulp.LpMinimize)

    # Event timing binaries
    y_ev: dict[tuple[str, int], Any] = {}
    for e in events:
        for t in years:
            if e["earliestYear"] <= t <= e["latestYear"]:
                y_ev[(e["id"], t)] = pulp.LpVariable(
                    _safe_name("yev", e["id"], t), cat="Binary"
                )
        # Exactly one year
        choices = [y_ev[(e["id"], t)] for t in years if (e["id"], t) in y_ev]
        if not choices:
            raise ValueError(f"Event {e['id']} has no feasible years.")
        if e["locked"] and e["earliestYear"] == e["latestYear"]:
            t_fixed = e["earliestYear"]
            prob += y_ev[(e["id"], t_fixed)] == 1, _safe_name("fix_ev", e["id"])
        else:
            prob += pulp.lpSum(choices) == 1, _safe_name("once_ev", e["id"])

    # Facility open binaries per year
    open_yt: dict[tuple[str, int], Any] = {
        (fid, t): pulp.LpVariable(_safe_name("open", fid, t), cat="Binary")
        for fid in fac_by_id
        for t in years
    }

    # Link open status to cumulative opens/closes
    opens_by_fac: dict[str, list[dict[str, Any]]] = {fid: [] for fid in fac_by_id}
    closes_by_fac: dict[str, list[dict[str, Any]]] = {fid: [] for fid in fac_by_id}
    expands_by_fac: dict[str, list[dict[str, Any]]] = {fid: [] for fid in fac_by_id}
    for e in events:
        if e["nodeId"] not in fac_by_id:
            continue
        if e["kind"] == "open":
            opens_by_fac[e["nodeId"]].append(e)
        elif e["kind"] == "close":
            closes_by_fac[e["nodeId"]].append(e)
        elif e["kind"] == "expand":
            expands_by_fac[e["nodeId"]].append(e)

    # At most one open event per facility (keeps opened_cum in {0,1} with base)
    for fid, elist in opens_by_fac.items():
        if len(elist) > 1:
            prob += (
                pulp.lpSum(
                    y_ev[(e["id"], t)]
                    for e in elist
                    for t in years
                    if (e["id"], t) in y_ev
                )
                <= 1,
                _safe_name("one_open", fid),
            )
        if base_open[fid] and elist:
            # Already open at Y0 — treat extra open events as timing-noop by forbidding
            prob += (
                pulp.lpSum(
                    y_ev[(e["id"], t)]
                    for e in elist
                    for t in years
                    if (e["id"], t) in y_ev
                )
                == 0,
                _safe_name("no_reopen", fid),
            )
            log.append(
                f"Facility {fid} already open — open event(s) ignored in linkage."
            )

    for fid in fac_by_id:
        for t in years:
            opened_terms = [base_open[fid]]
            for e in opens_by_fac[fid]:
                opened_terms.extend(
                    y_ev[(e["id"], tau)]
                    for tau in years
                    if tau <= t and (e["id"], tau) in y_ev
                )
            closed_terms = [
                y_ev[(e["id"], tau)]
                for e in closes_by_fac[fid]
                for tau in years
                if tau <= t and (e["id"], tau) in y_ev
            ]
            opened_expr = pulp.lpSum(opened_terms) if opened_terms else 0
            closed_expr = pulp.lpSum(closed_terms) if closed_terms else 0
            # open <= opened, open <= 1-closed, open >= opened - closed
            prob += open_yt[(fid, t)] <= opened_expr, _safe_name("op_le_opened", fid, t)
            if closed_terms:
                prob += (
                    open_yt[(fid, t)] <= 1 - closed_expr,
                    _safe_name("op_le_notclosed", fid, t),
                )
            prob += (
                open_yt[(fid, t)] >= opened_expr - closed_expr,
                _safe_name("op_ge_net", fid, t),
            )

    # Capacity expression potential (units available when open)
    # pot[f,t] = base_cap * base_open_contribution + open_deltas + expand_deltas
    # throughput <= pot (linear) and we also gate with open via: thr <= pot_max * open
    # Better: thr <= pot_expr where pot already requires being open via open deltas timing
    # For baseline-open facilities, pot includes base_cap when open.
    #
    # Use: thr[f,t] <= base_cap[f] * open[f,t]
    #                  + sum open_event capacityDelta * cum_y
    #                  + sum expand capacityDelta * cum_y
    # When closed, open=0 and we still need to zero expand contribution:
    # thr <= BigM * open, with BigM = base + sum positive deltas

    max_cap: dict[str, float] = {}
    for fid in fac_by_id:
        extras = 0.0
        for e in opens_by_fac[fid]:
            extras += max(0.0, e["capacityDelta"])
        for e in expands_by_fac[fid]:
            extras += max(0.0, e["capacityDelta"])
        max_cap[fid] = base_cap[fid] + extras + 1.0

    # Flows + uncovered
    x: dict[tuple[str, str, int], Any] = {
        (fid, cid, t): pulp.LpVariable(
            _safe_name("x", fid, cid, t), lowBound=0, cat="Continuous"
        )
        for (fid, cid) in arc_keys
        for t in years
    }
    uncovered: dict[tuple[str, int], Any] | None
    if hard_service:
        uncovered = None
        log.append("Hard service ON — uncovered demand forbidden each year.")
    else:
        uncovered = {
            (cid, t): pulp.LpVariable(
                _safe_name("u", cid, t), lowBound=0, cat="Continuous"
            )
            for cid in cust_ids
            for t in years
        }

    # Demand satisfaction
    for t in years:
        for cid in cust_ids:
            dem = demand_volume.get(cid, 0.0) * demand_scale[t]
            inbound = [x[(fid, cid, t)] for (fid, c) in arc_keys if c == cid]
            if hard_service:
                if inbound:
                    prob += pulp.lpSum(inbound) == dem, _safe_name("dem", cid, t)
                elif dem > 1e-9:
                    prob += 0 == 1, _safe_name("dem_isol", cid, t)
            else:
                assert uncovered is not None
                if inbound:
                    prob += (
                        pulp.lpSum(inbound) + uncovered[(cid, t)] == dem,
                        _safe_name("dem", cid, t),
                    )
                else:
                    prob += uncovered[(cid, t)] == dem, _safe_name("dem_isol", cid, t)

    # Capacity / throughput
    # thr[f,t] <= capacity_expr[f,t]
    # capacity_expr = (base if baseline-open path) * open
    #               + open-event deltas * cum_applied (gated by open via thr <= max*open)
    #               + expand deltas * cum_applied
    for fid in fac_by_id:
        uses_open_event = bool(opens_by_fac[fid]) and base_open[fid] == 0
        for t in years:
            thr = pulp.lpSum(
                x[(fid, cid, t)] for (f, cid) in arc_keys if f == fid
            )
            pot_terms: list[Any] = []
            if not uses_open_event:
                pot_terms.append(base_cap[fid] * open_yt[(fid, t)])
            for e in opens_by_fac[fid]:
                cum = pulp.lpSum(
                    y_ev[(e["id"], tau)]
                    for tau in years
                    if tau <= t and (e["id"], tau) in y_ev
                )
                # Capacity credited after open; closing zeros throughput via open gate
                delta = max(0.0, e["capacityDelta"]) or base_cap[fid]
                pot_terms.append(delta * cum)
            for e in expands_by_fac[fid]:
                cum = pulp.lpSum(
                    y_ev[(e["id"], tau)]
                    for tau in years
                    if tau <= t and (e["id"], tau) in y_ev
                )
                pot_terms.append(max(0.0, e["capacityDelta"]) * cum)
            if pot_terms:
                prob += thr <= pulp.lpSum(pot_terms), _safe_name("cap_pot", fid, t)
            else:
                prob += thr <= 0, _safe_name("cap_pot", fid, t)
            prob += thr <= max_cap[fid] * open_yt[(fid, t)], _safe_name("cap_gate", fid, t)

    # Objective pieces
    capex_by_t = []
    opex_by_t = []
    transport_by_t = []
    uncov_by_t = []

    for t in years:
        capex_t = pulp.lpSum(
            e["capexM"] * y_ev[(e["id"], t)]
            for e in events
            if (e["id"], t) in y_ev
        )
        opex_t = pulp.lpSum(opex[fid] * open_yt[(fid, t)] for fid in fac_by_id)
        transport_t = pulp.lpSum(
            unit_cost[(fid, cid)] * x[(fid, cid, t)] for (fid, cid) in arc_keys
        )
        if uncovered is not None:
            uncov_t = uncovered_penalty * pulp.lpSum(
                uncovered[(cid, t)] for cid in cust_ids
            )
        else:
            uncov_t = 0
        capex_by_t.append(capex_t)
        opex_by_t.append(opex_t)
        transport_by_t.append(transport_t)
        uncov_by_t.append(uncov_t)

    npv_expr = pulp.lpSum(
        df[t] * (capex_by_t[t] + opex_by_t[t] + transport_by_t[t] + uncov_by_t[t])
        for t in years
    )
    prob += npv_expr

    # Optional total CapEx budget across years
    budget = constraints.get("capexBudgetM")
    if budget is not None and roadmap.get("enforceCapexBudget", True):
        total_capex = pulp.lpSum(capex_by_t)
        # Multi-year budget: allow year_count * single-year budget as soft ceiling
        # unless roadmap.capexBudgetTotalM set
        total_budget = _as_float(
            roadmap.get("capexBudgetTotalM"),
            _as_float(budget, 30) * max(1, year_count),
        )
        prob += total_capex <= total_budget, "capex_budget_total"
        log.append(f"Total CapEx budget ${total_budget:.1f}M across horizon.")

    status = prob.solve(solver)
    status_name = pulp.LpStatus.get(status, str(status))
    solve_seconds = round(time.perf_counter() - t0, 3)

    def _val(var: Any) -> float:
        try:
            v = pulp.value(var)
            return float(v) if v is not None else 0.0
        except Exception:
            return 0.0

    if status_name not in ("Optimal", "Not Solved") and status < 0:
        # Treat infeasible distinctly
        if status_name == "Infeasible":
            log.append("Multi-period model infeasible.")
            return {
                "ok": False,
                "solver": solver_name,
                "status": "Infeasible",
                "model": "multi-period-capex-npv-v1",
                "mode": mode,
                "discountRate": discount_rate,
                "yearCount": year_count,
                "baseYearLabel": base_year_label,
                "solveSeconds": solve_seconds,
                "npv": {
                    "totalM": 0.0,
                    "capexNpvM": 0.0,
                    "opexNpvM": 0.0,
                    "transportNpvM": 0.0,
                    "uncoveredPenaltyNpvM": 0.0,
                },
                "eventTiming": [],
                "years": [],
                "kpis": {"npvTotalM": 0.0, "servicePctEnd": 0.0},
                "log": log,
                "infeasibilityReport": {
                    "status": "Infeasible",
                    "summary": "Multi-period CapEx NPV model infeasible.",
                    "hints": [
                        {
                            "code": "MULTI_PERIOD_INFEASIBLE",
                            "severity": "error",
                            "message": "No feasible timing/capacity plan under current demand and events.",
                            "hint": "Relax radius, add capacity events earlier, or disable hard service.",
                        }
                    ],
                    "method": "status-only",
                },
            }

    # Extract event timing
    event_timing: list[dict[str, Any]] = []
    chosen_year: dict[str, int] = {}
    for e in events:
        picked = None
        for t in years:
            if (e["id"], t) in y_ev and _val(y_ev[(e["id"], t)]) > 0.5:
                picked = t
                break
        if picked is None:
            picked = e["year"]
        chosen_year[e["id"]] = picked
        event_timing.append(
            {
                "eventId": e["id"],
                "name": e["name"],
                "kind": e["kind"],
                "nodeId": e["nodeId"],
                "nodeName": e["nodeName"],
                "year": picked,
                "preferredYear": e["year"],
                "capexM": round(e["capexM"], 4),
                "capacityDelta": round(e["capacityDelta"], 4),
                "locked": e["locked"],
            }
        )

    year_rows: list[dict[str, Any]] = []
    npv_capex = npv_opex = npv_transport = npv_uncov = 0.0
    end_service = 0.0

    for t in years:
        open_ids = [
            fid for fid in fac_by_id if _val(open_yt[(fid, t)]) > 0.5
        ]
        capex_m = sum(
            e["capexM"] for e in events if chosen_year.get(e["id"]) == t
        )
        opex_m = sum(opex[fid] for fid in open_ids)
        flows_t: list[dict[str, Any]] = []
        transport_m = 0.0
        total_vol = 0.0
        for (fid, cid) in arc_keys:
            vol = _val(x[(fid, cid, t)])
            if vol <= 1e-6:
                continue
            tc = unit_cost[(fid, cid)] * vol
            transport_m += tc
            total_vol += vol
            flows_t.append(
                {
                    "from": fid,
                    "to": cid,
                    "volume": round(vol, 2),
                    "miles": round(miles_map[(fid, cid)], 1),
                    "transportCostM": round(tc, 6),
                    "echelon": "dc→customer",
                }
            )
        flows_t.sort(key=lambda f: -f["volume"])
        dem_t = sum(demand_volume.get(cid, 0.0) * demand_scale[t] for cid in cust_ids)
        if uncovered is not None:
            uncov_vol = sum(_val(uncovered[(cid, t)]) for cid in cust_ids)
        else:
            uncov_vol = 0.0
        uncov_pen = uncovered_penalty * uncov_vol
        covered = max(0.0, dem_t - uncov_vol)
        service_pct = (covered / dem_t * 100.0) if dem_t > 0 else 100.0
        end_service = service_pct
        total_cost = capex_m + opex_m + transport_m + uncov_pen
        contrib = df[t] * total_cost
        npv_capex += df[t] * capex_m
        npv_opex += df[t] * opex_m
        npv_transport += df[t] * transport_m
        npv_uncov += df[t] * uncov_pen

        # Capacity snapshot
        cap_snap: dict[str, float] = {}
        for fid in open_ids:
            cap = base_cap[fid] if base_open[fid] or not opens_by_fac[fid] else 0.0
            if opens_by_fac[fid] and base_open[fid] == 0:
                cap = 0.0
            for e in events:
                if e["nodeId"] != fid:
                    continue
                if chosen_year.get(e["id"], 99) > t:
                    continue
                if e["kind"] in ("open", "expand"):
                    cap += max(0.0, e["capacityDelta"])
            cap_snap[fid] = round(cap, 2)

        year_rows.append(
            {
                "year": t,
                "label": f"Y{t}",
                "yearLabel": f"{base_year_label}+{t}" if t else base_year_label,
                "openIds": open_ids,
                "openCount": len(open_ids),
                "capexM": round(capex_m, 4),
                "opexM": round(opex_m, 4),
                "transportM": round(transport_m, 4),
                "uncoveredPenaltyM": round(uncov_pen, 4),
                "uncoveredDemand": round(uncov_vol, 2),
                "totalCostM": round(total_cost, 4),
                "discountFactor": round(df[t], 6),
                "npvContributionM": round(contrib, 4),
                "servicePct": round(service_pct, 2),
                "demandScale": round(demand_scale[t], 4),
                "capacityByFacility": cap_snap,
                "flowsSummary": {
                    "arcCount": len(flows_t),
                    "totalVolume": round(total_vol, 2),
                    "topFlows": flows_t[:8],
                },
                "eventsThisYear": [
                    {
                        "eventId": e["id"],
                        "name": e["name"],
                        "kind": e["kind"],
                        "capexM": e["capexM"],
                    }
                    for e in events
                    if chosen_year.get(e["id"]) == t
                ],
            }
        )

    npv_total = npv_capex + npv_opex + npv_transport + npv_uncov
    # Prefer solver objective when optimal
    obj_val = _val(prob.objective)
    if status_name in ("Optimal", "Not Solved") and obj_val:
        npv_total = obj_val

    log.append(
        f"Done: NPV ${npv_total:.3f}M · mode={mode} · "
        f"end service {end_service:.1f}% · {solve_seconds}s."
    )
    for et in event_timing:
        if et["year"] != et["preferredYear"]:
            log.append(
                f"Timing shift: {et['name']} Y{et['preferredYear']} → Y{et['year']}."
            )

    return {
        "ok": True,
        "solver": solver_name,
        "status": status_name if status_name != "Not Solved" else "Optimal",
        "model": "multi-period-capex-npv-v1",
        "mode": mode,
        "discountRate": discount_rate,
        "yearCount": year_count,
        "baseYearLabel": base_year_label,
        "solveSeconds": solve_seconds,
        "npv": {
            "totalM": round(npv_total, 4),
            "capexNpvM": round(npv_capex, 4),
            "opexNpvM": round(npv_opex, 4),
            "transportNpvM": round(npv_transport, 4),
            "uncoveredPenaltyNpvM": round(npv_uncov, 4),
            "currency": "model-$M",
        },
        "eventTiming": event_timing,
        "years": year_rows,
        "kpis": {
            "npvTotalM": round(npv_total, 4),
            "capexNpvM": round(npv_capex, 4),
            "opexNpvM": round(npv_opex, 4),
            "transportNpvM": round(npv_transport, 4),
            "servicePctEnd": round(end_service, 1),
            "eventsScheduled": len(event_timing),
            "yearCount": year_count,
            "discountRate": discount_rate,
        },
        "log": log,
    }
