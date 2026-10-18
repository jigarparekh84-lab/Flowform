"""
Industrial fixed-charge multi-echelon network-design MIP (PuLP + HiGHS/CBC).

Model (depth slices 1–4, 7):
  - Binary open/close for DCs (and optional plants) with fixed CapEx + OpEx
  - Capacitated facilities; optional minimum throughput when open
  - Flow conservation plant → DC → customer
  - Optional supplier → plant when BOM / bomDemand present in payload
  - Variable transport cost on lanes (or distance proxy)
  - Soft uncovered-demand penalty OR hard service constraints (flag)
  - CapEx budget + max open facilities
  - SKU / product-group aware flows when enterprise pack has multiple SKUs
    (auto-aggregate to product groups if commodity count exceeds threshold)
  - Facility product capability constraints; demand satisfaction per SKU/group
  - Post-MIP LP (binaries fixed) for capacity shadow prices / duals
  - Best-effort infeasibility diagnostics (no full IIS)
  - Depth 7: transport mode choice per lane (truck / rail / intermodal …) with
    per-mode $/unit, transit days, CO2 factor, optional capacity and optional
    fixed activation charge (binary); lane + lane-mode capacity constraints;
    hard service filters modes by transit; lane capacity LP duals; mode mix.
    Networks without mode/capacity data build the identical legacy model.
  - Depth 8: facility capacity shadow prices read directly from HiGHS row
    duals (same pure-LP pass as lanes, all binaries fixed) + optional
    ``explain`` block: per-facility open/close rationale, cost-to-serve,
    capacity dual and counterfactual re-solves (facility forced to the
    opposite state) with $ flip penalty, service impact and ranked
    plain-language reasons (see app/explain.py).
"""

from __future__ import annotations

import math
import time
import re
from typing import Any

import pulp

from .diagnostics import diagnose_network_conflicts

# D-05: one model volume unit = 1,000 physical units (see header). Lane
# co2KgPerUnit and $/unit rates are per physical unit, so CO2 (kg) reported
# for a flow of ``vol`` model units is co2KgPerUnit × vol × 1,000.
PHYSICAL_UNITS_PER_MODEL_UNIT = 1000.0
from .explain import CF_MIP_GAP_REL, build_explain, explain_options

MILES_PER_UNIT = 12.0

# ---------------------------------------------------------------------------
# Cost units (one convention for every objective term)
#
#   * money in the objective / breakdown / explain is $M ("model-$M")
#   * lane ``costPerUnit`` is $ per physical unit; the model converts it with
#     ``costPerUnit / VOLUME_UNIT_SCALE`` → $M per model volume unit, i.e. one
#     model volume unit = 1,000 physical units ("k units")
#   * facility ``fixedCapexM`` / ``fixedOpexM`` are already $M
#   * off-lane (no lane rate) transport and the unmet-demand penalty are
#     configured in $ per physical unit(-mile) and converted the same way
# ---------------------------------------------------------------------------
VOLUME_UNIT_SCALE = 1000.0  # physical units per model volume unit
# $/unit-mile fallback when the network has no rated lanes to derive from
# (~$1.50 per unit per 1,000 mi, mid-range TL/LTL planning rate).
DEFAULT_RATE_PER_UNIT_MILE = 0.0015
# Off-lane arcs are priced at median lane $/unit-mile × this premium
# (spot / un-contracted freight premium). Configurable: offLanePremium.
DEFAULT_OFF_LANE_PREMIUM = 1.35
# Unmet demand: $/unit lost-margin + expedite proxy. Default is the larger of
# this floor and UNCOVERED_PENALTY_LANE_MULTIPLE × median lane $/unit, so it
# always sits well above any landed cost. Configurable: uncoveredPenaltyPerUnit.
DEFAULT_UNCOVERED_PENALTY_PER_UNIT = 15.0
UNCOVERED_PENALTY_LANE_MULTIPLE = 10.0
# Legacy-named module defaults in model units ($M per model unit[-mile]).
# Callers that know the network should use resolve_cost_scale() instead.
DEFAULT_TRANSPORT_PER_MILE = DEFAULT_RATE_PER_UNIT_MILE / VOLUME_UNIT_SCALE
UNCOVERED_PENALTY = DEFAULT_UNCOVERED_PENALTY_PER_UNIT / VOLUME_UNIT_SCALE
DEFAULT_MAX_COMMODITIES = 8
AGG_PRODUCT_ID = "__total__"


def _safe_name(*parts: object) -> str:
    """PuLP replaces '-' with '_' in constraint names — normalize up front."""
    raw = "_".join(str(p) for p in parts)
    return (
        raw.replace("-", "_")
        .replace("→", "_")
        .replace(" ", "_")
        .replace(".", "_")
    )


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
        return pulp.PULP_CBC_CMD(msg=False, timeLimit=60), "pulp-cbc"
    raise RuntimeError(
        "No MIP solver available. Install highspy (pip install highspy) "
        "or ensure PuLP CBC binaries are present."
    )


def _facility_status(f: dict[str, Any], cmap: dict[str, Any]) -> str:
    c = cmap.get(f["id"], {})
    status = c.get("status")
    if status is None:
        return "candidate" if f.get("kind") == "candidate" else "open"
    return status


def _open_capex(fid: str, fac_by_id: dict[str, Any], cmap: dict[str, Any]) -> float:
    c = cmap.get(fid, {})
    f = fac_by_id[fid]
    status = _facility_status(f, cmap)
    if status == "open":
        if c.get("fixedCapexM") is not None and status != "open":
            return float(c["fixedCapexM"])
        return 0.0
    if c.get("fixedCapexM") is not None:
        return float(c["fixedCapexM"])
    kind = f.get("kind")
    if kind == "candidate":
        return 6.0
    if kind == "plant":
        return 8.0
    return 4.0


def _open_opex(fid: str, fac_by_id: dict[str, Any], cmap: dict[str, Any]) -> float:
    c = cmap.get(fid, {})
    if c.get("fixedOpexM") is not None:
        return float(c["fixedOpexM"])
    f = fac_by_id[fid]
    kind = f.get("kind")
    if kind == "plant":
        return 1.2
    if kind == "candidate":
        return 0.9
    return 0.7


def _lane_cost_map(lanes: list[dict[str, Any]]) -> dict[tuple[str, str], float]:
    out: dict[tuple[str, str], float] = {}
    for lane in lanes:
        fr, to = lane.get("from"), lane.get("to")
        if not fr or not to:
            continue
        cpu = _num(lane.get("costPerUnit"))
        if cpu is None:
            # Multi-mode lane without a headline rate → cheapest mode
            mode_costs = [
                c
                for c in (_num(m.get("costPerUnit")) for m in _lane_modes_raw(lane))
                if c is not None
            ]
            cpu = min(mode_costs) if mode_costs else 0.0
        out[(str(fr), str(to))] = cpu / 1000.0
    return out


def _lane_lead_map(lanes: list[dict[str, Any]]) -> dict[tuple[str, str], float]:
    out: dict[tuple[str, str], float] = {}
    for lane in lanes:
        fr, to = lane.get("from"), lane.get("to")
        if not fr or not to:
            continue
        if lane.get("leadDays") is not None:
            out[(str(fr), str(to))] = float(lane["leadDays"])
        else:
            mode_leads = [
                d
                for d in (_num(m.get("leadDays")) for m in _lane_modes_raw(lane))
                if d is not None
            ]
            if mode_leads:
                out[(str(fr), str(to))] = min(mode_leads)
    return out


def _cfg_num(sources: list[dict[str, Any]], *keys: str) -> float | None:
    for src in sources:
        if not isinstance(src, dict):
            continue
        for k in keys:
            v = _num(src.get(k))
            if v is not None:
                return v
    return None


def resolve_cost_scale(payload: dict[str, Any]) -> dict[str, Any]:
    """
    Network-consistent off-lane rate + unmet-demand penalty.

    Off-lane arcs (no lane rate) are priced at the network's median lane
    $/unit-mile × ``offLanePremium`` (default 1.35), so a distance-proxy arc
    costs about what a contracted lane of the same length would, plus a spot
    premium. ``offLaneRatePerUnitMile`` ($/unit-mile) overrides the derivation.

    Unmet demand costs ``uncoveredPenaltyPerUnit`` $/unit (default
    max($15, 10 × median lane $/unit)). Both are read from ``constraints``,
    then ``network.costFactors`` / ``costFactors``. Returned ``*M`` values are
    in model units ($M per model volume unit[-mile]).
    """
    network = payload.get("network") or {}
    constraints = payload.get("constraints") or {}
    sources = [constraints, network.get("costFactors") or {}, payload.get("costFactors") or {}]
    by_id = {str(n.get("id")): n for n in (network.get("nodes") or []) if n.get("id")}

    per_mile: list[float] = []
    per_unit: list[float] = []
    for lane in network.get("lanes") or []:
        a, b = by_id.get(str(lane.get("from"))), by_id.get(str(lane.get("to")))
        cpu = _num(lane.get("costPerUnit"))
        if cpu is None:
            mode_costs = [
                c for c in (_num(m.get("costPerUnit")) for m in _lane_modes_raw(lane))
                if c is not None
            ]
            cpu = min(mode_costs) if mode_costs else None
        if cpu is None or cpu <= 0:
            continue
        per_unit.append(cpu)
        if a is None or b is None:
            continue
        miles = _dist_miles(a, b)
        if miles >= 25.0:  # very short lanes are dominated by handling, not miles
            per_mile.append(cpu / miles)

    def _median(xs: list[float]) -> float | None:
        if not xs:
            return None
        ys = sorted(xs)
        m = len(ys) // 2
        return ys[m] if len(ys) % 2 else (ys[m - 1] + ys[m]) / 2

    med_mile = _median(per_mile)
    med_unit = _median(per_unit)
    premium = _cfg_num(sources, "offLanePremium")
    if premium is None or premium <= 0:
        premium = DEFAULT_OFF_LANE_PREMIUM
    explicit_rate = _cfg_num(sources, "offLaneRatePerUnitMile")
    if explicit_rate is not None and explicit_rate > 0:
        rate, rate_src = explicit_rate, "configured"
    elif med_mile is not None:
        rate, rate_src = med_mile * premium, "median-lane×premium"
    else:
        rate, rate_src = DEFAULT_RATE_PER_UNIT_MILE, "default (no rated lanes)"

    explicit_pen = _cfg_num(sources, "uncoveredPenaltyPerUnit")
    if explicit_pen is not None and explicit_pen > 0:
        pen, pen_src = explicit_pen, "configured"
    else:
        pen = max(
            DEFAULT_UNCOVERED_PENALTY_PER_UNIT,
            UNCOVERED_PENALTY_LANE_MULTIPLE * (med_unit or 0.0),
        )
        pen_src = "default"
    legacy_pen = _cfg_num(sources, "uncoveredPenaltyM")
    return {
        "currency": "$M",
        "volumeUnitScale": VOLUME_UNIT_SCALE,
        "volumeUnit": "model unit = 1,000 physical units (lane costPerUnit is $/unit)",
        "medianLaneRatePerUnitMile": None if med_mile is None else round(med_mile, 6),
        "medianLaneCostPerUnit": None if med_unit is None else round(med_unit, 4),
        "ratedLaneCount": len(per_mile),
        "offLanePremium": round(premium, 4),
        "offLaneRatePerUnitMile": round(rate, 6),
        "offLaneRateSource": rate_src,
        "uncoveredPenaltyPerUnit": round(pen, 4),
        "uncoveredPenaltySource": pen_src,
        "legacyUncoveredPenaltyMIgnored": legacy_pen,
        # model units
        "offLaneRateM": rate / VOLUME_UNIT_SCALE,
        "uncoveredPenaltyM": pen / VOLUME_UNIT_SCALE,
    }


def _transport_unit_cost(
    fr: dict[str, Any],
    to: dict[str, Any],
    lane_costs: dict[tuple[str, str], float],
    per_mile_m: float | None = None,
) -> tuple[float, float]:
    """Return (unit_cost_$M_per_model_unit, miles)."""
    miles = _dist_miles(fr, to)
    key = (fr["id"], to["id"])
    if key in lane_costs:
        return lane_costs[key], miles
    rate = DEFAULT_TRANSPORT_PER_MILE if per_mile_m is None else per_mile_m
    return miles * rate, miles


def _lead_days_for(
    fr: dict[str, Any],
    to: dict[str, Any],
    lane_leads: dict[tuple[str, str], float],
    miles: float,
) -> float:
    key = (fr["id"], to["id"])
    if key in lane_leads:
        return lane_leads[key]
    # Proxy: ~400 mi/day road
    return miles / 400.0


def _arc_allowed(
    fr: dict[str, Any],
    to: dict[str, Any],
    miles: float,
    radius: float,
    lane_costs: dict[tuple[str, str], float],
    lane_leads: dict[tuple[str, str], float],
    max_lead: float | None,
    radius_scale: float = 1.0,
) -> bool:
    key = (fr["id"], to["id"])
    within = miles <= radius * radius_scale + 1e-6 or key in lane_costs
    if not within:
        return False
    if max_lead is not None:
        lead = _lead_days_for(fr, to, lane_leads, miles)
        if lead > max_lead + 1e-9:
            return False
    return True


# ---------------------------------------------------------------------------
# Depth slice 7 — lane capacity + transport mode choice
# ---------------------------------------------------------------------------

DEFAULT_MODE_KEY = ""  # legacy single-mode arc (variable keys unchanged)
DEFAULT_MODE_LABEL = "Truck"
ROAD_MILES_PER_DAY = 400.0
DEFAULT_EMISSION_KG_PER_TON_MILE: dict[str, float] = {
    "truck": 0.161,
    "rail": 0.022,
    "intermodal": 0.065,
    "ocean": 0.01,
    "air": 0.98,
    "parcel": 0.25,
}
_MODE_ALIASES = {
    "truck": "Truck",
    "ftl": "Truck",
    "ltl": "Truck",
    "road": "Truck",
    "rail": "Rail",
    "train": "Rail",
    "intermodal": "Intermodal",
    "imdl": "Intermodal",
    "ocean": "Ocean",
    "sea": "Ocean",
    "air": "Air",
    "parcel": "Parcel",
}


def _num(v: Any) -> float | None:
    if v is None or isinstance(v, bool):
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if math.isnan(f):
        return None
    return f


def _mode_label(raw: Any, fallback: str = DEFAULT_MODE_LABEL) -> str:
    s = str(raw or "").strip()
    if not s:
        return fallback
    return _MODE_ALIASES.get(s.lower(), s)


def _lane_modes_raw(lane: dict[str, Any]) -> list[dict[str, Any]]:
    raw = lane.get("modes") or lane.get("modeOptions")
    if isinstance(raw, list):
        return [m for m in raw if isinstance(m, dict)]
    return []


def _lane_capacity(lane: dict[str, Any]) -> float | None:
    for k in ("capacityUnits", "capacity", "maxUnits"):
        f = _num(lane.get(k))
        if f is not None and f > 0:
            return f
    return None


def _build_lane_options(
    lanes: list[dict[str, Any]],
    constraints: dict[str, Any],
    log: list[str],
) -> tuple[dict[tuple[str, str], dict[str, Any]], dict[str, Any]]:
    """
    Normalize lanes into per-(from,to) mode options.

    lane_opts[(from, to)] = {
        laneId, capacity (lane total, all modes + products) | None,
        explicitModes: bool,
        options: [{key, label, costM | None, leadDays | None, co2KgPerUnit | None,
                   capacity | None, fixedCostM, laneId}]
    }

    Legacy lanes (no ``modes``) yield one option with key "" so the MIP keeps
    the exact pre-slice-7 variables. Duplicate from→to rows with distinct
    ``mode`` labels become mode alternatives (each row's capacity = that
    mode's capacity); same-mode duplicates keep legacy last-row-wins.
    """
    enforce_cap = constraints.get("enforceLaneCapacity", True) is not False
    merge_dup = constraints.get("mergeDuplicateLaneModes", True) is not False
    out: dict[tuple[str, str], dict[str, Any]] = {}
    stats = {
        "lanesWithModes": 0,
        "modeOptions": 0,
        "capacitatedLanes": 0,
        "capacitatedLaneModes": 0,
        "fixedCostLaneModes": 0,
        "mergedDuplicateLanes": 0,
        "enforceLaneCapacity": enforce_cap,
    }

    for i, lane in enumerate(lanes):
        fr, to = lane.get("from"), lane.get("to")
        if not fr or not to:
            continue
        key = (str(fr), str(to))
        lane_id = str(lane.get("id") or f"{fr}->{to}")
        lane_cap = _lane_capacity(lane) if enforce_cap else None
        base_cost = _num(lane.get("costPerUnit"))
        base_lead = _num(lane.get("leadDays"))
        base_co2 = _num(lane.get("co2KgPerUnit"))
        modes_raw = _lane_modes_raw(lane)
        entry: dict[str, Any]
        if modes_raw:
            opts: list[dict[str, Any]] = []
            seen: set[str] = set()
            for m in modes_raw:
                label = _mode_label(m.get("mode") or m.get("id") or m.get("name"))
                mk = label.lower()
                if mk in seen:
                    continue
                seen.add(mk)
                cost = _num(m.get("costPerUnit"))
                if cost is None:
                    cost = base_cost
                lead = _num(m.get("leadDays"))
                if lead is None:
                    lead = _num(m.get("transitDays"))
                if lead is None:
                    lead = base_lead
                cap = _num(m.get("capacity"))
                if cap is None:
                    cap = _num(m.get("capacityUnits"))
                cap = cap if (enforce_cap and cap is not None and cap > 0) else None
                fixed = max(0.0, _num(m.get("fixedCostM")) or 0.0)
                co2 = _num(m.get("co2KgPerUnit"))
                if co2 is None:
                    co2 = base_co2
                opts.append(
                    {
                        "key": mk,
                        "label": label,
                        "costM": None if cost is None else cost / 1000.0,
                        "leadDays": lead,
                        "co2KgPerUnit": co2,
                        "capacity": cap,
                        "fixedCostM": fixed,
                        "laneId": lane_id,
                    }
                )
            entry = {
                "laneId": lane_id,
                "capacity": lane_cap,
                "explicitModes": True,
                "options": opts,
            }
        else:
            entry = {
                "laneId": lane_id,
                "capacity": lane_cap,
                "explicitModes": False,
                "options": [
                    {
                        "key": DEFAULT_MODE_KEY,
                        "label": _mode_label(lane.get("mode")),
                        # Legacy: missing costPerUnit → 0 (not distance proxy)
                        "costM": (base_cost or 0.0) / 1000.0,
                        "leadDays": base_lead,
                        "co2KgPerUnit": base_co2,
                        "capacity": None,
                        "fixedCostM": 0.0,
                        "laneId": lane_id,
                    }
                ],
            }

        prev = out.get(key)
        if prev is None or not merge_dup:
            out[key] = entry
            continue
        same_single = (
            not prev["explicitModes"]
            and not entry["explicitModes"]
            and prev["options"][0]["label"].lower()
            == entry["options"][0]["label"].lower()
        )
        if same_single:
            out[key] = entry  # legacy last-row-wins
            continue
        merged: dict[str, dict[str, Any]] = {}
        lane_caps: list[float] = []
        for src in (prev, entry):
            if src["explicitModes"] and src["capacity"] is not None:
                lane_caps.append(float(src["capacity"]))
            for o in src["options"]:
                o2 = dict(o)
                if not src["explicitModes"]:
                    o2["key"] = o2["label"].lower()
                    if o2["capacity"] is None:
                        o2["capacity"] = src["capacity"]
                merged[o2["key"]] = o2
        out[key] = {
            "laneId": prev["laneId"],
            "capacity": min(lane_caps) if lane_caps else None,
            "explicitModes": True,
            "options": list(merged.values()),
        }
        stats["mergedDuplicateLanes"] += 1

    for entry in out.values():
        if entry["explicitModes"]:
            stats["lanesWithModes"] += 1
            stats["modeOptions"] += len(entry["options"])
        if entry["capacity"] is not None:
            stats["capacitatedLanes"] += 1
        for o in entry["options"]:
            if o["capacity"] is not None:
                stats["capacitatedLaneModes"] += 1
            if o["fixedCostM"] > 0:
                stats["fixedCostLaneModes"] += 1

    if stats["lanesWithModes"] or stats["capacitatedLanes"]:
        log.append(
            f"Lanes: {stats['lanesWithModes']} multi-mode lane(s) · "
            f"{stats['modeOptions']} mode option(s) · "
            f"{stats['capacitatedLanes']} lane cap(s) · "
            f"{stats['capacitatedLaneModes']} lane-mode cap(s) · "
            f"{stats['fixedCostLaneModes']} fixed-charge lane-mode(s)"
            + (
                f" · merged {stats['mergedDuplicateLanes']} duplicate lane row(s)"
                if stats["mergedDuplicateLanes"]
                else ""
            )
            + "."
        )
    if not enforce_cap:
        log.append("Lane capacity enforcement OFF (enforceLaneCapacity=false).")
    return out, stats


def _co2_kg_per_unit(
    label: str,
    explicit: float | None,
    miles: float,
    emission_factors: dict[str, float],
    tons_per_unit: float,
) -> float:
    if explicit is not None:
        return float(explicit)
    f = emission_factors.get(
        label.lower(), emission_factors.get("truck", DEFAULT_EMISSION_KG_PER_TON_MILE["truck"])
    )
    return miles * f * tons_per_unit


# ---------------------------------------------------------------------------
# Unit weights (CO2 basis)
#
# CO2 (kg) on an arc = miles × mode factor (kg / tonne-mile) × tonnes moved,
# tonnes = physical units × unit weight. Weight resolves per commodity:
#   SKU unitWeightKg → product-group unitWeightKg → project default
#   (constraints.defaultUnitWeightKg → costFactors.defaultUnitWeightKg →
#   legacy constraints.tonsPerUnit × 1000) → DEFAULT_UNIT_WEIGHT_KG.
# constraints.co2WeightBasis = "legacy-1t" restores the pre-weights behaviour
# (1 tonne per physical unit) for old payloads / regression comparisons.
# Explicit lane-mode co2KgPerUnit stays per physical unit (weight-independent).
# ---------------------------------------------------------------------------
DEFAULT_UNIT_WEIGHT_KG = 20.0
KM_PER_MILE = 1.609344


MIN_PLAUSIBLE_UNIT_KG = 0.005
MAX_PLAUSIBLE_UNIT_KG = 1500.0


def _raw_weight(obj: dict[str, Any]) -> Any:
    for k in ("unitWeightKg", "weightKg"):
        if obj.get(k) is not None:
            return obj.get(k)
    if obj.get("unitWeightTonnes") is not None:
        t = _num(obj.get("unitWeightTonnes"))
        return t * 1000.0 if t is not None else obj.get("unitWeightTonnes")
    return None


def weight_issues(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """Same codes as the web enterprise-pack validator (enterprisePack.ts)."""
    network = payload.get("network") or {}
    constraints = payload.get("constraints") or {}
    out: list[dict[str, Any]] = []

    def check(raw: Any, code_invalid: str, code_impl: str, entity: str | None) -> None:
        if raw is None:
            return
        w = _num(raw)
        if w is None or not math.isfinite(w) or w <= 0:
            out.append({"level": "error", "code": code_invalid, "entityId": entity,
                        "message": f"unit weight {raw!r} must be a positive number (kg/unit); ignored."})
        elif w < MIN_PLAUSIBLE_UNIT_KG or w > MAX_PLAUSIBLE_UNIT_KG:
            out.append({"level": "warn", "code": code_impl, "entityId": entity,
                        "message": f"unit weight {w:g} kg outside {MIN_PLAUSIBLE_UNIT_KG}–{MAX_PLAUSIBLE_UNIT_KG:g} kg."})

    for g in network.get("productGroups") or payload.get("productGroups") or []:
        check(_raw_weight(g), "GROUP_WEIGHT_INVALID", "GROUP_WEIGHT_IMPLAUSIBLE", str(g.get("id")))
    for s in network.get("skus") or payload.get("skus") or []:
        check(_raw_weight(s), "SKU_WEIGHT_INVALID", "SKU_WEIGHT_IMPLAUSIBLE", str(s.get("id")))
    for raw in (constraints.get("defaultUnitWeightKg"),
                (network.get("costFactors") or {}).get("defaultUnitWeightKg")):
        if raw is None:
            continue
        w = _num(raw)
        if w is None or not math.isfinite(w) or w <= 0:
            out.append({"level": "error", "code": "DEFAULT_WEIGHT_INVALID", "entityId": None,
                        "message": f"project default unit weight {raw!r} must be positive; ignored."})
    return out


def _weight_kg(obj: dict[str, Any] | None) -> float | None:
    if not obj:
        return None
    w = _num(obj.get("unitWeightKg"))
    if w is None:
        w = _num(obj.get("weightKg"))
    if w is None:
        t = _num(obj.get("unitWeightTonnes"))
        if t is not None:
            w = t * 1000.0
    return w if w is not None and w > 0 else None


def resolve_unit_weights(
    payload: dict[str, Any],
    product_ids: list[str],
    sku_to_group: dict[str, str],
) -> tuple[dict[str, float], dict[str, Any]]:
    """Return (tonnes per physical unit by commodity id, info)."""
    network = payload.get("network") or {}
    constraints = payload.get("constraints") or {}
    cf = network.get("costFactors") or {}
    skus = list(network.get("skus") or payload.get("skus") or [])
    groups = list(network.get("productGroups") or payload.get("productGroups") or [])
    basis = str(constraints.get("co2WeightBasis") or "unit-weight")
    if basis == "legacy-1t":
        return {p: 1.0 for p in product_ids}, {
            "basis": "legacy-1t", "defaultUnitWeightKg": 1000.0,
            "defaultSource": "legacy-1t", "byCommodity": {p: 1000.0 for p in product_ids},
            "issues": [],
        }
    default_kg = _num(constraints.get("defaultUnitWeightKg"))
    src = "constraints.defaultUnitWeightKg"
    if default_kg is None or default_kg <= 0:
        default_kg, src = _num(cf.get("defaultUnitWeightKg")), "costFactors.defaultUnitWeightKg"
    if default_kg is None or default_kg <= 0:
        tpu = _num(constraints.get("tonsPerUnit"))
        if tpu is not None and tpu > 0:
            default_kg, src = tpu * 1000.0, "constraints.tonsPerUnit (legacy)"
    if default_kg is None or default_kg <= 0:
        default_kg, src = DEFAULT_UNIT_WEIGHT_KG, "built-in default"
    sku_w = {str(s.get("id")): _weight_kg(s) for s in skus if s.get("id") is not None}
    grp_w = {str(g.get("id")): _weight_kg(g) for g in groups if g.get("id") is not None}
    out_kg: dict[str, float] = {}
    sources: dict[str, str] = {}
    issues = weight_issues(payload)
    for p in product_ids:
        w, how = None, "default"
        if p in sku_w and sku_w[p] is not None:
            w, how = sku_w[p], "sku"
        elif p in sku_w and sku_to_group.get(p) in grp_w and grp_w[sku_to_group[p]] is not None:
            w, how = grp_w[sku_to_group[p]], "group"
        elif p in grp_w:
            if grp_w[p] is not None:
                w, how = grp_w[p], "group"
            else:
                members = [sku_w[s] for s, g in sku_to_group.items() if g == p and sku_w.get(s)]
                if members:
                    w, how = sum(members) / len(members), "group-mean-of-skus"
        elif sku_to_group.get(p) in grp_w and grp_w[sku_to_group[p]] is not None:
            w, how = grp_w[sku_to_group[p]], "group"
        if w is None:
            w = default_kg
        out_kg[p] = float(w)
        sources[p] = how
    return {p: kg / 1000.0 for p, kg in out_kg.items()}, {
        "basis": "unit-weight",
        "defaultUnitWeightKg": round(default_kg, 4),
        "defaultSource": src,
        "byCommodity": {p: round(v, 4) for p, v in out_kg.items()},
        "sourceByCommodity": sources,
        "missingWeightCommodities": [p for p, h in sources.items() if h == "default"],
        "issues": issues,
    }


def _arc_mode_options(
    fr: dict[str, Any],
    to: dict[str, Any],
    lane_opts: dict[tuple[str, str], dict[str, Any]],
    radius: float,
    radius_scale: float,
    max_lead: float | None,
    per_mile_m: float | None = None,
) -> tuple[list[dict[str, Any]], float, int]:
    """
    Allowed mode options for an arc → (options, miles, n_filtered_by_lead).

    Mirrors legacy ``_arc_allowed`` / ``_transport_unit_cost`` exactly for
    single-mode lanes and distance-proxy arcs.
    """
    rate = DEFAULT_TRANSPORT_PER_MILE if per_mile_m is None else per_mile_m
    miles = _dist_miles(fr, to)
    entry = lane_opts.get((fr["id"], to["id"]))
    if entry is None:
        if miles > radius * radius_scale + 1e-6:
            return [], miles, 0
        lead = miles / ROAD_MILES_PER_DAY
        if max_lead is not None and lead > max_lead + 1e-9:
            return [], miles, 1
        return (
            [
                {
                    "key": DEFAULT_MODE_KEY,
                    "label": DEFAULT_MODE_LABEL,
                    "cost": miles * rate,
                    "leadDays": lead,
                    "co2KgPerUnit": None,
                    "capacity": None,
                    "fixedCostM": 0.0,
                    "laneId": None,
                }
            ],
            miles,
            0,
        )
    res: list[dict[str, Any]] = []
    filtered = 0
    for o in entry["options"]:
        lead = o["leadDays"] if o["leadDays"] is not None else miles / ROAD_MILES_PER_DAY
        if max_lead is not None and lead > max_lead + 1e-9:
            filtered += 1
            continue
        cost = o["costM"] if o["costM"] is not None else miles * rate
        res.append({**o, "cost": cost, "leadDays": lead})
    return res, miles, filtered


def _highs_row_duals(prob: Any) -> dict[str, float] | None:
    """
    Row duals straight from the highspy model PuLP leaves on ``prob`` (PuLP's
    HiGHS API does not copy duals onto constraints). Rows are added in
    ``prob.constraints`` order. Returns None when unavailable (e.g. CBC).
    """
    model = getattr(prob, "solverModel", None)
    if model is None or not hasattr(model, "getSolution"):
        return None
    try:
        sol = model.getSolution()
        if not bool(getattr(sol, "dual_valid", True)):
            return None
        duals = [float(d) for d in sol.row_dual]
    except Exception:  # noqa: BLE001
        return None
    names = list(prob.constraints.keys())
    if len(duals) != len(names):
        return None
    return dict(zip(names, duals))


def _highs_col_duals(prob: Any, vars_: list[Any]) -> dict[str, float] | None:
    """Column duals (reduced costs) from the highspy model, keyed by var name."""
    model = getattr(prob, "solverModel", None)
    if model is None or not hasattr(model, "getSolution"):
        return None
    try:
        sol = model.getSolution()
        if not bool(getattr(sol, "dual_valid", True)):
            return None
        cd = [float(d) for d in sol.col_dual]
    except Exception:  # noqa: BLE001
        return None
    out: dict[str, float] = {}
    for v in vars_:
        ix = getattr(v, "index", None)
        if isinstance(ix, int) and 0 <= ix < len(cd):
            out[v.name] = cd[ix]
    return out


def _vk(a: str, b: str, p: str, mk: str) -> tuple:
    """Variable key — legacy 3-tuple for default mode keeps the model identical."""
    return (a, b, p) if mk == DEFAULT_MODE_KEY else (a, b, p, mk)


def _build_bom_edges(
    payload: dict[str, Any],
    suppliers: list[dict[str, Any]],
    plants: list[dict[str, Any]],
    dem_loads: list[tuple[dict[str, Any], float]],
    log: list[str],
    per_mile_m: float | None = None,
) -> list[tuple[str, str, float, float]]:
    network = payload.get("network") or {}
    bom = payload.get("bom") or network.get("bom") or {}
    explicit = network.get("bomDemand") or payload.get("bomDemand") or []

    edges: list[tuple[str, str, float, float]] = []
    seen: set[tuple[str, str]] = set()
    plant_ids = {p["id"] for p in plants}
    supplier_ids = {s["id"] for s in suppliers}
    by_id = {n["id"]: n for n in suppliers + plants}
    lane_costs = _lane_cost_map(list(network.get("lanes") or []))

    def add_edge(sid: str, pid: str, qty: float) -> None:
        if sid not in supplier_ids or pid not in plant_ids:
            return
        key = (sid, pid)
        if key in seen:
            return
        seen.add(key)
        cost, _miles = _transport_unit_cost(by_id[sid], by_id[pid], lane_costs, per_mile_m)
        edges.append((sid, pid, cost, max(0.0, float(qty))))

    for row in explicit:
        sid = row.get("supplierId") or row.get("from")
        pid = row.get("plantId") or row.get("to")
        qty = row.get("qtyPerUnit", row.get("volumePerFg", row.get("qty", 1.0)))
        if sid and pid:
            add_edge(str(sid), str(pid), float(qty))

    for row in bom.get("rows") or []:
        sid = row.get("preferredSupplierId") or row.get("supplierId")
        pid = row.get("plantId")
        qty = float(row.get("qtyPerUnit") or 1.0)
        if sid and pid:
            add_edge(str(sid), str(pid), qty)

    if not edges and suppliers and plants and (
        payload.get("includeDefaultBom") or network.get("includeDefaultBom")
    ):
        for p in plants:
            nearest = min(suppliers, key=lambda s: _dist_miles(s, p))
            add_edge(nearest["id"], p["id"], 1.0)
        log.append(
            f"BOM: default nearest-supplier arcs ({len(edges)}) — "
            "set bom.rows or bomDemand for real BOM."
        )

    if edges:
        log.append(f"BOM: {len(edges)} supplier→plant arcs active.")
    return edges


def _safe_dual(constraint: Any) -> float | None:
    try:
        pi = constraint.pi
        if pi is None:
            return None
        return float(pi)
    except (AttributeError, TypeError, ValueError):
        return None


def _resolve_commodities(
    payload: dict[str, Any],
    demands: list[dict[str, Any]],
    demand_volume: dict[str, float],
    constraints: dict[str, Any],
    log: list[str],
) -> tuple[
    list[str],
    dict[str, str],
    dict[tuple[str, str], float],
    str,
]:
    """
    Returns (product_ids, labels, dem_map[(cust,prod)]->vol, mode).
    mode in {"aggregate", "sku", "product-group"}.
    """
    network = payload.get("network") or {}
    rows = list(
        network.get("demandByProduct")
        or payload.get("demandByProduct")
        or []
    )
    skus = list(network.get("skus") or payload.get("skus") or [])
    groups = list(
        network.get("productGroups") or payload.get("productGroups") or []
    )
    max_c = int(
        constraints.get("maxProductCommodities") or DEFAULT_MAX_COMMODITIES
    )
    agg_flag = constraints.get("aggregateProductsByGroup", "auto")

    labels: dict[str, str] = {}
    sku_to_group: dict[str, str] = {}
    for s in skus:
        sid = str(s["id"])
        labels[sid] = str(s.get("name") or s.get("code") or sid)
        if s.get("groupId"):
            sku_to_group[sid] = str(s["groupId"])
    for g in groups:
        gid = str(g["id"])
        labels[gid] = str(g.get("name") or g.get("code") or gid)

    if not rows:
        # Fallback: aggregate customer demand (legacy)
        dem_map: dict[tuple[str, str], float] = {}
        for d in demands:
            vol = float(demand_volume.get(d["id"], _parse_volume(d.get("capacity"))))
            if vol > 0:
                dem_map[(d["id"], AGG_PRODUCT_ID)] = vol
        labels[AGG_PRODUCT_ID] = "Total"
        log.append("Commodities: aggregate (single product) — no demandByProduct.")
        return [AGG_PRODUCT_ID], labels, dem_map, "aggregate"

    # Gather raw SKU-level rows
    raw: dict[tuple[str, str], float] = {}
    for r in rows:
        cust = str(r.get("customerId") or r.get("demandId") or "")
        sku = str(r.get("productId") or r.get("skuId") or r.get("groupId") or "")
        vol = float(r.get("volume") or 0)
        if not cust or not sku or vol <= 0:
            continue
        raw[(cust, sku)] = raw.get((cust, sku), 0.0) + vol

    unique_skus = {sku for (_, sku) in raw}
    use_groups = False
    if agg_flag is True or agg_flag == "always":
        use_groups = bool(groups) or bool(sku_to_group)
    elif agg_flag is False or agg_flag == "never":
        use_groups = False
    else:  # auto
        use_groups = len(unique_skus) > max_c and (
            bool(groups) or bool(sku_to_group)
        )

    dem_map = {}
    if use_groups:
        for (cust, sku), vol in raw.items():
            gid = sku_to_group.get(sku, sku)
            # If sku is already a group id, keep it
            if sku in {str(g["id"]) for g in groups}:
                gid = sku
            dem_map[(cust, gid)] = dem_map.get((cust, gid), 0.0) + vol
            if gid not in labels:
                labels[gid] = gid
        mode = "product-group"
        log.append(
            f"Commodities: aggregated {len(unique_skus)} SKUs → "
            f"{len({p for (_, p) in dem_map})} product groups "
            f"(maxProductCommodities={max_c})."
        )
    else:
        dem_map = dict(raw)
        for (_, sku) in raw:
            if sku not in labels:
                labels[sku] = sku
        mode = "sku" if len(unique_skus) > 1 else "aggregate"
        log.append(
            f"Commodities: {len(unique_skus)} SKU/product id(s) "
            f"across {len(dem_map)} demand rows."
        )

    product_ids = sorted({p for (_, p) in dem_map})
    if not product_ids:
        product_ids = [AGG_PRODUCT_ID]
        labels[AGG_PRODUCT_ID] = "Total"
    return product_ids, labels, dem_map, mode


def _facility_capable(
    fid: str,
    cmap: dict[str, Any],
    fac_products: dict[str, Any],
    product_ids: list[str],
    sku_to_group: dict[str, str] | None = None,
) -> set[str] | None:
    """None = capable of all products; else set of allowed product ids."""
    c = cmap.get(fid) or {}
    fp = fac_products.get(fid) or {}
    raw = (
        c.get("capableProductIds")
        or c.get("capableGroupIds")
        or fp.get("capableProductIds")
        or fp.get("capableGroupIds")
    )
    if not raw:
        return None
    allowed = {str(x) for x in raw}
    sku_to_group = sku_to_group or {}
    expanded: set[str] = set(allowed)
    # Group capability → all SKUs in that group that are active commodities
    for pid in product_ids:
        g = sku_to_group.get(pid)
        if pid in allowed or (g is not None and g in allowed):
            expanded.add(pid)
        if pid in allowed:
            expanded.add(pid)
    inter = expanded.intersection(product_ids)
    if not inter and allowed:
        return set()
    return inter if inter else None


def _capacity_by_product(
    fid: str,
    cmap: dict[str, Any],
    fac_products: dict[str, Any],
) -> dict[str, float]:
    c = cmap.get(fid) or {}
    fp = fac_products.get(fid) or {}
    raw = c.get("capacityByProduct") or fp.get("capacityByProduct") or {}
    return {str(k): float(v) for k, v in raw.items()}


def solve_optimize(payload: dict[str, Any]) -> dict[str, Any]:
    """Solve; optionally attach ``baseline`` (current network, no decisions)."""
    res = _solve_optimize_core(payload)
    if payload.get("computeBaseline") and not payload.get("_diagProbe"):
        try:
            res["baseline"] = solve_baseline(payload)
        except Exception as exc:  # never break the main result
            res["baseline"] = {"status": "Error", "error": str(exc)}
    return res


def solve_baseline(payload: dict[str, Any]) -> dict[str, Any]:
    """Cost the *current* network: existing sites stay open, candidates stay
    closed, no open/close decisions. Used for honest Baseline KPIs."""
    import copy as _copy

    q = _copy.deepcopy(payload)
    q["computeBaseline"] = False
    q["explain"] = False
    q["_diagProbe"] = True
    cons = q.setdefault("constraints", {})
    cons["forceOpenSeed"] = True
    cons["optimizePlants"] = False
    cons.pop("maxPlants", None)
    nodes = (q.get("network") or {}).get("nodes") or []
    facs = cons.setdefault("facilities", [])
    by_id = {f.get("nodeId"): f for f in facs}
    n_open = 0
    for n in nodes:
        if n.get("kind") not in ("dc", "candidate", "plant"):
            continue
        f = by_id.get(n["id"])
        st = (f or {}).get("status") or ("candidate" if n.get("kind") == "candidate" else "open")
        if st != "open":
            if f is None:
                f = {"nodeId": n["id"]}
                facs.append(f)
            f["status"] = "closed"
        elif n.get("kind") != "plant":
            n_open += 1
    cons["maxFacilities"] = max(int(cons.get("maxFacilities") or 0), n_open)
    r = _solve_optimize_core(q)
    min_relaxed = False
    if r.get("status") != "Optimal":
        # e.g. an existing site with no reachable customers can't meet its
        # capacityMin when forced open — cost the as-is network without minimums.
        for f in facs:
            if f.get("capacityMin"):
                f["capacityMin"] = 0
        r = _solve_optimize_core(q)
        min_relaxed = True
    return {
        "capacityMinRelaxed": min_relaxed,
        "status": r.get("status"),
        "openIds": r.get("openIds"),
        "kpis": r.get("kpis"),
        "objectiveBreakdown": r.get("objectiveBreakdown"),
        "note": "Current network costed as-is: existing sites open, candidates closed"
        + (" (capacityMin relaxed — infeasible as-is)." if min_relaxed else "."),
    }


def _solve_optimize_core(payload: dict[str, Any]) -> dict[str, Any]:
    """
    Fixed-charge multi-echelon MIP.

    Echelons: (supplier→) plant → DC → customer, with optional plant→customer
    direct when within service radius / existing lane.
    Multi-SKU / product-group commodities when demandByProduct present.
    Depth 7: per-lane transport mode choice (cost / transit / CO2 / capacity /
    optional fixed activation charge) and lane + lane-mode capacity limits.
    """
    log: list[str] = [
        "Flowform fixed-charge multi-echelon MIP (PuLP).",
    ]
    if payload.get("enterpriseSchemaVersion"):
        log.append(f"Enterprise pack schema: {payload['enterpriseSchemaVersion']}.")
    network = payload.get("network") or {}
    constraints = payload.get("constraints") or {}
    nodes = list(network.get("nodes") or [])
    lanes = list(network.get("lanes") or [])
    demand_volume = dict(network.get("demandVolume") or {})
    lane_opts, lane_stats = _build_lane_options(lanes, constraints, log)
    cost_scale = resolve_cost_scale(payload)
    off_lane_m = cost_scale["offLaneRateM"]
    uncovered_penalty = cost_scale["uncoveredPenaltyM"]
    log.append(
        f"Cost scale: off-lane ${cost_scale['offLaneRatePerUnitMile']:.4f}/unit-mile "
        f"({cost_scale['offLaneRateSource']}"
        + (
            f", median lane ${cost_scale['medianLaneRatePerUnitMile']:.4f}/unit-mile"
            f" × {cost_scale['offLanePremium']}"
            if cost_scale["offLaneRateSource"] == "median-lane×premium"
            else ""
        )
        + f") · unmet demand ${cost_scale['uncoveredPenaltyPerUnit']:.2f}/unit "
        f"({cost_scale['uncoveredPenaltySource']}) · money in $M, "
        "volume unit = 1,000 units."
    )
    if cost_scale["legacyUncoveredPenaltyMIgnored"] is not None:
        log.append(
            "Note: legacy costFactors.uncoveredPenaltyM ignored — use "
            "uncoveredPenaltyPerUnit ($/unit)."
        )

    carbon_price = _num(constraints.get("carbonPricePerTonne")) or 0.0
    ef_raw = (
        constraints.get("emissionKgPerTonMileByMode")
        or network.get("emissionKgPerTonMileByMode")
        or (network.get("costFactors") or {}).get("emissionKgPerTonMileByMode")
        or {}
    )
    emission_factors = dict(DEFAULT_EMISSION_KG_PER_TON_MILE)
    for k, v in (ef_raw.items() if isinstance(ef_raw, dict) else []):
        fv = _num(v)
        if fv is not None:
            emission_factors[str(k).lower()] = fv
    if carbon_price > 0:
        log.append(f"Carbon price ${carbon_price}/t CO2 added to lane-mode cost.")

    plants = [n for n in nodes if n.get("kind") == "plant"]
    dcs = [n for n in nodes if n.get("kind") in ("dc", "candidate")]
    suppliers = [n for n in nodes if n.get("kind") == "supplier"]
    demands = [n for n in nodes if n.get("kind") == "demand"]

    optimize_plants = bool(constraints.get("optimizePlants", False))
    cmap = {f["nodeId"]: f for f in (constraints.get("facilities") or [])}
    fac_products = {
        str(fp.get("nodeId") or fp.get("id")): fp
        for fp in (constraints.get("facilityProducts") or network.get("facilityProducts") or [])
        if fp.get("nodeId") or fp.get("id")
    }

    decidable: list[dict[str, Any]] = list(dcs)
    for p in plants:
        st = _facility_status(p, cmap)
        if optimize_plants or st in ("candidate", "closed"):
            if p not in decidable:
                decidable.append(p)
        elif st == "open" and p not in decidable:
            decidable.append(p)

    for p in plants:
        if p["id"] not in {f["id"] for f in decidable}:
            decidable.append(p)

    if not decidable and not plants:
        raise ValueError("No facility nodes (dc/plant/candidate) in network.")
    if not demands:
        raise ValueError("No demand nodes in network.")

    fac_by_id = {f["id"]: f for f in decidable}
    for n in plants + dcs:
        fac_by_id.setdefault(n["id"], n)
    for s in suppliers:
        fac_by_id.setdefault(s["id"], s)

    radius = float(constraints.get("serviceRadiusMiles", 250))
    budget = float(constraints.get("capexBudgetM", 30))
    max_fac = int(constraints.get("maxFacilities", max(3, len(decidable))))
    target_pct = float(constraints.get("serviceTargetPct", 95))
    hard_service = bool(constraints.get("hardServiceConstraints", False))
    max_lead_raw = constraints.get("maxLeadTimeDays")
    max_lead: float | None = float(max_lead_raw) if max_lead_raw is not None else None
    if hard_service:
        log.append(
            "Hard service constraints ON — uncovered demand forbidden "
            f"(radius {radius} mi"
            + (f", maxLead {max_lead}d" if max_lead is not None else "")
            + ")."
        )
    elif max_lead is not None:
        log.append(f"Soft service with maxLeadTimeDays={max_lead}.")

    product_ids, product_labels, dem_map, commodity_mode = _resolve_commodities(
        payload, demands, demand_volume, constraints, log
    )
    # Treat single non-agg product as multi for tagging
    multi = len(product_ids) > 1 or (
        len(product_ids) == 1 and product_ids[0] != AGG_PRODUCT_ID
    )

    total_demand = sum(dem_map.values()) or 1.0
    cust_ids = sorted({c for (c, _) in dem_map})

    sku_to_group: dict[str, str] = {}
    for s in list(network.get("skus") or payload.get("skus") or []):
        if s.get("groupId"):
            sku_to_group[str(s["id"])] = str(s["groupId"])

    unit_tonnes, weight_info = resolve_unit_weights(payload, product_ids, sku_to_group)
    tons_per_unit = (
        sum(unit_tonnes[p] * v for (_c, p), v in dem_map.items()) / total_demand
        if dem_map
        else weight_info["defaultUnitWeightKg"] / 1000.0
    )
    log.append(
        "CO2 basis: "
        + (
            "legacy 1 t/unit."
            if weight_info["basis"] == "legacy-1t"
            else (
                f"unit weights {', '.join(f'{p}={kg:g} kg' for p, kg in list(weight_info['byCommodity'].items())[:6])}"
                f" (default {weight_info['defaultUnitWeightKg']:g} kg from {weight_info['defaultSource']}); "
                f"demand-weighted {tons_per_unit * 1000:.2f} kg/unit."
            )
        )
    )
    for iss in weight_info.get("issues") or []:
        log.append(f"Weight {iss['level']}: {iss['code']} {iss.get('entityId') or ''} — {iss['message']}")

    # Capability maps (group ids expand onto SKU commodities)
    capable: dict[str, set[str] | None] = {}
    for f in decidable:
        capable[f["id"]] = _facility_capable(
            f["id"], cmap, fac_products, product_ids, sku_to_group
        )

    def _can_serve(fid: str, prod: str) -> bool:
        able = capable.get(fid)
        if able is None:
            return True
        return prod in able

    # --- Arc sets (from, to, product, unit cost, miles, mode key) ---
    Arc = tuple  # (a, b, p, cost, miles, mk)
    arcs_dc_cust: list[Arc] = []
    arcs_plant_dc: list[Arc] = []
    arcs_plant_cust: list[Arc] = []
    reachable: dict[tuple[str, str], set[str]] = {
        (c, p): set() for (c, p) in dem_map
    }
    # (a, b, mk) → option meta (label, leadDays, co2/unit, capacity, fixed, laneId, carbon)
    arc_meta: dict[tuple[str, str, str], dict[str, Any]] = {}
    # (a, b) → set of mode keys that survived service filtering (customer-bound)
    lead_filtered_modes = 0

    def _options_for(
        fr: dict[str, Any], to: dict[str, Any], scale: float
    ) -> tuple[list[dict[str, Any]], float]:
        nonlocal lead_filtered_modes
        opts, miles, filtered = _arc_mode_options(
            fr, to, lane_opts, radius, scale, max_lead, off_lane_m
        )
        lead_filtered_modes += filtered
        for o in opts:
            mkey = (fr["id"], to["id"], o["key"])
            if mkey not in arc_meta:
                explicit = o["co2KgPerUnit"]
                per_tonne = None if explicit is not None else _co2_kg_per_unit(
                    o["label"], None, miles, emission_factors, 1.0
                )
                co2 = explicit if explicit is not None else per_tonne * tons_per_unit
                arc_meta[mkey] = {
                    "label": o["label"],
                    "leadDays": o["leadDays"],
                    "co2KgPerUnit": co2,
                    "co2KgPerTonne": per_tonne,
                    "co2Explicit": explicit,
                    "capacity": o["capacity"],
                    "fixedCostM": o["fixedCostM"],
                    "laneId": o["laneId"],
                    # co2KgPerUnit is per *physical* unit; one model unit is
                    # PHYSICAL_UNITS_PER_MODEL_UNIT physical units. $/model unit
                    # = kg × 1000 / 1000 (t) × price; → $M (/1e6).
                    "carbonM": co2 * PHYSICAL_UNITS_PER_MODEL_UNIT / 1000.0
                    * carbon_price / 1e6
                    if carbon_price > 0
                    else 0.0,
                    "miles": miles,
                }
        return opts, miles

    def _unit_co2(a: str, b: str, mk: str, prod: str | None) -> float:
        """kg CO2 per physical unit of commodity ``prod`` on (a, b, mk)."""
        meta = arc_meta.get((a, b, mk)) or {}
        if meta.get("co2Explicit") is not None:
            return float(meta["co2Explicit"])
        w = unit_tonnes.get(prod, tons_per_unit) if prod is not None else tons_per_unit
        return float(meta.get("co2KgPerTonne") or 0.0) * w

    def _unit_carbon_m(a: str, b: str, mk: str, prod: str | None) -> float:
        # kg/unit × 1000 units per model unit / 1000 kg per t × $/t → $M
        if carbon_price <= 0:
            return 0.0
        return _unit_co2(a, b, mk, prod) * PHYSICAL_UNITS_PER_MODEL_UNIT / 1000.0 * carbon_price / 1e6

    dem_nodes = {d["id"]: d for d in demands}

    for dc in dcs:
        for cust_id, prod in list(dem_map.keys()):
            if not _can_serve(dc["id"], prod):
                continue
            dnode = dem_nodes.get(cust_id)
            if not dnode:
                continue
            opts, miles = _options_for(dc, dnode, 1.0)
            for o in opts:
                arcs_dc_cust.append((dc["id"], cust_id, prod, o["cost"], miles, o["key"]))
            if opts:
                reachable[(cust_id, prod)].add(dc["id"])

    for p in plants:
        for dc in dcs:
            for prod in product_ids:
                if not _can_serve(p["id"], prod) or not _can_serve(dc["id"], prod):
                    continue
                opts, miles = _options_for(p, dc, 2.0)
                for o in opts:
                    arcs_plant_dc.append((p["id"], dc["id"], prod, o["cost"], miles, o["key"]))

    for p in plants:
        for cust_id, prod in list(dem_map.keys()):
            if not _can_serve(p["id"], prod):
                continue
            dnode = dem_nodes.get(cust_id)
            if not dnode:
                continue
            opts, miles = _options_for(p, dnode, 1.0)
            for o in opts:
                arcs_plant_cust.append((p["id"], cust_id, prod, o["cost"], miles, o["key"]))
            if opts:
                reachable[(cust_id, prod)].add(p["id"])

    if lead_filtered_modes and max_lead is not None:
        log.append(
            f"Service filter: {lead_filtered_modes} arc-mode option(s) exceed "
            f"maxLeadTimeDays={max_lead} and were excluded."
        )

    single_echelon = len(plants) == 0
    if single_echelon and not arcs_dc_cust:
        # Still build model so hard-service diagnostics can fire
        log.append("Warning: no reachable DC→customer arcs within service limits.")

    # dem_loads for BOM (aggregate volumes by customer)
    cust_total: dict[str, float] = {}
    for (c, _p), v in dem_map.items():
        cust_total[c] = cust_total.get(c, 0.0) + v
    dem_loads = [
        (dem_nodes[cid], cust_total.get(cid, 0.0))
        for cid in cust_ids
        if cid in dem_nodes
    ]
    bom_arcs = _build_bom_edges(
        payload, suppliers, plants, dem_loads, log, cost_scale["offLaneRateM"]
    )

    n_mode_arcs = sum(
        1 for arcs in (arcs_dc_cust, arcs_plant_dc, arcs_plant_cust)
        for arc in arcs if arc[5] != DEFAULT_MODE_KEY
    )
    log.append(
        f"Model: {len(plants)} plants · {len(dcs)} DCs/candidates · "
        f"{len(suppliers)} suppliers · {len(cust_ids)} demand · "
        f"{len(product_ids)} commodities ({commodity_mode}) · "
        f"{len(arcs_plant_dc)} plant→DC · {len(arcs_dc_cust)} DC→cust · "
        f"{len(arcs_plant_cust)} plant→cust · {len(bom_arcs)} BOM arcs · "
        f"radius {radius} mi · budget ${budget}M · max {max_fac}."
        + (f" Mode-expanded arcs: {n_mode_arcs}." if n_mode_arcs else "")
    )

    # --- Lane capacity bookkeeping (structural) ---
    # lane (a,b) → set of active mode keys (any echelon / product)
    lane_active_modes: dict[tuple[str, str], set[str]] = {}
    for arcs in (arcs_dc_cust, arcs_plant_dc, arcs_plant_cust):
        for a, b, _p, _c, _m, mk in arcs:
            lane_active_modes.setdefault((a, b), set()).add(mk)

    def _lane_effective_cap(a: str, b: str) -> float:
        entry = lane_opts.get((a, b))
        if entry is None:
            return math.inf
        mks = lane_active_modes.get((a, b), set())
        mode_sum = 0.0
        for mk in mks:
            cap = arc_meta.get((a, b, mk), {}).get("capacity")
            if cap is None:
                mode_sum = math.inf
                break
            mode_sum += float(cap)
        lane_cap = entry.get("capacity")
        return min(mode_sum, float(lane_cap) if lane_cap is not None else math.inf)

    def _lane_shortfalls() -> dict[str, Any]:
        inbound_cap: dict[str, float] = {}
        inbound_lanes: dict[str, list[str]] = {}
        unbounded: set[str] = set()
        filtered_by_cust: dict[str, int] = {}
        for (a, b), _mks in lane_active_modes.items():
            if b not in cust_total:
                continue
            eff = _lane_effective_cap(a, b)
            entry = lane_opts.get((a, b))
            if entry is not None:
                n_opts = len(entry["options"])
                n_act = len(lane_active_modes.get((a, b), set()))
                if n_opts > n_act:
                    filtered_by_cust[b] = filtered_by_cust.get(b, 0) + (n_opts - n_act)
            if math.isinf(eff):
                unbounded.add(b)
                continue
            inbound_cap[b] = inbound_cap.get(b, 0.0) + eff
            inbound_lanes.setdefault(b, []).append(
                (entry or {}).get("laneId") or f"{a}->{b}"
            )
        rows: list[dict[str, Any]] = []
        for cid in cust_ids:
            if cid in unbounded or cid not in inbound_lanes:
                continue
            dem_c = cust_total.get(cid, 0.0)
            cap_c = inbound_cap.get(cid, 0.0)
            if cap_c + 1e-6 < dem_c:
                rows.append(
                    {
                        "customerId": cid,
                        "demand": round(dem_c, 2),
                        "inboundLaneCapacity": round(cap_c, 2),
                        "shortfall": round(dem_c - cap_c, 2),
                        "laneIds": inbound_lanes[cid][:6],
                        "serviceFilteredModes": filtered_by_cust.get(cid, 0),
                    }
                )
        rows.sort(key=lambda r: -r["shortfall"])
        # Plant outbound echelon: every customer unit leaves a plant on a lane
        plant_out_cap = 0.0
        plant_out_unbounded = single_echelon
        plant_lanes: list[str] = []
        if not single_echelon:
            plant_ids = {p["id"] for p in plants}
            for (a, b), _mks in lane_active_modes.items():
                if a not in plant_ids:
                    continue
                eff = _lane_effective_cap(a, b)
                if math.isinf(eff):
                    plant_out_unbounded = True
                    break
                plant_out_cap += eff
                entry = lane_opts.get((a, b))
                plant_lanes.append((entry or {}).get("laneId") or f"{a}->{b}")
        plant_short = None
        if not plant_out_unbounded and plant_out_cap + 1e-6 < sum(cust_total.values()):
            plant_short = {
                "outboundLaneCapacity": round(plant_out_cap, 2),
                "demand": round(sum(cust_total.values()), 2),
                "shortfall": round(sum(cust_total.values()) - plant_out_cap, 2),
                "laneIds": plant_lanes[:8],
            }
        return {
            "customers": rows,
            "plantOutbound": plant_short,
            "maxLeadTimeDays": max_lead,
        }

    lane_short = _lane_shortfalls()

    solver, solver_name = _pick_solver(log)

    def _capex_of(fid: str) -> float:
        return _open_capex(fid, fac_by_id, cmap)

    def _build_report() -> dict[str, Any]:
        return diagnose_network_conflicts(
            dem_map=dem_map,
            product_ids=product_ids,
            product_labels=product_labels,
            reachable=reachable,
            openable=decidable,
            cmap=cmap,
            fac_by_id=fac_by_id,
            capable=capable,
            radius=radius,
            budget=budget,
            max_fac=max_fac,
            hard_service=hard_service,
            capex_of=_capex_of,
            parse_volume=_parse_volume,
            lane_shortfalls=lane_short,
        )

    def _infeasible(solve_seconds: float = 0.0, pre: bool = True) -> dict[str, Any]:
        report = _build_report()
        log.append(
            ("Infeasible pre-check: " if pre else "Infeasibility: ")
            + report["summary"]
        )
        res = _infeasible_result(
            solver_name=solver_name,
            log=log,
            report=report,
            product_ids=product_ids,
            product_labels=product_labels,
            dem_map=dem_map,
            commodity_mode=commodity_mode,
            hard_service=hard_service,
            target_pct=target_pct,
            solve_seconds=solve_seconds,
            status_name="Infeasible",
        )
        res["laneCapacityShortfalls"] = lane_short
        if not pre and not payload.get("_diagProbe"):
            try:
                probe = _root_cause_probes(payload)
            except Exception as exc:  # diagnostics must never break the result
                probe = None
                log.append(f"Root-cause probe skipped: {exc}")
            if probe:
                _merge_probe_hints(res, probe)
        return res

    # Pre-check: hard service with any demand row unreachable → infeasible
    if hard_service and (
        (arcs_dc_cust == [] and arcs_plant_cust == [])
        or any(not reachable.get(k) for k in dem_map)
    ):
        return _infeasible()

    # --- Index arcs once (same iteration order as legacy comprehensions) ---
    dem_in: dict[tuple[str, str], list[tuple[str, tuple]]] = {}
    dc_out_p: dict[tuple[str, str], list[tuple]] = {}
    dc_in_p: dict[tuple[str, str], list[tuple]] = {}
    fac_out: dict[str, list[tuple[str, tuple]]] = {}
    fac_out_p: dict[tuple[str, str], list[tuple[str, tuple]]] = {}
    for a, b, p, _c, _m, mk in arcs_dc_cust:
        k = _vk(a, b, p, mk)
        dem_in.setdefault((b, p), []).append(("dc", k))
        dc_out_p.setdefault((a, p), []).append(k)
        fac_out.setdefault(a, []).append(("dc", k))
        fac_out_p.setdefault((a, p), []).append(("dc", k))
    for a, b, p, _c, _m, mk in arcs_plant_cust:
        dem_in.setdefault((b, p), []).append(("pc", _vk(a, b, p, mk)))
    for a, b, p, _c, _m, mk in arcs_plant_dc:
        k = _vk(a, b, p, mk)
        dc_in_p.setdefault((b, p), []).append(k)
        fac_out.setdefault(a, []).append(("pdc", k))
        fac_out_p.setdefault((a, p), []).append(("pdc", k))
    for a, b, p, _c, _m, mk in arcs_plant_cust:
        k = _vk(a, b, p, mk)
        fac_out.setdefault(a, []).append(("pc", k))
        fac_out_p.setdefault((a, p), []).append(("pc", k))

    prob = pulp.LpProblem("flowform_multi_echelon", pulp.LpMinimize)

    y = pulp.LpVariable.dicts(
        "open",
        [f["id"] for f in decidable],
        cat="Binary",
    )

    force_open_ids = {str(i) for i in (constraints.get("forceOpenIds") or [])}
    force_closed_ids = {str(i) for i in (constraints.get("forceClosedIds") or [])}
    for f in decidable:
        st = _facility_status(f, cmap)
        if f["id"] in force_closed_ids:
            prob += y[f["id"]] == 0, _safe_name("fix_closed", f["id"])
            continue
        if f["id"] in force_open_ids:
            # Design fixing (robust / baseline): keeps capex semantics intact
            prob += y[f["id"]] == 1, _safe_name("fix_open", f["id"])
            continue
        if st == "closed":
            prob += y[f["id"]] == 0, _safe_name("forced_closed", f["id"])
        elif st == "open" and f.get("kind") == "plant" and not optimize_plants:
            prob += y[f["id"]] == 1, _safe_name("forced_open", f["id"])
        elif st == "open" and constraints.get("forceOpenSeed", False):
            if f.get("kind") != "candidate":
                prob += y[f["id"]] == 1, _safe_name("forced_open", f["id"])

    x_dc_c = pulp.LpVariable.dicts(
        "x_dc_c",
        [_vk(a, b, p, mk) for a, b, p, _, _, mk in arcs_dc_cust],
        lowBound=0,
        cat="Continuous",
    )
    x_p_dc = pulp.LpVariable.dicts(
        "x_p_dc",
        [_vk(a, b, p, mk) for a, b, p, _, _, mk in arcs_plant_dc],
        lowBound=0,
        cat="Continuous",
    )
    x_p_c = pulp.LpVariable.dicts(
        "x_p_c",
        [_vk(a, b, p, mk) for a, b, p, _, _, mk in arcs_plant_cust],
        lowBound=0,
        cat="Continuous",
    )
    x_s_p = pulp.LpVariable.dicts(
        "x_s_p",
        [(a, b) for a, b, _, _ in bom_arcs],
        lowBound=0,
        cat="Continuous",
    )
    xv = {"dc": x_dc_c, "pdc": x_p_dc, "pc": x_p_c}

    dem_keys = list(dem_map.keys())
    if hard_service:
        uncovered = None
    else:
        uncovered = pulp.LpVariable.dicts(
            "uncov",
            dem_keys,
            lowBound=0,
            cat="Continuous",
        )

    # Demand satisfaction per (customer, product)
    for key, vol in dem_map.items():
        cust_id, prod = key
        inbound = [xv[kind][k] for kind, k in dem_in.get(key, [])]
        if hard_service:
            # (unreachable rows were caught by the pre-check above)
            prob += pulp.lpSum(inbound) == vol, _safe_name("dem", cust_id, prod)
        else:
            assert uncovered is not None
            if inbound:
                prob += (
                    pulp.lpSum(inbound) + uncovered[key] == vol,
                    _safe_name("dem", cust_id, prod),
                )
            else:
                prob += uncovered[key] == vol, _safe_name("dem_isol", cust_id, prod)

    # DC flow balance per product
    for dc in dcs:
        did = dc["id"]
        for prod in product_ids:
            out_keys = dc_out_p.get((did, prod), [])
            in_keys = dc_in_p.get((did, prod), [])
            if not out_keys:
                continue
            if single_echelon or not plants:
                pass
            elif in_keys:
                prob += (
                    pulp.lpSum(x_p_dc[k] for k in in_keys)
                    == pulp.lpSum(x_dc_c[k] for k in out_keys),
                    _safe_name("bal_dc", did, prod),
                )
            else:
                for k in out_keys:
                    prob += (
                        x_dc_c[k] == 0,
                        _safe_name("block_dc", did, *k[1:]),
                    )

    # Link flows to open + capability already filtered in arc build
    for a, b, p, _, _, mk in arcs_dc_cust:
        if a in y:
            dem_b = dem_map[(b, p)]
            prob += (
                x_dc_c[_vk(a, b, p, mk)] <= dem_b * y[a],
                _safe_name("link_dc", a, b, p, mk) if mk else _safe_name("link_dc", a, b, p),
            )

    for a, b, p, _, _, mk in arcs_plant_dc:
        k = _vk(a, b, p, mk)
        if a in y:
            prob += (
                x_p_dc[k] <= total_demand * y[a],
                _safe_name("link_pdc", *k),
            )
        if b in y:
            prob += (
                x_p_dc[k] <= total_demand * y[b],
                _safe_name("link_pdc_in", *k),
            )

    for a, b, p, _, _, mk in arcs_plant_cust:
        k = _vk(a, b, p, mk)
        if a in y:
            prob += (
                x_p_c[k] <= dem_map[(b, p)] * y[a],
                _safe_name("link_pc", *k),
            )

    for a, b, _, _ in bom_arcs:
        if b in y:
            prob += (
                x_s_p[(a, b)] <= total_demand * 10 * y[b],
                _safe_name("link_sp", a, b),
            )

    if bom_arcs:
        plant_out: dict[str, list] = {p["id"]: [] for p in plants}
        for a, b, p, _, _, mk in arcs_plant_dc:
            plant_out.setdefault(a, []).append(x_p_dc[_vk(a, b, p, mk)])
        for a, b, p, _, _, mk in arcs_plant_cust:
            plant_out.setdefault(a, []).append(x_p_c[_vk(a, b, p, mk)])

        by_plant: dict[str, list[tuple[str, float]]] = {}
        for sid, pid, _cost, qty in bom_arcs:
            by_plant.setdefault(pid, []).append((sid, qty))

        for pid, pairs in by_plant.items():
            fg = plant_out.get(pid) or []
            if not fg:
                continue
            fg_sum = pulp.lpSum(fg)
            for sid, qty in pairs:
                if (sid, pid) in x_s_p:
                    prob += (
                        x_s_p[(sid, pid)] >= qty * fg_sum,
                        _safe_name("bom", sid, pid),
                    )

    # Capacity + min throughput + optional per-product caps
    cap_constraints: dict[str, Any] = {}
    for f in decidable:
        fid = f["id"]
        c = cmap.get(fid, {})
        cap_max = float(c.get("capacityMax") or _parse_volume(f.get("capacity"), 1e9))
        cap_min = float(c.get("capacityMin") or 0.0)
        outbound: list = []
        if f.get("kind") in ("dc", "candidate"):
            outbound = [xv[kind][k] for kind, k in fac_out.get(fid, []) if kind == "dc"]
        elif f.get("kind") == "plant":
            outbound = [
                xv[kind][k] for kind, k in fac_out.get(fid, []) if kind in ("pdc", "pc")
            ]
        if not outbound:
            continue
        thr = pulp.lpSum(outbound)
        ren = _safe_name("cap", fid)
        prob += thr <= cap_max * y[fid], ren
        cap_constraints[fid] = (prob.constraints[ren], cap_max, cap_min)
        if cap_min > 0:
            prob += thr >= cap_min * y[fid], _safe_name("minthr", fid)

        # Per-product dedicated capacity
        cap_by = _capacity_by_product(fid, cmap, fac_products)
        for prod, pcap in cap_by.items():
            if pcap <= 0:
                continue
            # Keys may be commodity ids or product-group ids; a group cap is
            # shared by every SKU commodity in that group (web sends per-SKU
            # commodities ``sku-<group>`` with group-keyed capacityByProduct).
            if prod in product_ids:
                members = [prod]
            else:
                members = [p for p in product_ids if sku_to_group.get(p) == prod]
            if not members:
                continue
            kinds = ("dc",) if f.get("kind") in ("dc", "candidate") else ("pdc", "pc")
            pout: list = [
                xv[kind][k]
                for m in members
                for kind, k in fac_out_p.get((fid, m), [])
                if kind in kinds
            ]
            if pout:
                prob += (
                    pulp.lpSum(pout) <= float(pcap) * y[fid],
                    _safe_name("cap_prod", fid, prod),
                )

    # --- Depth 7: lane / lane-mode capacity + fixed activation charges ---
    lane_vars: dict[tuple[str, str], list] = {}
    lane_mode_vars: dict[tuple[str, str, str], list] = {}
    for kind, arcs, xd in (
        ("dc", arcs_dc_cust, x_dc_c),
        ("pdc", arcs_plant_dc, x_p_dc),
        ("pc", arcs_plant_cust, x_p_c),
    ):
        for a, b, p, _c, _m, mk in arcs:
            var = xd[_vk(a, b, p, mk)]
            lane_vars.setdefault((a, b), []).append(var)
            lane_mode_vars.setdefault((a, b, mk), []).append(var)

    lane_cap_rows: list[dict[str, Any]] = []  # meta per capacity constraint
    lane_ix = 0
    for (a, b), vars_ in lane_vars.items():
        entry = lane_opts.get((a, b))
        if entry is None or entry.get("capacity") is None:
            continue
        cname = f"lanecap_{lane_ix}"
        lane_ix += 1
        cap = float(entry["capacity"])
        prob += pulp.lpSum(vars_) <= cap, cname
        lane_cap_rows.append(
            {
                "name": cname,
                "scope": "lane",
                "from": a,
                "to": b,
                "mk": None,
                "laneId": entry["laneId"],
                "capacity": cap,
            }
        )
    z: dict[tuple[str, str, str], Any] = {}
    lane_fixed_cost: dict[tuple[str, str, str], float] = {}
    for (a, b, mk), vars_ in lane_mode_vars.items():
        meta = arc_meta.get((a, b, mk)) or {}
        cap = meta.get("capacity")
        fixed = float(meta.get("fixedCostM") or 0.0)
        if fixed > 0:
            zv = pulp.LpVariable(_safe_name("lm_on", lane_ix, mk or "default"), cat="Binary")
            entry = lane_opts.get((a, b)) or {}
            big_m = total_demand if b not in cust_total else cust_total[b]
            if cap is not None:
                big_m = min(big_m, float(cap))
            if entry.get("capacity") is not None:
                big_m = min(big_m, float(entry["capacity"]))
            z[(a, b, mk)] = zv
            lane_fixed_cost[(a, b, mk)] = fixed
            cname = f"lanemode_{lane_ix}"
            lane_ix += 1
            prob += pulp.lpSum(vars_) <= big_m * zv, cname
            if cap is not None and big_m >= float(cap) - 1e-9:
                # Activation link doubles as the mode capacity row
                lane_cap_rows.append(
                    {
                        "name": cname,
                        "scope": "lane-mode",
                        "from": a,
                        "to": b,
                        "mk": mk,
                        "laneId": meta.get("laneId"),
                        "capacity": float(cap),
                        "fixedCharge": True,
                    }
                )
                continue
        if cap is not None:
            cname = f"lanemode_{lane_ix}"
            lane_ix += 1
            prob += pulp.lpSum(vars_) <= float(cap), cname
            lane_cap_rows.append(
                {
                    "name": cname,
                    "scope": "lane-mode",
                    "from": a,
                    "to": b,
                    "mk": mk,
                    "laneId": meta.get("laneId"),
                    "capacity": float(cap),
                }
            )

    capex_cost = {f["id"]: _open_capex(f["id"], fac_by_id, cmap) for f in decidable}
    opex_cost = {f["id"]: _open_opex(f["id"], fac_by_id, cmap) for f in decidable}
    prob += (
        pulp.lpSum(capex_cost[fid] * y[fid] for fid in y) <= budget,
        "capex_budget",
    )
    # D-07: maxFacilities caps DCs + candidates only ("Max DCs"); plants have
    # their own optional maxPlants cap (only meaningful with optimizePlants).
    count_ids = [f["id"] for f in decidable if f.get("kind") in ("dc", "candidate")]
    if count_ids:
        prob += pulp.lpSum(y[fid] for fid in count_ids) <= max_fac, "max_facilities"
    max_plants_raw = constraints.get("maxPlants")
    plant_ids_dec = [f["id"] for f in decidable if f.get("kind") == "plant"]
    if max_plants_raw is not None and plant_ids_dec:
        max_plants = int(max_plants_raw)
        prob += pulp.lpSum(y[fid] for fid in plant_ids_dec) <= max_plants, "max_plants"
        log.append(f"Max plants {max_plants} (separate from max DCs {max_fac}).")

    transport_terms = []
    carbon_terms = []
    for arcs, xd in (
        (arcs_dc_cust, x_dc_c),
        (arcs_plant_dc, x_p_dc),
        (arcs_plant_cust, x_p_c),
    ):
        for a, b, p, cost, _miles, mk in arcs:
            transport_terms.append(cost * xd[_vk(a, b, p, mk)])
            if carbon_price > 0:
                carbon_terms.append(_unit_carbon_m(a, b, mk, p) * xd[_vk(a, b, p, mk)])
    for a, b, cost, _qty in bom_arcs:
        transport_terms.append(cost * x_s_p[(a, b)])

    transport_expr = pulp.lpSum(transport_terms) if transport_terms else 0
    carbon_expr = pulp.lpSum(carbon_terms) if carbon_terms else 0
    capex_expr = pulp.lpSum(capex_cost[fid] * y[fid] for fid in y)
    opex_expr = pulp.lpSum(opex_cost[fid] * y[fid] for fid in y)
    if hard_service:
        uncov_expr = 0
    else:
        assert uncovered is not None
        uncov_expr = pulp.lpSum(
            uncovered_penalty * uncovered[k] for k in uncovered
        )

    keep_bonus = pulp.lpSum(
        -0.02 * y[f["id"]]
        for f in decidable
        if _facility_status(f, cmap) == "open" and f["id"] in y
    )

    lane_fixed_expr = (
        pulp.lpSum(lane_fixed_cost[k] * z[k] for k in z) if z else 0
    )
    if z:
        prob += (
            transport_expr + carbon_expr + capex_expr + opex_expr + uncov_expr
            + keep_bonus + lane_fixed_expr
        )
    else:
        prob += (
            transport_expr + carbon_expr + capex_expr + opex_expr + uncov_expr
            + keep_bonus
        )

    t_solve0 = time.perf_counter()
    status_code = prob.solve(solver)
    solve_seconds = round(time.perf_counter() - t_solve0, 3)
    status_name = pulp.LpStatus.get(status_code, str(status_code))
    log.append(f"Solve status: {status_name} in {solve_seconds:.3f}s.")

    infeasible = status_name in ("Infeasible", "Undefined") or status_code < 0
    # PuLP: -1 Infeasible, -2 Unbounded, -3 Undefined
    if status_code in (-1, -3) or status_name == "Infeasible":
        infeasible = True

    if infeasible:
        return _infeasible(solve_seconds, pre=False)

    def _val(var: Any) -> float:
        v = pulp.value(var)
        return float(v) if v is not None else 0.0

    def _ev(expr: Any) -> float:
        v = pulp.value(expr)
        return float(v) if v is not None else 0.0

    def _cost_parts() -> dict[str, float]:
        """True cost of the incumbent (objective minus the keep-open bonus)."""
        tr = _ev(transport_expr) + _ev(carbon_expr)
        cx = _ev(capex_expr)
        ox = _ev(opex_expr)
        un = 0.0 if uncovered is None else sum(_val(uncovered[k]) for k in uncovered)
        pen = uncovered_penalty * un
        lf = _ev(lane_fixed_expr)
        return {
            "totalM": tr + cx + ox + pen + lf,
            "transportM": tr,
            "fixedCapexM": cx,
            "fixedOpexM": ox,
            "uncoveredPenaltyM": pen,
            "laneFixedM": lf,
            "uncovered": un,
            "servicePct": max(0.0, min(100.0, (total_demand - un) / total_demand * 100)),
        }

    base_parts = _cost_parts()

    open_ids = [fid for fid in y if _val(y[fid]) > 0.5]
    seed_open = [
        f["id"] for f in decidable if _facility_status(f, cmap) == "open"
    ]
    opened_ids = [i for i in open_ids if i not in seed_open]
    closed_ids = [i for i in seed_open if i not in open_ids]
    kept_open = [i for i in open_ids if i in seed_open]
    z_on = {k: _val(v) > 0.5 for k, v in z.items()}

    flows: list[dict[str, Any]] = []
    lane_vol: dict[tuple[str, str], float] = {}
    lane_mode_vol: dict[tuple[str, str, str], float] = {}
    lane_mode_cost: dict[tuple[str, str, str], float] = {}
    lane_mode_echelon: dict[tuple[str, str, str], str] = {}
    lane_mode_co2: dict[tuple[str, str, str], float] = {}
    lane_mode_tm: dict[tuple[str, str, str], float] = {}
    lane_mode_carbon: dict[tuple[str, str, str], float] = {}

    def _add_flow(
        fr: str,
        to: str,
        vol: float,
        miles: float,
        echelon: str,
        unit_cost: float,
        prod: str | None = None,
        mk: str | None = None,
    ) -> None:
        if vol <= 1e-4:
            return
        row: dict[str, Any] = {
            "from": fr,
            "to": to,
            "volume": round(vol, 2),
            "miles": round(miles, 1),
            "echelon": echelon,
            "unitCost": round(unit_cost, 6),
            "transportCostM": round(unit_cost * vol, 4),
        }
        if prod is not None and multi:
            row["productId"] = prod
            row["productLabel"] = product_labels.get(prod, prod)
        if mk is not None:
            meta = arc_meta.get((fr, to, mk)) or {}
            row["mode"] = meta.get("label", DEFAULT_MODE_LABEL)
            if mk != DEFAULT_MODE_KEY:
                row["modeKey"] = mk
            if meta.get("laneId"):
                row["laneId"] = meta["laneId"]
            if meta.get("leadDays") is not None:
                row["leadDays"] = round(float(meta["leadDays"]), 2)
            co2_kg = _unit_co2(fr, to, mk, prod) * vol * PHYSICAL_UNITS_PER_MODEL_UNIT
            tonnes = (
                vol * PHYSICAL_UNITS_PER_MODEL_UNIT
                * (unit_tonnes.get(prod, tons_per_unit) if prod is not None else tons_per_unit)
            )
            row["co2Kg"] = round(co2_kg, 1)
            row["tonnes"] = round(tonnes, 1)
            lk = (fr, to, mk)
            lane_mode_co2[lk] = lane_mode_co2.get(lk, 0.0) + co2_kg
            lane_mode_tm[lk] = lane_mode_tm.get(lk, 0.0) + tonnes * miles
            lane_mode_carbon[lk] = lane_mode_carbon.get(lk, 0.0) + (
                _unit_carbon_m(fr, to, mk, prod) * vol
            )
            lane_vol[(fr, to)] = lane_vol.get((fr, to), 0.0) + vol
            lane_mode_vol[lk] = lane_mode_vol.get(lk, 0.0) + vol
            lane_mode_cost[lk] = lane_mode_cost.get(lk, 0.0) + unit_cost * vol
            lane_mode_echelon[lk] = echelon
        flows.append(row)

    for a, b, p, cost, miles, mk in arcs_dc_cust:
        _add_flow(a, b, _val(x_dc_c[_vk(a, b, p, mk)]), miles, "dc→customer", cost, p, mk)
    for a, b, p, cost, miles, mk in arcs_plant_dc:
        _add_flow(a, b, _val(x_p_dc[_vk(a, b, p, mk)]), miles, "plant→dc", cost, p, mk)
    for a, b, p, cost, miles, mk in arcs_plant_cust:
        _add_flow(a, b, _val(x_p_c[_vk(a, b, p, mk)]), miles, "plant→customer", cost, p, mk)
    for a, b, cost, qty in bom_arcs:
        snode = next((s for s in suppliers if s["id"] == a), {"id": a})
        pnode = next((p for p in plants if p["id"] == b), {"id": b})
        miles = _dist_miles(snode, pnode)
        _add_flow(a, b, _val(x_s_p[(a, b)]), miles, "supplier→plant", cost, None)

    if hard_service:
        uncovered_total = 0.0
        served_by_prod: dict[str, float] = {pid: 0.0 for pid in product_ids}
        for (cust, prod), vol in dem_map.items():
            served_by_prod[prod] = served_by_prod.get(prod, 0.0) + vol
    else:
        assert uncovered is not None
        uncovered_total = sum(_val(uncovered[k]) for k in uncovered)
        served_by_prod = {pid: 0.0 for pid in product_ids}
        uncov_by_prod = {pid: 0.0 for pid in product_ids}
        for (cust, prod), vol in dem_map.items():
            u = _val(uncovered[(cust, prod)])
            uncov_by_prod[prod] = uncov_by_prod.get(prod, 0.0) + u
            served_by_prod[prod] = served_by_prod.get(prod, 0.0) + (vol - u)

    covered = total_demand - uncovered_total
    service_pct = max(0.0, min(100.0, (covered / total_demand) * 100))

    transport_cost = sum(float(f["transportCostM"]) for f in flows)
    capex_used = sum(capex_cost[i] for i in open_ids)
    opex_used = sum(opex_cost[i] for i in open_ids)
    uncovered_pen = uncovered_penalty * uncovered_total
    lane_fixed_used = sum(lane_fixed_cost[k] for k, on in z_on.items() if on)
    carbon_cost = (
        sum(lane_mode_carbon.values())
        if carbon_price > 0
        else 0.0
    )
    objective_total = (
        transport_cost + capex_used + opex_used + uncovered_pen
        + lane_fixed_used + carbon_cost
    )

    # Product / SKU breakdown
    transport_by_prod: dict[str, float] = {pid: 0.0 for pid in product_ids}
    for fl in flows:
        pid = fl.get("productId")
        if pid in transport_by_prod:
            transport_by_prod[pid] += float(fl["transportCostM"])

    dem_by_prod = {
        pid: sum(v for (c, p), v in dem_map.items() if p == pid)
        for pid in product_ids
    }
    product_breakdown: list[dict[str, Any]] = []
    for pid in product_ids:
        dem_p = dem_by_prod.get(pid, 0.0)
        served_p = served_by_prod.get(pid, 0.0)
        pct = (served_p / dem_p * 100) if dem_p > 0 else 100.0
        product_breakdown.append(
            {
                "productId": pid,
                "label": product_labels.get(pid, pid),
                "demand": round(dem_p, 2),
                "served": round(served_p, 2),
                "uncovered": round(max(0.0, dem_p - served_p), 2),
                "servicePct": round(min(100.0, max(0.0, pct)), 1),
                "transportM": round(transport_by_prod.get(pid, 0.0), 4),
            }
        )

    open_facilities: list[dict[str, Any]] = []
    for fid in open_ids:
        f = fac_by_id[fid]
        c = cmap.get(fid, {})
        cap_max = float(c.get("capacityMax") or _parse_volume(f.get("capacity"), 1e9))
        thr = sum(
            float(fl["volume"])
            for fl in flows
            if fl["from"] == fid
            and fl["echelon"]
            in ("dc→customer", "plant→dc", "plant→customer")
        )
        util = (thr / cap_max * 100) if cap_max > 0 else 0.0
        able = capable.get(fid)
        open_facilities.append(
            {
                "id": fid,
                "name": f.get("name", fid),
                "kind": f.get("kind"),
                "fixedCapexM": round(capex_cost[fid], 3),
                "fixedOpexM": round(opex_cost[fid], 3),
                "throughput": round(thr, 2),
                "capacityMax": round(cap_max, 2),
                "utilizationPct": round(min(100.0, util), 1),
                **(
                    {"capableProductIds": sorted(able)}
                    if able is not None
                    else {}
                ),
            }
        )

    # --- Lane flows / mode mix (computed before any dual re-solve) ---
    lane_flows: list[dict[str, Any]] = []
    for (a, b, mk), vol in lane_mode_vol.items():
        if vol <= 1e-4:
            continue
        meta = arc_meta.get((a, b, mk)) or {}
        entry = lane_opts.get((a, b)) or {}
        mcap = meta.get("capacity")
        lcap = entry.get("capacity")
        ref_cap = mcap if mcap is not None else lcap
        lane_flows.append(
            {
                "laneId": meta.get("laneId"),
                "from": a,
                "to": b,
                "mode": meta.get("label", DEFAULT_MODE_LABEL),
                "echelon": lane_mode_echelon.get((a, b, mk)),
                "volume": round(vol, 2),
                "transportCostM": round(lane_mode_cost.get((a, b, mk), 0.0), 4),
                "co2Kg": round(lane_mode_co2.get((a, b, mk), 0.0), 1),
                "tonneMiles": round(lane_mode_tm.get((a, b, mk), 0.0), 1),
                "leadDays": None
                if meta.get("leadDays") is None
                else round(float(meta["leadDays"]), 2),
                "modeCapacity": mcap,
                "laneCapacity": lcap,
                "utilizationPct": round(min(100.0, vol / ref_cap * 100), 1)
                if ref_cap
                else None,
                "fixedCostM": round(lane_fixed_cost.get((a, b, mk), 0.0), 4),
            }
        )
    lane_flows.sort(key=lambda r: (-(r["utilizationPct"] or 0.0), -r["volume"]))

    mix: dict[str, dict[str, Any]] = {}
    for (a, b, mk), vol in lane_mode_vol.items():
        if vol <= 1e-4:
            continue
        meta = arc_meta.get((a, b, mk)) or {}
        label = meta.get("label", DEFAULT_MODE_LABEL)
        m = mix.setdefault(
            label,
            {
                "mode": label,
                "volume": 0.0,
                "transportM": 0.0,
                "co2Kg": 0.0,
                "tonneMiles": 0.0,
                "lanes": set(),
                "leadWeighted": 0.0,
                "fixedM": 0.0,
            },
        )
        m["volume"] += vol
        m["transportM"] += lane_mode_cost.get((a, b, mk), 0.0)
        m["co2Kg"] += lane_mode_co2.get((a, b, mk), 0.0)
        m["tonneMiles"] += lane_mode_tm.get((a, b, mk), 0.0)
        m["lanes"].add((a, b))
        m["leadWeighted"] += float(meta.get("leadDays") or 0.0) * vol
        if z_on.get((a, b, mk)):
            m["fixedM"] += lane_fixed_cost.get((a, b, mk), 0.0)
    mix_total = sum(m["volume"] for m in mix.values()) or 1.0
    mode_mix = [
        {
            "mode": m["mode"],
            "volume": round(m["volume"], 2),
            "sharePct": round(m["volume"] / mix_total * 100, 1),
            "transportM": round(m["transportM"], 4),
            "laneFixedM": round(m["fixedM"], 4),
            "co2Kg": round(m["co2Kg"], 1),
            "tonneMiles": round(m["tonneMiles"], 1),
            "laneCount": len(m["lanes"]),
            "avgLeadDays": round(m["leadWeighted"] / m["volume"], 2)
            if m["volume"] > 0
            else None,
        }
        for m in sorted(mix.values(), key=lambda m: -m["volume"])
    ]
    transport_co2_kg = sum(lane_mode_co2.values())
    transport_tonne_miles = sum(lane_mode_tm.values())

    # --- Depth 8: ONE pure LP with every binary fixed at its MIP value; read
    # facility-capacity AND lane-capacity duals straight from HiGHS. ---
    t_dual0 = time.perf_counter()
    row_duals: dict[str, float] | None = None
    col_duals: dict[str, float] | None = None
    lp_dual_status = "none"
    bins = [(v, 1.0 if fid in open_ids else 0.0) for fid, v in y.items()]
    bins += [(v, 1.0 if z_on.get(k) else 0.0) for k, v in z.items()]
    saved_vals = {v.name: v.varValue for v in prob.variables()}
    saved_bins = [(v, v.cat, v.lowBound, v.upBound) for v, _ in bins]
    try:
        for v, fixed in bins:
            v.cat = pulp.LpContinuous
            v.lowBound = fixed
            v.upBound = fixed
        lp_solver, _ = _pick_solver([])
        lp_status = prob.solve(lp_solver)
        if pulp.LpStatus.get(lp_status) == "Optimal":
            row_duals = _highs_row_duals(prob)
            col_duals = _highs_col_duals(prob, [v for v, _ in bins])
            lp_dual_status = "optimal"
        else:
            lp_dual_status = "not-optimal"
    except Exception as exc:  # noqa: BLE001
        log.append(f"Sensitivity dual pass skipped: {exc}")
        lp_dual_status = "failed"
    finally:
        for v, cat, lo, up in saved_bins:
            v.cat = cat
            v.lowBound = lo
            v.upBound = up
        for v in prob.variables():
            if v.name in saved_vals:
                v.varValue = saved_vals[v.name]
    dual_seconds = round(time.perf_counter() - t_dual0, 3)

    def _row_dual(name: str) -> float | None:
        if row_duals is not None and name in row_duals:
            return row_duals[name]
        if lp_dual_status != "optimal":
            return None
        c = prob.constraints.get(name)
        return _safe_dual(c) if c is not None else None

    # Facility capacity shadow prices (real HiGHS row duals of cap_<fid>)
    shadow_prices: list[dict[str, Any]] = []
    thr_by_fac = {of["id"]: float(of["throughput"]) for of in open_facilities}
    for fid, (_constr, cap_max, _cap_min) in cap_constraints.items():
        cname = _safe_name("cap", fid)
        is_open = fid in open_ids
        thr = thr_by_fac.get(fid, 0.0)
        slack = max(0.0, cap_max - thr) if is_open else cap_max
        tight = is_open and slack < max(1.0, 0.01 * cap_max)
        pi = _row_dual(cname)
        if pi is None:
            # CBC / dual-less fallback: legacy reduced-cost proxy
            shadow_prices.append(
                {
                    "facilityId": fid,
                    "constraint": "capacity",
                    "shadowPrice": round(
                        (-uncovered_penalty * 0.01) if tight else 0.0, 6
                    ),
                    "unit": "$M per unit capacity",
                    "binding": tight,
                    "slack": round(slack, 2),
                    "method": "reduced-cost-proxy",
                }
            )
            continue
        if not is_open:
            # Closed site: row reads "flow ≤ 0" (degenerate with link rows) —
            # not a capacity limit, so no capacity dual.
            pi = 0.0
        if abs(pi) < 1e-12:
            pi = 0.0
        shadow_prices.append(
            {
                "facilityId": fid,
                "constraint": "capacity",
                "shadowPrice": round(pi, 6),
                "unit": "$M per unit capacity",
                "binding": bool(is_open and (tight or abs(pi) > 1e-7)),
                "slack": round(slack, 2),
                "method": "lp-dual",
                **({} if is_open else {"closed": True}),
            }
        )
    if not shadow_prices:
        dual_method = "none" if lp_dual_status != "failed" else "failed"
    elif all(sp["method"] == "lp-dual" for sp in shadow_prices):
        dual_method = "lp-dual"
    elif any(sp["method"] == "lp-dual" for sp in shadow_prices):
        dual_method = "mixed-dual-proxy"
    else:
        dual_method = "reduced-cost-proxy" if lp_dual_status != "failed" else "failed"

    # --- Lane capacity duals (same LP pass) ---
    lane_capacity: list[dict[str, Any]] = []
    lane_dual_method = "none"
    if lane_cap_rows:
        lane_duals: dict[str, float | None] = {
            row["name"]: _row_dual(row["name"]) for row in lane_cap_rows
        }
        if lp_dual_status == "optimal":
            lane_dual_method = (
                "lp-dual"
                if any(v is not None for v in lane_duals.values())
                else "lp-no-duals"
            )
        elif lp_dual_status == "failed":
            lane_dual_method = "failed"
        else:
            lane_dual_method = "lp-not-optimal"

        for row in lane_cap_rows:
            a, b, mk = row["from"], row["to"], row["mk"]
            vol = lane_vol.get((a, b), 0.0) if mk is None else lane_mode_vol.get((a, b, mk), 0.0)
            cap = row["capacity"]
            slack = max(0.0, cap - vol)
            pi = lane_duals.get(row["name"])
            inactive = bool(row.get("fixedCharge")) and not z_on.get((a, b, mk))
            if inactive:
                # Fixed-charge lane-mode left off: its row is "flow ≤ 0", not a
                # capacity limit — no binding chip, no capacity dual.
                pi = None
                binding = False
            else:
                binding = slack <= max(1e-6, 1e-4 * cap) or (
                    pi is not None and abs(pi) > 1e-7
                )
            meta = arc_meta.get((a, b, mk)) if mk is not None else None
            lane_capacity.append(
                {
                    "laneId": row["laneId"],
                    "from": a,
                    "to": b,
                    "scope": row["scope"],
                    "mode": None if meta is None else meta.get("label"),
                    "capacity": round(cap, 2),
                    "volume": round(vol, 2),
                    "utilizationPct": round(min(100.0, vol / cap * 100), 1)
                    if cap > 0
                    else 0.0,
                    "slack": round(slack, 2),
                    "binding": bool(binding),
                    "shadowPrice": None if pi is None else round(pi, 6),
                    "unit": "$M per unit lane capacity",
                    "method": "inactive-mode"
                    if inactive
                    else ("lp-dual" if pi is not None else "slack-only"),
                    **(
                        {"fixedCharge": True, "active": not inactive}
                        if row.get("fixedCharge")
                        else {}
                    ),
                }
            )
        lane_capacity.sort(key=lambda r: (-r["utilizationPct"], r["laneId"] or ""))
    binding_lanes = [r for r in lane_capacity if r["binding"]]

    # Lane utilization rollup (one row per used capacitated / multi-mode lane)
    lane_util: list[dict[str, Any]] = []
    for (a, b), vol in lane_vol.items():
        entry = lane_opts.get((a, b))
        if entry is None or vol <= 1e-4:
            continue
        eff = _lane_effective_cap(a, b)
        if math.isinf(eff) and not entry["explicitModes"]:
            continue
        modes_rows = []
        for mk in sorted(lane_active_modes.get((a, b), set())):
            meta = arc_meta.get((a, b, mk)) or {}
            mv = lane_mode_vol.get((a, b, mk), 0.0)
            mcap = meta.get("capacity")
            modes_rows.append(
                {
                    "mode": meta.get("label", DEFAULT_MODE_LABEL),
                    "volume": round(mv, 2),
                    "capacity": mcap,
                    "utilizationPct": round(min(100.0, mv / mcap * 100), 1)
                    if mcap
                    else None,
                }
            )
        lane_util.append(
            {
                "laneId": entry["laneId"],
                "from": a,
                "to": b,
                "volume": round(vol, 2),
                "capacity": None if math.isinf(eff) else round(eff, 2),
                "utilizationPct": None
                if math.isinf(eff) or eff <= 0
                else round(min(100.0, vol / eff * 100), 1),
                "binding": any(
                    r["binding"] and r["from"] == a and r["to"] == b
                    for r in binding_lanes
                ),
                "modes": modes_rows,
            }
        )
    lane_util.sort(key=lambda r: (-(r["utilizationPct"] or 0.0), -r["volume"]))

    ref = payload.get("reference") or {}
    ref_kpis = ref.get("kpis") or {}
    ref_cost = _parse_money((ref_kpis.get("cost") or {}).get("value"), 48.2)
    ref_co2 = _parse_money(
        str((ref_kpis.get("co2") or {}).get("value", "12.4")).replace("kt", ""),
        12.4,
    )
    # D-06: lane fixed (activation) charges are part of run-rate cost.
    cost_m = max(1.0, transport_cost + opex_used + capex_used * 0.12 + lane_fixed_used)
    if cost_m < ref_cost * 0.2:
        cost_m = max(20.0, ref_cost * 0.85 + cost_m)
    if transport_co2_kg > 0:
        # D-05: CO2 KPI is the modelled transport CO2 (same basis as carbonM).
        co2_kt = transport_co2_kg / 1e6
    else:
        co2_kt = max(
            4.0,
            ref_co2
            - len(opened_ids) * 0.35
            - len(closed_ids) * 0.15
            + transport_cost * 0.05,
        )

    objective_breakdown = {
        "totalM": round(objective_total, 4),
        "transportM": round(transport_cost, 4),
        "fixedCapexM": round(capex_used, 4),
        "fixedOpexM": round(opex_used, 4),
        "uncoveredPenaltyM": round(uncovered_pen, 4),
        "laneFixedM": round(lane_fixed_used, 4),
        "carbonM": round(carbon_cost, 4),
        "modeMix": mode_mix,
        "currency": "model-$M",
        "uncoveredPenaltyPerUnit": cost_scale["uncoveredPenaltyPerUnit"],
        "offLaneRatePerUnitMile": cost_scale["offLaneRatePerUnitMile"],
    }

    mode_choice_on = lane_stats["lanesWithModes"] > 0
    log.append(
        f"Done: {len(open_ids)} open · CapEx ${capex_used:.1f}M + OpEx ${opex_used:.1f}M "
        f"/ budget ${budget}M · transport ${transport_cost:.3f}M · "
        f"service {service_pct:.1f}% (target {target_pct}%) · "
        f"flows {len(flows)} · commodities={commodity_mode} · duals={dual_method}."
    )
    if mode_choice_on or lane_cap_rows:
        log.append(
            "Lanes: mode mix "
            + (
                ", ".join(f"{m['mode']} {m['sharePct']:.0f}%" for m in mode_mix)
                or "—"
            )
            + f" · {len(binding_lanes)} binding lane cap(s) of {len(lane_cap_rows)}"
            + (f" · lane fixed ${lane_fixed_used:.3f}M" if z else "")
            + f" · lane duals={lane_dual_method}."
        )
    if service_pct + 0.05 < target_pct:
        log.append(
            f"Note: service {service_pct:.1f}% below target {target_pct}% "
            "(radius / budget / capacity / max facilities binding)."
        )
    if lane_short["customers"] or lane_short["plantOutbound"]:
        log.append(
            f"Lane capacity shortfall: {len(lane_short['customers'])} customer(s) "
            "with inbound lane capacity < demand"
            + (" + plant outbound lanes short" if lane_short["plantOutbound"] else "")
            + "."
        )

    result: dict[str, Any] = {
        "ok": True,
        "solver": solver_name,
        "status": status_name,
        "model": "fixed-charge-multi-echelon-v1",
        "solveSeconds": solve_seconds,
        "openedIds": opened_ids,
        "closedIds": closed_ids,
        "keptOpenIds": kept_open,
        "openIds": open_ids,
        "openFacilities": open_facilities,
        "flows": flows,
        "objectiveBreakdown": objective_breakdown,
        "shadowPrices": shadow_prices,
        "sensitivity": {
            "method": dual_method,
            "laneMethod": lane_dual_method,
            "note": (
                "Facility + lane capacity shadow prices are HiGHS row duals "
                "from one pure LP with every open/close and lane-mode binary "
                "fixed at its MIP value ($M objective change per extra unit of "
                "capacity; negative = saving). Reduced-cost proxy only when "
                "the solver returns no duals (e.g. CBC)."
            ),
            "dualSeconds": dual_seconds,
        },
        "commodityMode": commodity_mode,
        "hardServiceConstraints": hard_service,
        "productBreakdown": product_breakdown if multi else product_breakdown,
        "modeChoice": {
            "enabled": mode_choice_on,
            **{k: v for k, v in lane_stats.items()},
            "laneModeBinaries": len(z),
            "serviceFilteredModes": lead_filtered_modes,
            "carbonPricePerTonne": carbon_price,
            "tonsPerUnit": round(tons_per_unit, 6),
        },
        "co2Basis": {
            **weight_info,
            "demandWeightedUnitWeightKg": round(tons_per_unit * 1000.0, 4),
            "transportTonneMiles": round(transport_tonne_miles, 1),
            "transportTonneKm": round(transport_tonne_miles * KM_PER_MILE, 1),
            "emissionKgPerTonneMileByMode": emission_factors,
            "formula": "CO2 kg = tonne-miles x mode factor (kg/tonne-mile); "
            "tonnes = physical units x unit weight; carbon $ = CO2 t x price",
        },
        "laneFlows": lane_flows,
        "laneUtilization": lane_util,
        "laneCapacity": lane_capacity,
        "bindingLaneCapacities": binding_lanes,
        "laneCapacityShortfalls": lane_short,
        "costScale": {
            k: v for k, v in cost_scale.items() if k not in ("offLaneRateM", "uncoveredPenaltyM")
        },
        "kpis": {
            "servicePct": round(service_pct, 1),
            "capexUsedM": round(capex_used, 1),
            "opexUsedM": round(opex_used, 1),
            "transportCostM": round(transport_cost, 4),
            "costM": round(cost_m, 1),
            "co2Kt": round(co2_kt, 1),
            "uncoveredDemand": round(uncovered_total, 1),
            "targetPct": target_pct,
            "objectiveTotalM": round(objective_total, 4),
            "productCount": len(product_ids),
            "transportCo2Kt": round(transport_co2_kg / 1e6, 3),
            "transportCo2Tonnes": round(transport_co2_kg / 1e3, 3),
            "transportTonneKm": round(transport_tonne_miles * KM_PER_MILE, 1),
            "co2GPerTonneKm": round(transport_co2_kg * 1000 / (transport_tonne_miles * KM_PER_MILE), 2)
            if transport_tonne_miles > 0
            else None,
            "laneFixedM": round(lane_fixed_used, 4),
            "carbonM": round(carbon_cost, 4),
            "bindingLaneCount": len(binding_lanes),
        },
        "log": log,
    }

    # --- Depth 8: explain block (opt-in) ---
    ex_opts = explain_options(payload)
    if ex_opts["enabled"]:
        locked: dict[str, str] = {}
        for fid in y:
            if _safe_name("forced_open", fid) in prob.constraints:
                locked[fid] = "open"
            elif _safe_name("forced_closed", fid) in prob.constraints:
                locked[fid] = "closed"

        def _counterfactual(fid: str, flip_to: int, time_limit: float) -> dict[str, Any]:
            """Re-solve the MIP with ``fid`` forced to ``flip_to`` (lock lifted)."""
            orig = dict(prob.constraints)
            for nm in (_safe_name("forced_open", fid), _safe_name("forced_closed", fid)):
                prob.constraints.pop(nm, None)
            prob.addConstraint(y[fid] == flip_to, "cf_flip")
            t0 = time.perf_counter()
            try:
                # Counterfactuals only need flip deltas to ~0.05% of the
                # objective (explain gapToleranceM); a 5e-4 relative MIP gap
                # cuts stress-200 re-solves ~5× vs the 1e-4 default.
                if solver_name == "pulp-highs":
                    cf_solver = pulp.HiGHS(
                        msg=False, timeLimit=time_limit, gapRel=CF_MIP_GAP_REL
                    )
                else:
                    cf_solver = pulp.PULP_CBC_CMD(
                        msg=False, timeLimit=time_limit, gapRel=CF_MIP_GAP_REL
                    )
                st = prob.solve(cf_solver)
                secs = time.perf_counter() - t0
                st_name = pulp.LpStatus.get(st, str(st))
                if st != 1:
                    return {"status": "infeasible" if st in (-1, -3) else st_name.lower(),
                            "seconds": round(secs, 3)}
                parts = _cost_parts()
                cf_open = [k for k in y if _val(y[k]) > 0.5]
                return {
                    "status": "optimal"
                    if getattr(prob, "sol_status", 1) == pulp.LpSolutionOptimal
                    else "time-limit",
                    "seconds": round(secs, 3),
                    "parts": parts,
                    "openIds": cf_open,
                }
            except Exception as exc:  # noqa: BLE001
                return {"status": "error", "error": str(exc),
                        "seconds": round(time.perf_counter() - t0, 3)}
            finally:
                prob.constraints.clear()
                prob.constraints.update(orig)

        saved_cf = {v.name: v.varValue for v in prob.variables()}
        try:
            result["explain"] = build_explain(
                decidable=decidable,
                fac_by_id=fac_by_id,
                y_ids=list(y.keys()),
                open_ids=open_ids,
                seed_open=seed_open,
                locked=locked,
                capex_cost=capex_cost,
                opex_cost=opex_cost,
                cap_info={fid: v[1] for fid, v in cap_constraints.items()},
                cmap=cmap,
                flows=flows,
                open_facilities=open_facilities,
                shadow_prices=shadow_prices,
                col_duals={fid: (col_duals or {}).get(y[fid].name) for fid in y},
                reachable=reachable,
                dem_map=dem_map,
                total_demand=total_demand,
                base_parts=base_parts,
                hard_service=hard_service,
                solve_seconds=solve_seconds,
                dual_seconds=dual_seconds,
                counterfactual=_counterfactual,
                options=ex_opts,
                parse_volume=_parse_volume,
            )
        finally:
            for v in prob.variables():
                if v.name in saved_cf:
                    v.varValue = saved_cf[v.name]
        log.append(
            f"Explain: {result['explain']['timing']['counterfactualCount']} "
            f"counterfactual re-solve(s) in "
            f"{result['explain']['timing']['counterfactualSeconds']:.2f}s."
        )
    return result


def _infeasible_result(
    *,
    solver_name: str,
    log: list[str],
    report: dict[str, Any],
    product_ids: list[str],
    product_labels: dict[str, str],
    dem_map: dict[tuple[str, str], float],
    commodity_mode: str,
    hard_service: bool,
    target_pct: float,
    solve_seconds: float = 0.0,
    status_name: str = "Infeasible",
) -> dict[str, Any]:
    dem_by_prod = {
        pid: sum(v for (c, p), v in dem_map.items() if p == pid)
        for pid in product_ids
    }
    product_breakdown = [
        {
            "productId": pid,
            "label": product_labels.get(pid, pid),
            "demand": round(dem_by_prod.get(pid, 0.0), 2),
            "served": 0.0,
            "uncovered": round(dem_by_prod.get(pid, 0.0), 2),
            "servicePct": 0.0,
            "transportM": 0.0,
        }
        for pid in product_ids
    ]
    total_demand = sum(dem_map.values())
    return {
        "ok": False,
        "solver": solver_name,
        "status": status_name,
        "model": "fixed-charge-multi-echelon-v1",
        "solveSeconds": solve_seconds,
        "openedIds": [],
        "closedIds": [],
        "keptOpenIds": [],
        "openIds": [],
        "openFacilities": [],
        "flows": [],
        "objectiveBreakdown": {
            "totalM": 0.0,
            "transportM": 0.0,
            "fixedCapexM": 0.0,
            "fixedOpexM": 0.0,
            "uncoveredPenaltyM": 0.0,
            "laneFixedM": 0.0,
            "carbonM": 0.0,
            "modeMix": [],
            "currency": "model-$M",
        },
        "shadowPrices": [],
        "laneFlows": [],
        "laneUtilization": [],
        "laneCapacity": [],
        "bindingLaneCapacities": [],
        "sensitivity": {"method": "none", "note": "Skipped — infeasible."},
        "commodityMode": commodity_mode,
        "hardServiceConstraints": hard_service,
        "productBreakdown": product_breakdown,
        "infeasibilityReport": report,
        "kpis": {
            "servicePct": 0.0,
            "capexUsedM": 0.0,
            "opexUsedM": 0.0,
            "transportCostM": 0.0,
            "costM": 0.0,
            "co2Kt": 0.0,
            "uncoveredDemand": round(total_demand, 1),
            "targetPct": target_pct,
            "objectiveTotalM": 0.0,
            "productCount": len(product_ids),
        },
        "log": log,
    }


# --- D-02 / D-03: root-cause probes for MIP infeasibility ---------------------


def _root_cause_probes(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """Re-solve with one constraint family relaxed at a time.

    If dropping facility minimum throughput (capacityMin) or lane capacity
    makes the model feasible, that family is a genuine root cause. The relaxed
    solution then tells us *which* sites / lanes and *by how much*.
    """
    import copy as _copy

    hints: list[dict[str, Any]] = []
    cons = payload.get("constraints") or {}
    facs = list(cons.get("facilities") or [])
    lanes = list((payload.get("network") or {}).get("lanes") or [])

    def _solve(p: dict[str, Any]) -> dict[str, Any]:
        q = _copy.deepcopy(p)
        q["_diagProbe"] = True
        q["explain"] = False
        return solve_optimize(q)

    has_mins = any(float(f.get("capacityMin") or 0) > 0 for f in facs)
    has_lane_caps = cons.get("enforceLaneCapacity", True) is not False and any(
        l.get("capacityUnits") is not None
        or _lane_capacity(l) is not None
        or any(_lane_capacity(m or {}) is not None for m in (l.get("modes") or []))
        for l in lanes
    )

    def _min_hint(r: dict[str, Any], both: bool) -> dict[str, Any]:
        thr: dict[str, float] = {}
        for fl in r.get("flows") or []:
            thr[fl["from"]] = thr.get(fl["from"], 0.0) + float(fl.get("volume") or 0)
        open_ids = set(r.get("openIds") or [])
        rows = []
        for f in facs:
            mn = float(f.get("capacityMin") or 0)
            if mn <= 0:
                continue
            got = thr.get(f["nodeId"], 0.0)
            if f["nodeId"] in open_ids and got + 1e-6 < mn:
                rows.append((f["nodeId"], mn, got))
        if not rows:  # flag every site with a minimum when none is visibly short
            rows = [
                (f["nodeId"], float(f["capacityMin"]), thr.get(f["nodeId"], 0.0))
                for f in facs
                if float(f.get("capacityMin") or 0) > 0
            ]
        detail = ", ".join(f"{fid} min {mn:.0f} vs feasible {got:.0f}" for fid, mn, got in rows[:6])
        return {
            "code": "MIN_THROUGHPUT_CONFLICT",
            "severity": "high",
            "rootCause": True,
            "message": (
                "Root cause: facility minimum throughput (capacityMin) cannot be met"
                + (" together with lane capacity" if both else "")
                + f" — with minimums relaxed the model solves "
                f"(service {r['kpis']['servicePct']:.1f}%, ${r['objectiveBreakdown']['totalM']:.2f}M). "
                + detail
                + "."
            ),
            "entities": [fid for fid, _, _ in rows[:8]],
            "shortfalls": [
                {"facilityId": fid, "capacityMin": round(mn, 2), "feasibleThroughput": round(got, 2),
                 "gap": round(mn - got, 2)}
                for fid, mn, got in rows
            ],
            "relaxedObjectiveM": r["objectiveBreakdown"]["totalM"],
            "relaxedServicePct": r["kpis"]["servicePct"],
            "hint": "Lower capacityMin on the listed sites, let them close, or restore the lanes that fed them.",
        }

    def _lane_hint(r: dict[str, Any], both: bool) -> dict[str, Any] | None:
        cap_by_lane = {}
        for l in lanes:
            if l.get("capacityUnits") is not None:
                cap_by_lane[str(l.get("id"))] = (float(l["capacityUnits"]), l.get("from"), l.get("to"))
        flow_by_lane: dict[str, float] = {}
        for fl in r.get("flows") or []:
            lid = fl.get("laneId")
            if lid:
                flow_by_lane[str(lid)] = flow_by_lane.get(str(lid), 0.0) + float(fl.get("volume") or 0)
        rows = []
        for lid, (cap, a, b) in cap_by_lane.items():
            need = flow_by_lane.get(lid, 0.0)
            if need > cap + 1e-6:
                rows.append({"laneId": lid, "from": a, "to": b, "capacityUnits": round(cap, 2),
                             "requiredFlow": round(need, 2), "shortBy": round(need - cap, 2)})
        rows.sort(key=lambda x: -x["shortBy"])
        if not rows:
            return None
        detail = "; ".join(
            f"{x['laneId']} ({x['from']}→{x['to']}) cap {x['capacityUnits']:.0f} vs needed "
            f"{x['requiredFlow']:.0f} (short {x['shortBy']:.0f})" for x in rows[:6]
        )
        return {
            "code": "LANE_CAPACITY_CONFLICT",
            "severity": "high",
            "rootCause": True,
            "message": (
                "Root cause: lane capacity"
                + (" together with facility minimum throughput" if both else "")
                + f" — {detail}."
            ),
            "entities": [x["laneId"] for x in rows[:8]],
            "customers": sorted({x["to"] for x in rows}),
            "shortfalls": rows,
            "relaxedObjectiveM": r["objectiveBreakdown"]["totalM"],
            "hint": "Raise capacityUnits on the listed lanes, add a parallel lane / mode, or relax capacityMin on the sites they feed.",
        }

    def _no_mins(p):
        q = _copy.deepcopy(p)
        for f in q["constraints"].get("facilities") or []:
            f["capacityMin"] = 0
        return q

    def _no_lanes(p):
        q = _copy.deepcopy(p)
        q["constraints"]["enforceLaneCapacity"] = False
        return q

    r_min = _solve(_no_mins(payload)) if has_mins else None
    r_lane = _solve(_no_lanes(payload)) if has_lane_caps else None
    min_ok = bool(r_min and r_min.get("status") == "Optimal")
    lane_ok = bool(r_lane and r_lane.get("status") == "Optimal")
    if min_ok:
        hints.append(_min_hint(r_min, both=lane_ok))
    if lane_ok:
        h = _lane_hint(r_lane, both=min_ok)
        if h:
            hints.append(h)
    if not min_ok and not lane_ok and has_mins and has_lane_caps:
        r_both = _solve(_no_lanes(_no_mins(payload)))
        if r_both.get("status") == "Optimal":
            hints.append(_min_hint(r_both, both=True))
            h = _lane_hint(r_both, both=True)
            if h:
                hints.append(h)
    return hints


def _merge_probe_hints(res: dict[str, Any], probe: list[dict[str, Any]]) -> None:
    report = res.get("infeasibilityReport") or {}
    old = list(report.get("hints") or [])
    for h in old:
        if h.get("code") == "UNREACHABLE_DEMAND" and not res.get("hardServiceConstraints"):
            h["severity"] = "info"
            h["rootCause"] = False
            h["message"] += " Soft service: this demand is penalised as unmet, not the cause of infeasibility."
    codes = {h["code"] for h in probe}
    hints = probe + [h for h in old if h["code"] not in codes]
    report["hints"] = hints
    report["rootCauses"] = [h["code"] for h in probe]
    report["summary"] = "; ".join(h["message"] for h in hints[:3])
    report["method"] = "structural + relaxation probes"
    res["infeasibilityReport"] = report
    if "hints" in res:
        res["hints"] = hints
