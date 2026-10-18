"""
Depth slice 8 — "why was this site opened / closed" explanations.

Driven entirely by the fixed-charge MIP in ``solver.py``:
  * cost-to-serve per facility from the optimal flows (each transport arc is
    assigned once: supplier→plant and plant→customer to the plant,
    plant→DC and DC→customer to the DC),
  * facility capacity duals (HiGHS row duals from the fixed-binary LP),
  * counterfactual re-solves: the full MIP is re-solved with one facility
    forced to the opposite open/close state (any scenario lock on that
    facility lifted) — the objective delta is the $ penalty of flipping the
    decision, plus the service impact and which other sites change state.

The counterfactual count is capped (``maxCounterfactuals``, ranked by impact)
and bounded by a wall-clock budget so stress-size networks stay responsive.
"""

from __future__ import annotations

import math
import time
from typing import Any, Callable

DEFAULT_MAX_COUNTERFACTUALS = 12
DEFAULT_BUDGET_SEC = 60.0
DEFAULT_TOP_DECISIONS = 6
OUT_ECHELONS = ("dc→customer", "plant→dc", "plant→customer")


def explain_options(payload: dict[str, Any]) -> dict[str, Any]:
    """Normalize ``explain`` (bool | dict) + ``explainOptions`` from a payload."""
    raw = payload.get("explain")
    extra = payload.get("explainOptions") or {}
    c_raw = (payload.get("constraints") or {}).get("explain")
    opts: dict[str, Any] = {}
    enabled = False
    for src in (c_raw, raw):
        if isinstance(src, dict):
            enabled = src.get("enabled", True) is not False
            opts.update(src)
        elif src is not None:
            enabled = bool(src)
    if isinstance(extra, dict):
        opts.update(extra)

    def _f(key: str, default: float | None) -> float | None:
        v = opts.get(key)
        try:
            return default if v is None else float(v)
        except (TypeError, ValueError):
            return default

    max_cf = _f("maxCounterfactuals", DEFAULT_MAX_COUNTERFACTUALS)
    return {
        "enabled": enabled,
        "maxCounterfactuals": int(max(0, min(50, max_cf or 0))),
        "timeLimitSec": _f("timeLimitSec", None),
        "budgetSec": max(0.0, _f("budgetSec", DEFAULT_BUDGET_SEC) or 0.0),
        "topDecisions": int(max(1, _f("topDecisions", DEFAULT_TOP_DECISIONS) or 1)),
    }


def fmt_money_m(v: float) -> str:
    """Format a model-$M amount: $1.2M · $340k · $12."""
    a = abs(v)
    sign = "-" if v < 0 else ""
    if a >= 1:
        return f"{sign}${a:,.1f}M" if a < 100 else f"{sign}${a:,.0f}M"
    if a >= 0.001:
        return f"{sign}${a * 1000:,.0f}k" if a >= 0.01 else f"{sign}${a * 1000:,.1f}k"
    return f"{sign}${a * 1e6:,.0f}"


def _tier(kind: str | None) -> str:
    return "plant" if kind == "plant" else "dc"


def _reason(text: str, kind: str, tone: str, score: float) -> dict[str, Any]:
    return {"text": text, "kind": kind, "tone": tone, "score": round(score, 4)}


def facility_reasons(fx: dict[str, Any], base_total: float, tol: float,
                     hard_service: bool, tier_count: int,
                     total_dem: float = 0.0) -> list[dict[str, Any]]:
    """Ranked plain-language reasons for one facility's decision."""
    out: list[dict[str, Any]] = []
    is_open = fx["open"]
    cf = fx.get("counterfactual") or {}
    tier_label = "plants" if fx["tier"] == "plant" else "DCs"
    base = max(abs(base_total), 1e-9)
    names = fx.get("_names") or {}

    def _list(ids: list[str]) -> str:
        labels = [names.get(i, i) for i in ids[:3]]
        more = f" +{len(ids) - 3}" if len(ids) > 3 else ""
        return ", ".join(labels) + more

    if is_open:
        share = fx["demandSharePct"]
        if share > 0.05:
            txt = f"Serves {share:.0f}% of demand ({fx['customersServed']} customers)"
            rank = fx.get("landedCostRank")
            bonus = 0.0
            if rank == 1 and tier_count > 1:
                txt += f" at the lowest landed cost of open {tier_label}"
                bonus = 0.2
            elif rank is not None and tier_count > 2 and rank <= tier_count / 2:
                txt += " at below-median landed cost"
                bonus = 0.08
            out.append(_reason(txt, "demand", "support", 0.35 + share / 100 + bonus))
        elif fx["throughput"] <= 1e-6:
            out.append(_reason("Open but carries no flow in the optimal plan",
                               "demand", "risk", 0.7))

    # Counterfactual
    if cf.get("evaluated"):
        st = cf.get("status")
        verb = "Closing" if is_open else "Opening"
        if st in ("optimal", "time-limit") and cf.get("deltaM") is not None:
            d = float(cf["deltaM"])
            svc = float(cf["servicePct"])
            dsvc = float(cf["serviceDeltaPct"])
            op = float(cf.get("operatingDeltaM", d))
            du = float(cf.get("unservedDeltaUnits") or 0.0)
            if du > 0.5:
                # Flip strands demand: lead with the service impact, then the
                # operating-cost change (the soft unmet-demand penalty would
                # otherwise dwarf every real cost).
                txt = (
                    f"{verb} it strands {du:,.0f} units of demand (service drops to "
                    f"{svc:.1f}%)"
                )
                if op > tol:
                    txt += f" and adds {fmt_money_m(op)} operating cost"
                elif op < -tol:
                    txt += (
                        f"; operating cost falls {fmt_money_m(-op)} only because "
                        "that demand goes unserved"
                    )
                score = 1.6 + min(1.0, du / max(total_dem, 1e-9) * 10)
                out.append(_reason(txt, "counterfactual", "support", score))
            elif d > tol:
                pct = d / base * 100
                txt = f"{verb} it raises cost by {fmt_money_m(d)}" + (
                    f" ({pct:.1f}%)" if pct >= 0.05 else "")
                if du < -0.5:
                    txt += f" even though service rises to {svc:.1f}%"
                elif dsvc > 0.05:
                    txt += f" despite lifting service to {svc:.1f}%"
                else:
                    txt += f"; service holds at {svc:.1f}%"
                score = 1.0 + min(1.5, d / base * 25)
                out.append(_reason(txt, "counterfactual", "support", score))
            else:
                txt = (
                    f"Marginal call: {verb.lower()} it changes cost by only "
                    f"{fmt_money_m(d)}"
                    + (f" (service {svc:.1f}%)" if abs(dsvc) > 0.05 else "")
                    + (" — consolidation candidate" if is_open else " — viable alternative")
                )
                out.append(_reason(txt, "counterfactual", "risk", 0.95))
            if cf.get("alsoOpens"):
                out.append(_reason(
                    f"Without it the model opens {_list(cf['alsoOpens'])} instead"
                    if is_open else
                    f"Opening it would let the model close {_list(cf.get('alsoCloses') or [])}"
                    if cf.get("alsoCloses") else
                    f"Opening it also pulls open {_list(cf['alsoOpens'])}",
                    "counterfactual", "info", 0.45))
            elif cf.get("alsoCloses"):
                out.append(_reason(
                    f"Opening it would let the model close {_list(cf['alsoCloses'])}"
                    if not is_open else
                    f"Closing it also idles {_list(cf['alsoCloses'])}",
                    "counterfactual", "info", 0.45))
            # Fixed vs variable trade-off
            fixed_d = float(cf.get("fixedDeltaM") or 0.0)
            var_d = float(cf.get("variableDeltaM") or 0.0)
            if is_open and fixed_d < -1e-9 and var_d > 1e-9:
                out.append(_reason(
                    f"Closing saves {fmt_money_m(-fixed_d)} fixed cost but adds "
                    f"{fmt_money_m(var_d)} transport",
                    "cost", "support", 0.5 + min(0.3, var_d / base * 10)))
            elif not is_open and fixed_d > 1e-9 and var_d < -1e-9:
                out.append(_reason(
                    f"Would save {fmt_money_m(-var_d)} in transport but adds "
                    f"{fmt_money_m(fixed_d)} fixed cost",
                    "cost", "support", 0.55))
        elif st == "infeasible":
            if is_open:
                txt = "Required: closing it makes the network infeasible" + (
                    " under hard service constraints" if hard_service else "")
            else:
                txt = "Cannot be opened within the CapEx budget / facility-count / capacity limits"
            out.append(_reason(txt, "counterfactual", "support", 2.0))
        elif st:
            out.append(_reason(f"Counterfactual re-solve ended '{st}'",
                               "counterfactual", "info", 0.1))

    # Capacity dual / utilization
    pi = fx.get("capacityDual")
    if is_open:
        if pi is not None and pi < -1e-9:
            out.append(_reason(
                f"Capacity binding ({fx['utilizationPct']:.0f}% utilized): each extra "
                f"unit saves {fmt_money_m(-pi)}",
                "capacity", "info", 0.55 + min(0.4, -pi * 50)))
        elif fx["utilizationPct"] < 40 and fx["capacityMax"] < 1e8 and fx["throughput"] > 0:
            out.append(_reason(
                f"Only {fx['utilizationPct']:.0f}% utilized — "
                f"{fx['capacityMax'] - fx['throughput']:,.0f} units of headroom",
                "utilization", "risk", 0.4))
        elif fx["utilizationPct"] >= 95:
            out.append(_reason(
                f"Running at {fx['utilizationPct']:.0f}% of capacity (dual ≈ 0: a "
                "neighbour can absorb overflow)", "capacity", "info", 0.3))

    # Fixed cost context
    fixed = fx["fixedCostM"]
    if is_open and fx["fixedCapexM"] <= 1e-9 and fx["decision"] == "kept-open":
        out.append(_reason(
            f"Existing site — no new CapEx (OpEx {fmt_money_m(fx['fixedOpexM'])}/period)",
            "cost", "info", 0.2))
    elif not is_open and fixed > 0:
        out.append(_reason(
            f"Would add fixed cost of {fmt_money_m(fixed)} (CapEx "
            f"{fmt_money_m(fx['fixedCapexM'])} + OpEx {fmt_money_m(fx['fixedOpexM'])})",
            "cost", "info", 0.4))
    if not is_open:
        r = fx.get("reachableDemandPct", 0.0)
        if r <= 0.05:
            out.append(_reason("No customers within service radius / lead-time limits",
                               "service", "support", 1.2))
        else:
            out.append(_reason(f"Could reach {r:.0f}% of demand within service limits",
                               "service", "info", 0.25))

    lock = fx.get("locked")
    if lock:
        txt = (
            "Locked open by the scenario (existing plant or forceOpenSeed)"
            if lock == "open" else "Closed by the scenario setting"
        ) + " — the counterfactual lifts the lock"
        out.append(_reason(txt, "locked", "info", 0.22))

    out.sort(key=lambda r: -r["score"])
    return out


def build_explain(
    *,
    decidable: list[dict[str, Any]],
    fac_by_id: dict[str, Any],
    y_ids: list[str],
    open_ids: list[str],
    seed_open: list[str],
    locked: dict[str, str],
    capex_cost: dict[str, float],
    opex_cost: dict[str, float],
    cap_info: dict[str, float],
    cmap: dict[str, Any],
    flows: list[dict[str, Any]],
    open_facilities: list[dict[str, Any]],
    shadow_prices: list[dict[str, Any]],
    col_duals: dict[str, float | None],
    reachable: dict[tuple[str, str], set[str]],
    dem_map: dict[tuple[str, str], float],
    total_demand: float,
    base_parts: dict[str, float],
    hard_service: bool,
    solve_seconds: float,
    dual_seconds: float,
    counterfactual: Callable[[str, int, float], dict[str, Any]],
    options: dict[str, Any],
    parse_volume: Callable[..., float],
) -> dict[str, Any]:
    t_all = time.perf_counter()
    open_set = set(open_ids)
    seed_set = set(seed_open)
    base_total = float(base_parts["totalM"])
    tol = max(1e-6, 2e-4 * abs(base_total))  # ~MIP gap noise
    sp_by = {sp["facilityId"]: sp for sp in shadow_prices}
    of_by = {of["id"]: of for of in open_facilities}
    names = {fid: str(fac_by_id.get(fid, {}).get("name") or fid) for fid in y_ids}

    # Flow indexes
    out_by: dict[str, list[dict[str, Any]]] = {}
    in_by: dict[str, list[dict[str, Any]]] = {}
    for fl in flows:
        out_by.setdefault(fl["from"], []).append(fl)
        in_by.setdefault(fl["to"], []).append(fl)
    dc_customers: dict[str, set[str]] = {}
    for fl in flows:
        if fl["echelon"] == "dc→customer":
            dc_customers.setdefault(fl["from"], set()).add(fl["to"])

    reach_dem: dict[str, float] = {}
    for key, fids in reachable.items():
        vol = dem_map.get(key, 0.0)
        for fid in fids:
            reach_dem[fid] = reach_dem.get(fid, 0.0) + vol

    facs: list[dict[str, Any]] = []
    for fid in y_ids:
        f = fac_by_id[fid]
        kind = f.get("kind")
        tier = _tier(kind)
        is_open = fid in open_set
        was_open = fid in seed_set
        decision = (
            ("kept-open" if was_open else "opened")
            if is_open
            else ("closed" if was_open else "kept-closed")
        )
        outs = [fl for fl in out_by.get(fid, []) if fl["echelon"] in OUT_ECHELONS]
        ins = in_by.get(fid, [])
        if tier == "dc":
            delivered = sum(fl["volume"] for fl in outs if fl["echelon"] == "dc→customer")
            custs = {fl["to"] for fl in outs if fl["echelon"] == "dc→customer"}
            assigned = sum(fl["transportCostM"] for fl in outs if fl["echelon"] == "dc→customer")
            inbound = sum(fl["transportCostM"] for fl in ins if fl["echelon"] == "plant→dc")
            share_vol = delivered
        else:
            direct = [fl for fl in outs if fl["echelon"] == "plant→customer"]
            custs = {fl["to"] for fl in direct}
            for fl in outs:
                if fl["echelon"] == "plant→dc":
                    custs |= dc_customers.get(fl["to"], set())
            assigned = sum(fl["transportCostM"] for fl in direct)
            inbound = sum(fl["transportCostM"] for fl in ins if fl["echelon"] == "supplier→plant")
            share_vol = sum(fl["volume"] for fl in outs)
            delivered = share_vol
        thr = float(of_by[fid]["throughput"]) if fid in of_by else 0.0
        c = cmap.get(fid, {})
        cap_max = float(cap_info.get(fid) or c.get("capacityMax")
                        or parse_volume(f.get("capacity"), 1e9))
        util = (thr / cap_max * 100) if (cap_max > 0 and is_open) else 0.0
        fixed_capex = float(capex_cost.get(fid, 0.0))
        fixed_opex = float(opex_cost.get(fid, 0.0))
        fixed = fixed_capex + fixed_opex
        variable = assigned + inbound
        cts = (fixed + variable) if is_open else 0.0
        sp = sp_by.get(fid)
        facs.append({
            "facilityId": fid,
            "name": names[fid],
            "kind": kind,
            "tier": tier,
            "decision": decision,
            "open": is_open,
            "wasOpen": was_open,
            "locked": locked.get(fid),
            "fixedCapexM": round(fixed_capex, 4),
            "fixedOpexM": round(fixed_opex, 4),
            "fixedCostM": round(fixed, 4),
            "inboundTransportM": round(inbound, 4),
            "outboundTransportM": round(assigned, 4),
            "variableCostM": round(variable, 4),
            "throughput": round(thr, 2),
            "capacityMax": round(cap_max, 2),
            "utilizationPct": round(min(100.0, util), 1),
            "capacityDual": None if sp is None else sp.get("shadowPrice"),
            "capacityDualMethod": None if sp is None else sp.get("method"),
            "capacityBinding": bool(sp and sp.get("binding")),
            "openReducedCostM": None
            if col_duals.get(fid) is None
            else round(float(col_duals[fid]), 6),
            "customersServed": len(custs),
            "demandServed": round(share_vol, 2),
            "demandSharePct": round(share_vol / total_demand * 100, 2) if total_demand else 0.0,
            "reachableDemandPct": round(reach_dem.get(fid, 0.0) / total_demand * 100, 1)
            if total_demand else 0.0,
            "costToServeM": round(cts, 4),
            "landedCostPerUnit": round(cts / delivered, 6) if (is_open and delivered > 1e-6) else None,
        })

    # Cost-to-serve share + landed-cost rank within tier
    cts_total = sum(fx["costToServeM"] for fx in facs) or 1.0
    tier_counts: dict[str, int] = {}
    for tier in ("dc", "plant"):
        ranked = sorted(
            (fx for fx in facs if fx["tier"] == tier and fx["landedCostPerUnit"] is not None),
            key=lambda fx: fx["landedCostPerUnit"],
        )
        tier_counts[tier] = len(ranked)
        for i, fx in enumerate(ranked):
            fx["landedCostRank"] = i + 1
    for fx in facs:
        fx["costToServeSharePct"] = round(fx["costToServeM"] / cts_total * 100, 2)
        fx.setdefault("landedCostRank", None)
        if fx["open"]:
            impact = fx["costToServeSharePct"] / 100 + fx["demandSharePct"] / 100
        else:
            rc = abs(fx["openReducedCostM"] or 0.0)
            impact = 0.5 * rc / max(abs(base_total), 1e-9) * 100 + fx["reachableDemandPct"] / 400
        if fx["locked"]:
            impact *= 0.5
        fx["impactScore"] = round(impact, 6)

    # --- Counterfactual targets: all if small, else top-N by impact
    max_cf = int(options.get("maxCounterfactuals", DEFAULT_MAX_COUNTERFACTUALS))
    order = sorted(facs, key=lambda fx: -fx["impactScore"])
    if len(order) <= max_cf:
        targets = order
    else:
        closed = [fx for fx in order if not fx["open"]]
        reserve = min(len(closed), max(1, max_cf // 3)) if max_cf > 1 else 0
        opened = [fx for fx in order if fx["open"]][: max_cf - reserve]
        targets = opened + closed[: max_cf - len(opened)]
        targets.sort(key=lambda fx: -fx["impactScore"])
    target_ids = {fx["facilityId"] for fx in targets}

    per_limit = options.get("timeLimitSec")
    if per_limit is None:
        per_limit = min(30.0, max(5.0, 4.0 * float(solve_seconds or 0.0)))
    budget = float(options.get("budgetSec", DEFAULT_BUDGET_SEC))
    t_cf0 = time.perf_counter()
    n_cf = 0
    for fx in targets:
        fid = fx["facilityId"]
        elapsed = time.perf_counter() - t_cf0
        if elapsed >= budget:
            fx["counterfactual"] = {"evaluated": False, "reason": "time budget exhausted"}
            continue
        flip_to = 0 if fx["open"] else 1
        r = counterfactual(fid, flip_to, max(1.0, min(per_limit, budget - elapsed)))
        n_cf += 1
        cfo: dict[str, Any] = {
            "evaluated": True,
            "flipTo": "open" if flip_to else "closed",
            "status": r.get("status"),
            "seconds": r.get("seconds"),
            "lockLifted": bool(fx["locked"]),
        }
        parts = r.get("parts")
        if parts:
            d = parts["totalM"] - base_total
            var_base = base_parts["transportM"] + base_parts["laneFixedM"]
            var_cf = parts["transportM"] + parts["laneFixedM"]
            pen_d = parts["uncoveredPenaltyM"] - base_parts["uncoveredPenaltyM"]
            cf_open = set(r.get("openIds") or [])
            cfo.update({
                "costM": round(parts["totalM"], 4),
                "deltaM": round(d, 4),
                "deltaPct": round(d / base_total * 100, 3) if base_total else None,
                "servicePct": round(parts["servicePct"], 2),
                "serviceDeltaPct": round(parts["servicePct"] - base_parts["servicePct"], 2),
                "fixedDeltaM": round(
                    parts["fixedCapexM"] + parts["fixedOpexM"]
                    - base_parts["fixedCapexM"] - base_parts["fixedOpexM"], 4),
                "variableDeltaM": round(var_cf - var_base, 4),
                "penaltyDeltaM": round(pen_d, 4),
                "operatingDeltaM": round(d - pen_d, 4),
                "unservedUnits": round(parts["uncovered"], 2),
                "unservedDeltaUnits": round(parts["uncovered"] - base_parts["uncovered"], 2),
                "transportDeltaM": round(parts["transportM"] - base_parts["transportM"], 4),
                "alsoOpens": sorted(cf_open - open_set - {fid}),
                "alsoCloses": sorted(open_set - cf_open - {fid}),
                "withinGap": abs(d) <= tol,
            })
        elif r.get("error"):
            cfo["error"] = r["error"]
        fx["counterfactual"] = cfo
    cf_seconds = time.perf_counter() - t_cf0
    for fx in facs:
        if "counterfactual" not in fx:
            fx["counterfactual"] = {
                "evaluated": False,
                "reason": f"outside top {max_cf} by impact" if fx["facilityId"] not in target_ids
                else "skipped",
            }
        cf = fx["counterfactual"]
        fx["flipCostM"] = cf.get("deltaM") if cf.get("evaluated") else None
        fx["flipOperatingCostM"] = cf.get("operatingDeltaM") if cf.get("evaluated") else None

    for fx in facs:
        fx["_names"] = names
        fx["reasons"] = facility_reasons(
            fx, base_total, tol, hard_service, tier_counts.get(fx["tier"], 0),
            total_demand,
        )
        del fx["_names"]
        fx["headline"] = fx["reasons"][0]["text"] if fx["reasons"] else ""

    def _rank_key(fx: dict[str, Any]) -> tuple:
        cf = fx["counterfactual"]
        infeasible = cf.get("evaluated") and cf.get("status") == "infeasible"
        delta = abs(cf.get("deltaM") or 0.0) if cf.get("evaluated") else 0.0
        changed = fx["decision"] in ("opened", "closed")
        return (0 if infeasible else 1, -(delta + (tol if changed else 0.0)), -fx["impactScore"])

    facs.sort(key=_rank_key)
    top_n = int(options.get("topDecisions", DEFAULT_TOP_DECISIONS))
    top_opened = [fx["facilityId"] for fx in facs if fx["open"]][:top_n]
    top_closed = [fx["facilityId"] for fx in facs if not fx["open"]][:top_n]

    opened = [fx for fx in facs if fx["decision"] == "opened"]
    closed = [fx for fx in facs if fx["decision"] == "closed"]
    kept = [fx for fx in facs if fx["decision"] == "kept-open"]
    evaluated = [fx for fx in facs if fx["counterfactual"].get("deltaM") is not None]
    bits = []
    if opened:
        bits.append("opened " + ", ".join(fx["name"] for fx in opened[:4]))
    if closed:
        bits.append("closed " + ", ".join(fx["name"] for fx in closed[:4]))
    bits.append(f"kept {len(kept)} existing site(s) open")
    headline = "The MIP " + "; ".join(bits) + "."
    if evaluated:
        best = max(evaluated, key=lambda fx: fx["counterfactual"]["deltaM"])
        bcf = best["counterfactual"]
        verb = "closing" if best["open"] else "opening"
        if (bcf.get("unservedDeltaUnits") or 0) > 0.5:
            headline += (
                f" Costliest flip: {verb} {best['name']} strands "
                f"{bcf['unservedDeltaUnits']:,.0f} units (service {bcf['servicePct']:.1f}%)."
            )
        elif bcf["deltaM"] > tol:
            headline += (
                f" Costliest flip: {verb} {best['name']} "
                f"(+{fmt_money_m(bcf['deltaM'])})."
            )

    return {
        "enabled": True,
        "method": "counterfactual-mip-resolve+lp-duals",
        "baseCostM": round(base_total, 4),
        "baseServicePct": round(base_parts["servicePct"], 2),
        "gapToleranceM": round(tol, 6),
        "headline": headline,
        "facilities": facs,
        "topOpenedIds": top_opened,
        "topClosedIds": top_closed,
        "maxCounterfactuals": max_cf,
        "timing": {
            "solveSeconds": solve_seconds,
            "dualSeconds": dual_seconds,
            "counterfactualCount": n_cf,
            "counterfactualSeconds": round(cf_seconds, 3),
            "perSolveTimeLimitSec": round(float(per_limit), 2),
            "budgetSec": budget,
            "explainSeconds": round(time.perf_counter() - t_all, 3),
        },
        "note": (
            "Flip cost = MIP objective with the facility forced to the opposite "
            "state (all other sites re-optimized, scenario lock lifted) minus the "
            "base objective, in model-$M. Deltas within gapToleranceM are solver-"
            "gap noise. Cost-to-serve assigns each transport arc once (DC owns "
            "plant→DC and DC→customer; plant owns supplier→plant and direct)."
        ),
    }


__all__ = ["build_explain", "explain_options", "facility_reasons", "fmt_money_m", "math"]
