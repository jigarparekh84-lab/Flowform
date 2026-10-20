"""Pre-run guardrails (FF-108): fast checks on an /optimize payload before the
MIP runs. Never changes solve results; it only reports.

``validate_optimize(payload, deep=False)`` returns::

    {ok, blocking, errorCount, warningCount,
     issues: [{code, level: error|warning, message, entities, fix}],
     shortfalls: {laneCapacity: [...], minThroughput: [...]},
     deep?: {status, rootCauses}}

``deep=True`` additionally runs the real solve (explain/baseline off) and turns
Infeasible root causes (MIN_THROUGHPUT_CONFLICT, LANE_CAPACITY_CONFLICT, ...)
into blocking issues with the engine's own shortfall tables.
"""

from __future__ import annotations

import math
from collections import Counter
from typing import Any

#: Model volume units are 1,000 physical units; anything above this per row is
#: almost certainly entered in physical units.
DEMAND_UNIT_SANITY_MAX = 1e7
LANE_COST_SANITY_MAX = 1000.0  # $/physical unit


def _num(v: Any) -> float | None:
    if v is None or v == "":
        return None
    if isinstance(v, bool):
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return math.nan
    return f


def validate_optimize(payload: dict[str, Any], *, deep: bool = False) -> dict[str, Any]:
    issues: list[dict[str, Any]] = []
    lane_short: list[dict[str, Any]] = []
    min_short: list[dict[str, Any]] = []

    def add(code: str, level: str, message: str, entities: list[str] | None = None, fix: str | None = None):
        issues.append({"code": code, "level": level, "message": message,
                       "entities": entities or [], "fix": fix})

    net = payload.get("network") if isinstance(payload, dict) else None
    cons = (payload.get("constraints") if isinstance(payload, dict) else None) or {}
    if not isinstance(net, dict):
        add("NO_NETWORK", "error", "The model has no network.", fix="Load a sample, import data or use the onboarding wizard.")
        return _finish(issues, lane_short, min_short, None)

    nodes = [n for n in (net.get("nodes") or []) if isinstance(n, dict)]
    lanes = [l for l in (net.get("lanes") or []) if isinstance(l, dict)]
    facs = [f for f in (cons.get("facilities") or []) if isinstance(f, dict)]
    node_by_id = {str(n.get("id")): n for n in nodes}

    dupes = [i for i, c in Counter(str(n.get("id")) for n in nodes).items() if c > 1]
    if dupes:
        add("DUPLICATE_NODE_ID", "error", f"{len(dupes)} site id(s) are used more than once.", dupes,
            "Give every site a unique id.")

    # --- demand ---------------------------------------------------------------
    demand: dict[str, float] = {}
    raw_dem = net.get("demandVolume") or {}
    rows = raw_dem.items() if isinstance(raw_dem, dict) else []
    for cid, v in rows:
        f = _num(v)
        if f is None:
            continue
        if math.isnan(f):
            add("NON_NUMERIC_VALUE", "error", f"Demand for {cid} is not a number ({v!r}).", [str(cid)], "Enter a number.")
            continue
        if f < 0:
            add("NEGATIVE_VALUE", "error", f"Demand for {cid} is negative ({f:g}).", [str(cid)], "Demand must be ≥ 0.")
            continue
        if f > DEMAND_UNIT_SANITY_MAX:
            add("UNIT_SANITY", "warning", f"Demand for {cid} is {f:,.0f} model units — volumes are in thousands of units; check the unit.",
                [str(cid)], "Divide physical units by 1,000.")
        if str(cid) not in node_by_id:
            add("UNKNOWN_DEMAND_NODE", "error", f"Demand row references unknown site {cid}.", [str(cid)], "Add the site or remove the row.")
            continue
        if f > 0:
            demand[str(cid)] = f
    total_demand = sum(demand.values())
    if total_demand <= 0:
        add("NO_DEMAND", "error", "There is no customer demand to serve.", fix="Add demand (customers × volume).")

    # --- facilities -------------------------------------------------------------
    if not facs:
        add("NO_FACILITIES", "error", "No DCs or plants are defined.", fix="Add at least one existing or candidate site.")
    min_open_total = 0.0
    for f in facs:
        fid = str(f.get("nodeId") or f.get("id"))
        if fid not in node_by_id:
            add("UNKNOWN_FACILITY_NODE", "error", f"Facility constraint references unknown site {fid}.", [fid])
        cmin, cmax = _num(f.get("capacityMin")), _num(f.get("capacityMax"))
        for label, val in (("capacityMin", cmin), ("capacityMax", cmax)):
            if val is not None and math.isnan(val):
                add("NON_NUMERIC_VALUE", "error", f"{fid} {label} is not a number.", [fid])
            elif val is not None and val < 0:
                add("NEGATIVE_VALUE", "error", f"{fid} {label} is negative.", [fid])
        if cmin and cmax and not math.isnan(cmin) and not math.isnan(cmax) and cmin > cmax:
            add("MIN_ABOVE_MAX_CAPACITY", "error", f"{fid} minimum throughput {cmin:,.0f} exceeds its capacity {cmax:,.0f}.", [fid],
                "Lower capacityMin or raise capacityMax.")
        if (f.get("status") == "open") and cmin and not math.isnan(cmin) and cmin > 0:
            kind = (node_by_id.get(fid) or {}).get("kind")
            if kind != "plant":
                min_open_total += cmin
    if total_demand > 0 and min_open_total > total_demand:
        add("MIN_THROUGHPUT_EXCEEDS_DEMAND", "warning",
            f"Open DCs require {min_open_total:,.0f} minimum throughput but total demand is {total_demand:,.0f}; some must close.",
            fix="Lower capacityMin or allow sites to close.")

    # --- lanes ------------------------------------------------------------------
    inbound: dict[str, list[dict[str, Any]]] = {}
    for l in lanes:
        a, b = str(l.get("from")), str(l.get("to"))
        lid = str(l.get("id") or f"{a}->{b}")
        missing = [x for x in (a, b) if x not in node_by_id]
        if missing:
            add("UNKNOWN_LANE_ENDPOINT", "error", f"Lane {lid} references unknown site(s) {', '.join(missing)}.", [lid])
            continue
        c = _num(l.get("costPerUnit"))
        if c is not None and (math.isnan(c) or c < 0):
            add("NEGATIVE_VALUE" if c == c else "NON_NUMERIC_VALUE", "error", f"Lane {lid} cost per unit is invalid ({l.get('costPerUnit')!r}).", [lid])
        elif c is not None and c > LANE_COST_SANITY_MAX:
            add("UNIT_SANITY", "warning", f"Lane {lid} costs ${c:,.2f} per unit — check the unit ($ per physical unit).", [lid])
        inbound.setdefault(b, []).append({**l, "_id": lid})

    hard = bool(cons.get("hardServiceConstraints"))
    for cid, d in demand.items():
        n = node_by_id[cid]
        has_coords = n.get("lat") is not None and n.get("lng") is not None
        ins = inbound.get(cid, [])
        if not ins and not has_coords:
            add("UNREACHABLE_CUSTOMER", "error",
                f"{n.get('name') or cid} has demand {d:,.0f} but no inbound lane and no coordinates — nothing can serve it.",
                [cid], "Add a lane into this customer or give it lat/lng.")
            continue
        caps = [_num(l.get("capacityUnits")) for l in ins]
        if ins and all(c is not None and not math.isnan(c) for c in caps):
            cap = sum(caps)  # type: ignore[arg-type]
            if cap < d:
                row = {"customerId": cid, "name": n.get("name") or cid, "demand": d,
                       "inboundLaneCapacity": cap, "shortBy": d - cap, "laneIds": [l["_id"] for l in ins]}
                lane_short.append(row)
                add("LANE_CAPACITY_BELOW_DEMAND", "warning" if has_coords and not hard else "error",
                    f"Lanes into {row['name']} carry {cap:,.0f} but demand is {d:,.0f} (short {d - cap:,.0f}).",
                    [cid, *row["laneIds"]], "Raise capacityUnits, add a lane or mode, or accept off-lane service.")

    deep_out = None
    if deep and not any(i["level"] == "error" for i in issues):
        from .solver import solve_optimize

        body = solve_optimize({**payload, "explain": False, "computeBaseline": False})
        rep = body.get("infeasibilityReport") or {}
        deep_out = {"status": body.get("status"), "rootCauses": rep.get("rootCauses") or []}
        if body.get("status") == "Infeasible":
            for h in rep.get("hints") or []:
                add(h["code"], "error", h.get("message", h["code"]), h.get("entities") or [], h.get("hint"))
                for s in h.get("shortfalls") or []:
                    if "laneId" in s:
                        lane_short.append(s)
                    elif "facilityId" in s:
                        min_short.append(s)
    return _finish(issues, lane_short, min_short, deep_out)


def _finish(issues, lane_short, min_short, deep_out) -> dict[str, Any]:
    errors = sum(1 for i in issues if i["level"] == "error")
    out = {
        "ok": errors == 0,
        "blocking": errors > 0,
        "errorCount": errors,
        "warningCount": len(issues) - errors,
        "issues": sorted(issues, key=lambda i: (i["level"] != "error", i["code"])),
        "shortfalls": {"laneCapacity": lane_short, "minThroughput": min_short},
    }
    if deep_out is not None:
        out["deep"] = deep_out
    return out
