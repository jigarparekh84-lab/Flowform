"""
Multi-period Roadmap optimize on the **Run model basis** (default).

Each period t is the exact single-period Run MIP from ``app.solver`` (same
fixed-charge open/close, SKUs / product groups, BOM supplier→plant arcs, lane
modes + lane / lane-mode capacity + fixed activation charges, cost scale,
min throughput, capability / per-product capacity, service radius / max lead
time, soft or hard service, carbon price and unit-weight CO2). The period
copies are built with ``_solve_optimize_core({... "_buildOnly": True})``,
prefixed ``p{t}_`` and linked in one PuLP problem:

  * roadmap events (open / expand / close) fire in exactly one year
    (force_timeline: the stated year; choose_timing: any year in
    [earliest, latest]);
  * an open-event site is closed until its open event and open afterwards
    (until a close event); a close-event site is closed from its close year
    (free Run decision before); an expand event adds ``capacityDelta`` units
    to the site's capacity row from its year;
  * non-event sites keep the Run open/close decision in every period; a
    candidate's fixedCapexM is charged once, in the year it first opens
    (o_t >= y_t - y_{t-1}, y_{-1} = current status);
  * event CapEx is charged in the event year.

Objective: min NPV = Σ_t df_t · (transport + carbon + fixed OpEx + lane fixed
+ unmet penalty + CapEx_t), df_t = 1/(1+r)^t. Per-period breakdowns use the
same keys as Run's objectiveBreakdown, so Y0 (no Y0 events) equals Run.

``roadmap.basis = "legacy-aggregate"`` keeps the previous single-commodity
raw-network model (app.multi_period.solve_multi_period_legacy).
"""

from __future__ import annotations

import copy
import time
from typing import Any

import pulp

from .multi_period import _as_float, _ensure_facility_nodes, _normalize_events
from .solver import _safe_name, _solve_optimize_core, solve_optimize

MODEL_NAME = "multi-period-run-basis-v2"
DEFAULT_GAP_REL = 1e-4
LARGE_MODEL_GAP_REL = 2e-3  # 0.2 % — stress-200 × 5 periods ≈ 3 s
LARGE_MODEL_VARS = 2_000
DEFAULT_TIME_LIMIT_SEC = 120.0


def _val(v: Any) -> float:
    try:
        x = pulp.value(v)
        return float(x) if x is not None else 0.0
    except Exception:
        return 0.0


def _scaled_payload(base: dict[str, Any], scale: float) -> dict[str, Any]:
    q = copy.deepcopy(base)
    net = q.setdefault("network", {})
    if net.get("demandVolume"):
        net["demandVolume"] = {k: float(v) * scale for k, v in net["demandVolume"].items()}
    if net.get("demandByProduct"):
        for r in net["demandByProduct"]:
            r["volume"] = float(r.get("volume") or 0) * scale
    if q.get("demandByProduct"):
        for r in q["demandByProduct"]:
            r["volume"] = float(r.get("volume") or 0) * scale
    return q


def _infeasible(log, mode, r, year_count, base_label, t0, summary, hint, extra=None):
    return {
        "ok": False,
        "solver": "pulp-highs",
        "status": "Infeasible",
        "model": MODEL_NAME,
        "basis": {"model": "run", **(extra or {})},
        "mode": mode,
        "discountRate": r,
        "yearCount": year_count,
        "baseYearLabel": base_label,
        "solveSeconds": round(time.perf_counter() - t0, 3),
        "npv": {"totalM": 0.0, "capexNpvM": 0.0, "opexNpvM": 0.0,
                "transportNpvM": 0.0, "carbonNpvM": 0.0, "laneFixedNpvM": 0.0,
                "uncoveredPenaltyNpvM": 0.0},
        "eventTiming": [],
        "years": [],
        "kpis": {"npvTotalM": 0.0, "servicePctEnd": 0.0},
        "log": log,
        "infeasibilityReport": {
            "status": "Infeasible",
            "summary": summary,
            "hints": [{"code": "MULTI_PERIOD_INFEASIBLE", "severity": "error",
                       "message": summary, "hint": hint}],
            "method": "status-only",
        },
    }


def solve_multi_period_run_basis(payload: dict[str, Any]) -> dict[str, Any]:
    t0 = time.perf_counter()
    log: list[str] = ["Flowform multi-period Roadmap MIP on the Run model basis (PuLP)."]
    network = payload.get("network") or {}
    constraints = copy.deepcopy(payload.get("constraints") or {})
    roadmap = payload.get("roadmap") or {}

    year_count = max(2, min(8, int(roadmap.get("yearCount") or 3)))
    r = max(0.0, min(0.5, _as_float(roadmap.get("discountRate"), 0.10)))
    mode = str(roadmap.get("mode") or "choose_timing").lower()
    if mode not in ("choose_timing", "force_timeline"):
        mode = "choose_timing"
    base_label = str(roadmap.get("baseYearLabel") or "Y0")
    if roadmap.get("hardServiceConstraints") is not None:
        constraints["hardServiceConstraints"] = bool(roadmap["hardServiceConstraints"])

    events = _normalize_events(list(roadmap.get("events") or []), year_count, mode)
    nodes = _ensure_facility_nodes(list(network.get("nodes") or []), events)
    node_ids = {str(n["id"]) for n in nodes}
    fac_node = {str(n["id"]): n for n in nodes if n.get("kind") in ("dc", "candidate", "plant")}

    scale_raw = roadmap.get("demandScaleByYear") or constraints.get("demandScaleByYear")
    if isinstance(scale_raw, list) and scale_raw:
        demand_scale = [max(0.0, _as_float(scale_raw[min(t, len(scale_raw) - 1)], 1.0))
                        for t in range(year_count)]
    else:
        g = _as_float(roadmap.get("demandGrowthPct"), 0.0) / 100.0
        demand_scale = [max(0.0, (1.0 + g) ** t) for t in range(year_count)]

    opens: dict[str, list[dict]] = {}
    closes: dict[str, list[dict]] = {}
    expands: dict[str, list[dict]] = {}
    for e in events:
        if e["nodeId"] not in node_ids:
            log.append(f"Warning: event {e['id']} targets unknown node {e['nodeId']}; skipped linkage.")
            continue
        {"open": opens, "close": closes, "expand": expands}[e["kind"]].setdefault(
            e["nodeId"], []).append(e)

    # Facility constraint overrides: an open-event site is a zero-capex
    # candidate in every period (its CapEx is the event's), capacity = the
    # event's capacityDelta when given.
    facs = [dict(f) for f in (constraints.get("facilities") or []) if f.get("nodeId")]
    by_id = {str(f["nodeId"]): f for f in facs}
    for fid, elist in opens.items():
        f = by_id.get(fid)
        if f is None:
            f = {"nodeId": fid}
            facs.append(f)
            by_id[fid] = f
        f["status"] = "candidate"
        f["fixedCapexM"] = 0.0
        delta = max((ev["capacityDelta"] for ev in elist), default=0.0)
        if delta > 0:
            f["capacityMax"] = float(delta)
            if float(f.get("capacityMin") or 0) > delta:
                f["capacityMin"] = 0.0
        log.append(f"Facility {fid} has an open event — closed until the event year.")
    constraints["facilities"] = facs
    # Open-event sites must not be blocked by maxFacilities once open
    base_net = {**network, "nodes": nodes}
    base_payload = {
        **{k: v for k, v in payload.items() if k not in ("roadmap", "network", "constraints")},
        "network": base_net,
        "constraints": constraints,
        "explain": False,
        "computeBaseline": False,
        "_diagProbe": True,
        "_buildOnly": True,
    }

    years = list(range(year_count))
    df = [1.0 / ((1.0 + r) ** t) for t in years]
    master = pulp.LpProblem("flowform_multi_period_run_basis", pulp.LpMinimize)
    models: list[dict[str, Any]] = []
    t_build0 = time.perf_counter()
    n_vars = 0
    for t in years:
        res = _solve_optimize_core(_scaled_payload(base_payload, demand_scale[t]))
        m = res.get("_model")
        if m is None:
            log.append(f"Y{t}: Run model infeasible before solve — {res.get('infeasibilityReport', {}).get('summary', '')}")
            return _infeasible(
                log, mode, r, year_count, base_label, t0,
                f"Period Y{t} Run model is infeasible before linking (same pre-check as Run).",
                "Run the single-period optimize to see the diagnostics; relax radius / hard service.",
            )
        if t == 0:
            log.extend(ln for ln in m["log"] if ln.startswith(("Commodities", "Model:", "CO2 basis", "Cost scale")))
        prob = m["prob"]
        for v in prob.variables():
            v.name = f"p{t}_{v.name}"
        n_vars += len(prob.variables())
        for name, c in list(prob.constraints.items()):
            if t > 0 and name == "capex_budget":
                continue  # per-period budget counts already-built sites; horizon budget below
            master.addConstraint(c, f"p{t}_{name}")
        models.append(m)
    build_seconds = round(time.perf_counter() - t_build0, 3)

    # Close-event plants may be pinned open by the Run rules — unpin them.
    for fid in closes:
        for t in years:
            key = f"p{t}_" + _safe_name("forced_open", fid)
            if key in master.constraints:
                del master.constraints[key]

    # Event timing binaries
    y_ev: dict[tuple[str, int], Any] = {}
    for e in events:
        for t in years:
            if e["earliestYear"] <= t <= e["latestYear"]:
                y_ev[(e["id"], t)] = pulp.LpVariable(_safe_name("yev", e["id"], t), cat="Binary")
        choices = [y_ev[(e["id"], t)] for t in years if (e["id"], t) in y_ev]
        if not choices:
            raise ValueError(f"Event {e['id']} has no feasible years.")
        master += pulp.lpSum(choices) == 1, _safe_name("once_ev", e["id"])

    def cum(elist: list[dict], t: int):
        return pulp.lpSum(y_ev[(e["id"], tau)] for e in elist for tau in years
                          if tau <= t and (e["id"], tau) in y_ev)

    for fid, elist in opens.items():
        if len(elist) > 1:
            log.append(f"Facility {fid}: {len(elist)} open events — first chosen year counts.")
    capex_terms: list[list[Any]] = [[] for _ in years]
    for e in events:
        for t in years:
            if (e["id"], t) in y_ev and e["capexM"]:
                capex_terms[t].append(e["capexM"] * y_ev[(e["id"], t)])

    decidable = models[0]["decidable"]
    base_open = {d["id"]: 1 if d["status"] == "open" else 0 for d in decidable}
    for fid in opens:
        base_open[fid] = 0
    o_vars: dict[tuple[str, int], Any] = {}
    for t, m in enumerate(models):
        y = m["y"]
        for fid in y:
            if fid in opens:
                expr = cum(opens[fid], t) - (cum(closes[fid], t) if fid in closes else 0)
                master += y[fid] == expr, _safe_name("link_open", fid, t)
                if len(opens[fid]) > 1:
                    master += cum(opens[fid], t) <= 1, _safe_name("one_open", fid, t)
            elif fid in closes:
                master += y[fid] <= 1 - cum(closes[fid], t), _safe_name("link_close", fid, t)
            cap = m["capexCost"].get(fid, 0.0)
            if cap > 0 and fid not in opens:
                o = pulp.LpVariable(_safe_name("first_open", fid, t), lowBound=0)
                prev = models[t - 1]["y"][fid] if t > 0 else base_open.get(fid, 0)
                master += o >= y[fid] - prev, _safe_name("open_inc", fid, t)
                o_vars[(fid, t)] = o
                capex_terms[t].append(cap * o)
        for fid, elist in expands.items():
            if fid not in m["facThr"]:
                continue
            thr, cap_max, ren = m["facThr"][fid]
            key = f"p{t}_{ren}"
            if key in master.constraints:
                del master.constraints[key]
            master += (
                thr <= cap_max * y[fid] + pulp.lpSum(ev["capacityDelta"] * pulp.lpSum(
                    y_ev[(ev["id"], tau)] for tau in years if tau <= t and (ev["id"], tau) in y_ev)
                    for ev in elist),
                f"p{t}_cap_exp_{_safe_name(fid)}",
            )

    capex_t = [pulp.lpSum(ts) if ts else 0 for ts in capex_terms]
    run_cost_t = [m["transport"] + m["carbon"] + m["opex"] + m["uncov"] + m["laneFixed"] for m in models]
    master += pulp.lpSum(df[t] * (run_cost_t[t] + capex_t[t] + models[t]["keepBonus"]) for t in years)

    budget = constraints.get("capexBudgetM")
    if budget is not None and roadmap.get("enforceCapexBudget", True):
        total_budget = _as_float(roadmap.get("capexBudgetTotalM"), _as_float(budget, 30) * year_count)
        master += pulp.lpSum(capex_t) <= total_budget, "capex_budget_total"
        log.append(f"Total CapEx budget ${total_budget:.1f}M across horizon.")

    gap = _as_float(roadmap.get("mipGapRel"), 0.0)
    if gap <= 0:
        gap = LARGE_MODEL_GAP_REL if n_vars > LARGE_MODEL_VARS else DEFAULT_GAP_REL
    time_limit = _as_float(roadmap.get("timeLimitSec"), DEFAULT_TIME_LIMIT_SEC)
    available = set(pulp.listSolvers(onlyAvailable=True))
    if "HiGHS" in available:
        solver, solver_name = pulp.HiGHS(msg=False, gapRel=gap, timeLimit=time_limit), "pulp-highs"
    else:
        solver, solver_name = pulp.PULP_CBC_CMD(msg=False, gapRel=gap, timeLimit=time_limit), "pulp-cbc"
    log.append(
        f"Mode={mode} · years={year_count} · discount={r:.1%} · events={len(events)} · "
        f"{n_vars} vars / {len(master.constraints)} rows · gapRel={gap:g} · "
        f"timeLimit={time_limit:g}s · build {build_seconds}s."
    )
    t_s0 = time.perf_counter()
    status = master.solve(solver)
    solve_only = round(time.perf_counter() - t_s0, 3)
    status_name = pulp.LpStatus.get(status, str(status))
    log.append(f"Solve status: {status_name} in {solve_only}s.")
    basis = {
        "model": "run",
        "description": "Each period is the Run MIP (fixed-charge open/close, SKUs/groups, "
        "BOM, lane modes + capacity, cost scale, min throughput, service) linked by "
        "event timing and CapEx NPV.",
        "commodityMode": models[0]["commodityMode"],
        "commodities": models[0]["productCount"],
        "variables": n_vars,
        "gapRel": gap,
        "timeLimitSec": time_limit,
        "buildSeconds": build_seconds,
        "solveOnlySeconds": solve_only,
    }
    if status_name in ("Infeasible", "Undefined") or (status < 0 and status_name != "Not Solved"):
        return _infeasible(
            log, mode, r, year_count, base_label, t0,
            "Multi-period Run-basis model infeasible.",
            "Relax radius / hard service, move capacity events earlier, or raise the CapEx budget.",
            basis,
        )

    chosen: dict[str, int] = {}
    timing = []
    for e in events:
        picked = next((t for t in years if (e["id"], t) in y_ev and _val(y_ev[(e["id"], t)]) > 0.5), e["year"])
        chosen[e["id"]] = picked
        timing.append({
            "eventId": e["id"], "name": e["name"], "kind": e["kind"], "nodeId": e["nodeId"],
            "nodeName": e["nodeName"], "year": picked, "preferredYear": e["year"],
            "capexM": round(e["capexM"], 4), "capacityDelta": round(e["capacityDelta"], 4),
            "locked": e["locked"],
        })

    rows = []
    npv = {k: 0.0 for k in ("capex", "opex", "transport", "carbon", "laneFixed", "uncov")}
    end_service = 0.0
    for t, m in enumerate(models):
        y = m["y"]
        open_ids = [fid for fid in y if _val(y[fid]) > 0.5]
        tr, cb, ox = _val(m["transport"]), _val(m["carbon"]), _val(m["opex"])
        lf = _val(m["laneFixed"])
        unc = 0.0 if m["uncovered"] is None else sum(_val(v) for v in m["uncovered"].values())
        pen = _val(m["uncov"])
        cx = _val(capex_t[t])
        cx_events = sum(e["capexM"] for e in events if chosen.get(e["id"]) == t)
        total = tr + cb + ox + lf + pen + cx
        dem = m["totalDemand"]
        svc = max(0.0, min(100.0, (dem - unc) / dem * 100)) if dem > 0 else 100.0
        end_service = svc
        for k, v in (("capex", cx), ("opex", ox), ("transport", tr), ("carbon", cb),
                     ("laneFixed", lf), ("uncov", pen)):
            npv[k] += df[t] * v
        cust = set(m["custIds"])
        flows, vol_tot = [], 0.0
        for a, b, p, mk, _e, var, miles in m["flowArcs"]:
            v = _val(var)
            if v <= 1e-6 or b not in cust:
                continue
            vol_tot += v
            flows.append({"from": a, "to": b, "volume": round(v, 2), "miles": round(miles, 1),
                          **({"productId": p} if p != "__total__" else {}),
                          **({"modeKey": mk} if mk else {})})
        flows.sort(key=lambda f: -f["volume"])
        cap_snap = {}
        for fid in open_ids:
            if fid in m["facThr"]:
                c = m["facThr"][fid][1]
                c += sum(ev["capacityDelta"] for ev in expands.get(fid, []) if chosen.get(ev["id"], 99) <= t)
                cap_snap[fid] = round(c, 2)
        rows.append({
            "year": t, "label": f"Y{t}",
            "yearLabel": f"{base_label}+{t}" if t else base_label,
            "openIds": open_ids, "openCount": len(open_ids),
            "capexM": round(cx, 4), "eventCapexM": round(cx_events, 4),
            "candidateCapexM": round(cx - cx_events, 4),
            "opexM": round(ox, 4), "transportM": round(tr, 4), "carbonM": round(cb, 4),
            "laneFixedM": round(lf, 4), "uncoveredPenaltyM": round(pen, 4),
            "uncoveredDemand": round(unc, 2), "totalCostM": round(total, 4),
            "runBreakdown": {
                "totalM": round(total, 4), "transportM": round(tr, 4),
                "fixedCapexM": round(cx, 4), "fixedOpexM": round(ox, 4),
                "uncoveredPenaltyM": round(pen, 4), "laneFixedM": round(lf, 4),
                "carbonM": round(cb, 4),
            },
            "co2Kt": round(_val(m["co2Kg"]) / 1e6, 3),
            "discountFactor": round(df[t], 6), "npvContributionM": round(df[t] * total, 4),
            "servicePct": round(svc, 2), "demandScale": round(demand_scale[t], 4),
            "capacityByFacility": cap_snap,
            "flowsSummary": {"arcCount": len(flows), "totalVolume": round(vol_tot, 2), "topFlows": flows[:8]},
            "eventsThisYear": [{"eventId": e["id"], "name": e["name"], "kind": e["kind"], "capexM": e["capexM"]}
                               for e in events if chosen.get(e["id"]) == t],
        })
    npv_total = sum(npv.values())
    solve_seconds = round(time.perf_counter() - t0, 3)

    run_check = None
    if roadmap.get("compareRun"):
        q = {k: v for k, v in payload.items() if k != "roadmap"}
        q = {**q, "explain": False, "computeBaseline": False}
        if roadmap.get("hardServiceConstraints") is not None:
            q["constraints"] = {**(q.get("constraints") or {}),
                                "hardServiceConstraints": bool(roadmap["hardServiceConstraints"])}
        rr = solve_optimize(_scaled_payload(q, demand_scale[0]))
        if rr.get("status") == "Optimal":
            run_total = float(rr["objectiveBreakdown"]["totalM"])
            y0 = rows[0]["totalCostM"]
            run_check = {
                "runTotalM": round(run_total, 4),
                "y0TotalM": y0,
                "deltaM": round(y0 - run_total, 4),
                "deltaPct": round((y0 - run_total) / run_total * 100, 4) if run_total else None,
                "y0HasEvents": bool(rows[0]["eventsThisYear"]),
                "runOpenIds": rr.get("openIds"),
                "y0OpenIds": rows[0]["openIds"],
                "matches": abs(y0 - run_total) <= max(0.01, abs(run_total) * 1e-3),
            }
            log.append(
                f"Y0 vs Run: ${y0:.4f}M vs ${run_total:.4f}M (Δ {y0 - run_total:+.4f}M)"
                + (" — Y0 has events, so a difference is expected." if run_check["y0HasEvents"] else ".")
            )
        else:
            run_check = {"runStatus": rr.get("status")}

    log.append(f"Done: NPV ${npv_total:.3f}M · mode={mode} · end service {end_service:.1f}% · {solve_seconds}s.")
    for et in timing:
        if et["year"] != et["preferredYear"]:
            log.append(f"Timing shift: {et['name']} Y{et['preferredYear']} → Y{et['year']}.")

    out_status = "Optimal" if status_name in ("Optimal", "Not Solved") else status_name
    return {
        "ok": True,
        "solver": solver_name,
        "status": out_status,
        "model": MODEL_NAME,
        "basis": basis,
        "mode": mode,
        "discountRate": r,
        "yearCount": year_count,
        "baseYearLabel": base_label,
        "solveSeconds": solve_seconds,
        "npv": {
            "totalM": round(npv_total, 4),
            "capexNpvM": round(npv["capex"], 4),
            "opexNpvM": round(npv["opex"], 4),
            "transportNpvM": round(npv["transport"], 4),
            "carbonNpvM": round(npv["carbon"], 4),
            "laneFixedNpvM": round(npv["laneFixed"], 4),
            "uncoveredPenaltyNpvM": round(npv["uncov"], 4),
            "currency": "model-$M",
        },
        "eventTiming": timing,
        "years": rows,
        "runCheck": run_check,
        "kpis": {
            "npvTotalM": round(npv_total, 4),
            "capexNpvM": round(npv["capex"], 4),
            "opexNpvM": round(npv["opex"], 4),
            "transportNpvM": round(npv["transport"], 4),
            "servicePctEnd": round(end_service, 1),
            "eventsScheduled": len(timing),
            "yearCount": year_count,
            "discountRate": r,
        },
        "log": log,
    }
