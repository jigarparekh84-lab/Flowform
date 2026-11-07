"""Server port of the web enterprise data-pack validator (apps/web/src/data/
enterprisePack.ts ``validateEnterprisePack``): identical issue codes, messages,
hints, ordering and scorecard.

Parity with the TypeScript original is locked by
``apps/api/tests/test_pack_validation_parity.py`` against a checked-in fixture
of the browser validator's own output (regenerate with
``cd apps/web && npm run gen:pack-parity``). JavaScript semantics — undefined vs
null, ``ToNumber``, template-literal number formatting, ``Math.round``, and
``Set`` identity where ``true`` and ``1`` are distinct — are emulated on purpose
so both sides agree on malformed input too.

Status: not yet wired into a route. It is the server-side half of the pack
validation the browser already runs; the parity test keeps it honest until the
Data room stops scoring packs client-side.
"""

from __future__ import annotations

import math
from typing import Any

SCHEMA_VERSION = "enterprise-data-v1"
PACK_FORMAT = "flowform-enterprise-pack"
KNOWN_LANE_MODES = ["Truck", "Rail", "Intermodal", "Ocean", "Air", "Parcel"]
FACILITY_KINDS = ["plant", "dc", "candidate", "supplier"]
VALID_KINDS = ["plant", "dc", "demand", "supplier", "candidate"]
VALID_STATUS = ["open", "closed", "candidate"]
MIN_PLAUSIBLE_UNIT_KG = 0.005
MAX_PLAUSIBLE_UNIT_KG = 1500
DEFAULT_UNIT_WEIGHT_KG = 20


class _Undef:
    def __repr__(self) -> str:
        return "undefined"


UNDEF: Any = _Undef()


def _g(o: Any, k: str) -> Any:
    return o.get(k, UNDEF) if isinstance(o, dict) else UNDEF


def _nullish(v: Any) -> bool:
    return v is None or v is UNDEF


def _num(v: Any) -> float:
    """JS ToNumber."""
    if v is UNDEF:
        return math.nan
    if v is None:
        return 0.0
    if isinstance(v, bool):
        return 1.0 if v else 0.0
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        s = v.strip()
        if s == "":
            return 0.0
        try:
            return float(s)
        except ValueError:
            return math.nan
    return math.nan


def _is_number(v: Any) -> bool:  # typeof v === 'number'
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _finite(v: Any) -> bool:  # Number.isFinite
    return _is_number(v) and math.isfinite(v)


def _s(v: Any) -> str:
    """JS String(v) / template literal."""
    if v is UNDEF:
        return "undefined"
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        f = float(v)
        if math.isnan(f):
            return "NaN"
        if math.isinf(f):
            return "Infinity" if f > 0 else "-Infinity"
        if f == int(f) and abs(f) < 1e21:
            return str(int(f))
        r = repr(f)
        if "e" in r:
            m, e = r.split("e")
            r = f"{m}e{'-' if e.startswith('-') else '+'}{int(e.lstrip('+-'))}"
        return r
    if isinstance(v, list):
        return ",".join("" if _nullish(x) else _s(x) for x in v)
    if isinstance(v, dict):
        return "[object Object]"
    return str(v)


def _jround(x: float) -> int:
    return math.floor(x + 0.5)


def _weight_issue(w: Any) -> str | None:
    if not _is_number(w) or not math.isfinite(w) or w <= 0:
        return "invalid"
    if w < MIN_PLAUSIBLE_UNIT_KG or w > MAX_PLAUSIBLE_UNIT_KG:
        return "implausible"
    return None


def _arr(v: Any) -> list:
    return v if isinstance(v, list) else []


class _IdSet(set):
    """A set of ids with JavaScript ``Set`` semantics.

    Python collapses ``True == 1`` (and hashes them alike), so a site with id
    ``1`` and one with id ``true`` would look like a duplicate; JS keeps them
    distinct. Ids are values here, so match on type *and* value. Only ``add``,
    ``in`` and truthiness are used on these sets.
    """

    @staticmethod
    def _key(v: Any) -> tuple[str, Any]:
        if isinstance(v, bool):
            return ("bool", v)
        if isinstance(v, (int, float)):
            return ("num", float(v))
        if isinstance(v, str):
            return ("str", v)
        if v is None:
            return ("null", None)
        if v is UNDEF:
            return ("undefined", None)
        return ("other", _s(v))

    def add(self, v: Any) -> None:
        super().add(self._key(v))

    def __contains__(self, v: Any) -> bool:  # type: ignore[override]
        return super().__contains__(self._key(v))


def _detect_bom_cycles(rows: list) -> list[list[str]]:
    adj: dict[Any, list] = {}
    for r in rows:
        p, c = _g(r, "parentSkuId"), _g(r, "childSkuId")
        if not p or not c or _nullish(p) or _nullish(c):
            continue
        lst = adj.setdefault(p, [])
        if c not in lst:
            lst.append(c)
    cycles: list[list[str]] = []
    visiting: set = set()
    visited: set = set()
    stack: list = []

    def dfs(node: Any) -> None:
        if node in visiting:
            ix = stack.index(node) if node in stack else -1
            cycles.append([*stack[ix:], node] if ix >= 0 else [node, node])
            return
        if node in visited:
            return
        visiting.add(node)
        stack.append(node)
        for nxt in adj.get(node, []):
            dfs(nxt)
        stack.pop()
        visiting.discard(node)
        visited.add(node)

    for k in list(adj.keys()):
        dfs(k)
    return cycles


def _issue(level: str, code: str, message: str, hint: str, entity: Any = UNDEF) -> dict[str, Any]:
    out: dict[str, Any] = {"level": level, "code": code, "message": message}
    if entity is not UNDEF:
        out["entityId"] = entity
    out["hint"] = hint
    return out


def validate_enterprise_pack(pack: Any) -> dict[str, Any]:
    """Port of validateEnterprisePack → scorecard dict (camelCase like the web)."""
    issues: list[dict[str, Any]] = []
    I = issues.append  # noqa: E741

    if not isinstance(pack, dict) or not isinstance(pack.get("sites"), list):
        I(_issue("error", "EMPTY_PACK", "Enterprise pack is missing or has no sites array.",
                 "Import a flowform-enterprise-pack JSON or build from the active network."))
        return _scorecard(issues, pack if isinstance(pack, dict) else None, {})

    fmt, ver = _g(pack, "format"), _g(pack, "schemaVersion")
    if fmt != PACK_FORMAT or ver != SCHEMA_VERSION:
        I(_issue("warn", "SCHEMA_MISMATCH",
                 f"Expected format {PACK_FORMAT} @ {SCHEMA_VERSION}; got {'?' if _nullish(fmt) else _s(fmt)} @ {'?' if _nullish(ver) else _s(ver)}.",
                 "Re-export from Data room or bump the pack to the current schema version."))

    sites = pack["sites"]
    demand = _arr(pack.get("demand"))
    lanes = _arr(pack.get("lanes"))
    bom = _arr(pack.get("bom"))
    skus = _arr(pack.get("skus"))
    groups = _arr(pack.get("productGroups"))

    if len(sites) == 0 and len(demand) == 0:
        I(_issue("error", "EMPTY_PACK", "Pack has zero sites and zero demand rows.",
                 "Add facility/demand sites or import a sample pack."))

    site_ids: set = _IdSet()
    site_by_id: dict = {}
    geo_hits = geo_total = cap_issues = 0
    for s in sites:
        sid = _g(s, "id")
        kind, status = _g(s, "kind"), _g(s, "status")
        if sid in site_ids:
            I(_issue("error", "DUPLICATE_SITE_ID", f'Duplicate site id "{_s(sid)}".',
                     f'Rename or merge site "{_s(sid)}" so every id is unique.', sid))
        site_ids.add(sid)
        site_by_id.setdefault(sid, s)
        if kind not in VALID_KINDS:
            I(_issue("error", "UNKNOWN_SITE_KIND", f'Site "{_s(sid)}" has unknown kind "{_s(kind)}".',
                     "Use plant | dc | demand | supplier | candidate.", sid))
        if status not in VALID_STATUS:
            I(_issue("error", "INVALID_SITE_STATUS", f'Site "{_s(sid)}" has invalid status "{_s(status)}".',
                     "Use open | closed | candidate.", sid))
        geo_total += 1
        lat, lng = _g(s, "lat"), _g(s, "lng")
        if not _nullish(lat) and not _nullish(lng) and _finite(lat) and _finite(lng):
            geo_hits += 1
        elif kind in FACILITY_KINDS or kind == "demand":
            I(_issue("warn", "GEOCODE_GAP", f'Site "{_s(sid)}" ({_s(_g(s, "name"))}) missing lat/lng.',
                     "Add WGS84 lat/lng so MapLibre + distance/CO2 are accurate.", sid))
        if kind in FACILITY_KINDS:
            cmax_r, cmin_r, fc_r = _g(s, "capacityMax"), _g(s, "capacityMin"), _g(s, "fixedCostM")
            cmax, cmin, fc = _num(cmax_r), _num(cmin_r), _num(fc_r)
            if cmax <= 0:
                cap_issues += 1
                I(_issue("error", "CAPACITY_NONPOSITIVE", f'Site "{_s(sid)}" capacityMax must be > 0 (got {_s(cmax_r)}).',
                         "Set capacityMax to a positive throughput (units).", sid))
            if cmin < 0:
                cap_issues += 1
                I(_issue("error", "CAPACITY_NONPOSITIVE", f'Site "{_s(sid)}" capacityMin must be >= 0 (got {_s(cmin_r)}).',
                         "Set capacityMin to 0 or a positive minimum throughput.", sid))
            if cmin > cmax and cmax > 0:
                cap_issues += 1
                I(_issue("error", "CAPACITY_MIN_GT_MAX",
                         f'Site "{_s(sid)}" capacityMin ({_s(cmin_r)}) > capacityMax ({_s(cmax_r)}).',
                         "Lower capacityMin or raise capacityMax.", sid))
            if fc < 0:
                I(_issue("error", "FIXED_COST_NEGATIVE", f'Site "{_s(sid)}" fixedCostM is negative.',
                         "Use >= 0 CapEx $M (0 if already open / sunk).", sid))

    group_ids: set = _IdSet()
    for g in groups:
        gid = _g(g, "id")
        if gid in group_ids:
            I(_issue("error", "DUPLICATE_GROUP_ID", f'Duplicate product group id "{_s(gid)}".',
                     "Make product group ids unique.", gid))
        group_ids.add(gid)

    sku_ids: set = _IdSet()
    for sku in skus:
        kid, grp = _g(sku, "id"), _g(sku, "groupId")
        if kid in sku_ids:
            I(_issue("error", "DUPLICATE_SKU_ID", f'Duplicate SKU id "{_s(kid)}".', "Make SKU ids unique.", kid))
        sku_ids.add(kid)
        if grp and not _nullish(grp) and group_ids and grp not in group_ids:
            I(_issue("warn", "ORPHAN_SKU_GROUP", f'SKU "{_s(kid)}" references missing group "{_s(grp)}".',
                     "Add the product group or clear groupId on the SKU.", kid))

    implausible_hint = "Check the unit: weights are kg per physical unit (not tonnes, not per 1,000 units)."
    group_weight: dict = {}
    for g in groups:
        w = _g(g, "unitWeightKg")
        if _nullish(w):
            continue
        gid = _g(g, "id")
        wi = _weight_issue(w)
        if wi == "invalid":
            I(_issue("error", "GROUP_WEIGHT_INVALID", f'Product group "{_s(gid)}" unitWeightKg {_s(w)} must be a positive number.',
                     "Set the shipping weight per unit in kg (e.g. 2.0) or clear it to use the project default.", gid))
            continue
        if wi == "implausible":
            I(_issue("warn", "GROUP_WEIGHT_IMPLAUSIBLE",
                     f'Product group "{_s(gid)}" unitWeightKg {_s(w)} kg is outside {_s(MIN_PLAUSIBLE_UNIT_KG)}–{_s(MAX_PLAUSIBLE_UNIT_KG)} kg.',
                     implausible_hint, gid))
        group_weight[gid] = w

    default_w = _g(_g(pack, "globals"), "defaultUnitWeightKg")
    if _nullish(default_w):
        default_w = _g(_g(pack, "costFactors"), "defaultUnitWeightKg")
    if not _nullish(default_w) and _weight_issue(default_w) == "invalid":
        I(_issue("error", "DEFAULT_WEIGHT_INVALID", f"Project default unitWeightKg {_s(default_w)} must be a positive number.",
                 f"Set a positive kg/unit default or clear it (solver default {DEFAULT_UNIT_WEIGHT_KG} kg)."))

    demanded = {_g(d, "skuId") for d in demand}
    unweighted: list = []
    for sku in skus:
        kid, w = _g(sku, "id"), _g(sku, "unitWeightKg")
        if not _nullish(w):
            wi = _weight_issue(w)
            if wi == "invalid":
                I(_issue("error", "SKU_WEIGHT_INVALID", f'SKU "{_s(kid)}" unitWeightKg {_s(w)} must be a positive number.',
                         "Set the shipping weight per unit in kg or clear it to inherit the group / project default.", kid))
                continue
            if wi == "implausible":
                I(_issue("warn", "SKU_WEIGHT_IMPLAUSIBLE",
                         f'SKU "{_s(kid)}" unitWeightKg {_s(w)} kg is outside {_s(MIN_PLAUSIBLE_UNIT_KG)}–{_s(MAX_PLAUSIBLE_UNIT_KG)} kg.',
                         implausible_hint, kid))
            continue
        grp = _g(sku, "groupId")
        if kid in demanded and not (grp and not _nullish(grp) and grp in group_weight):
            unweighted.append(kid)
    if unweighted:
        head = ", ".join(_s(x) for x in unweighted[:4])
        more = "…" if len(unweighted) > 4 else ""
        dw = DEFAULT_UNIT_WEIGHT_KG if _nullish(default_w) else default_w
        I(_issue("info", "SKU_WEIGHT_MISSING",
                 f"{len(unweighted)} demanded SKU(s) have no unit weight ({head}{more}) — CO₂ uses the project default {_s(dw)} kg/unit.",
                 "Add unitWeightKg on the SKU or its product group for realistic tonne-miles / CO₂."))

    demand_ids: set = set()
    orphan = 0
    vol_total = 0.0
    for d in demand:
        did, cust_id, sku_id, vol_r = _g(d, "id"), _g(d, "customerId"), _g(d, "skuId"), _g(d, "volume")
        if did in demand_ids:
            I(_issue("error", "DUPLICATE_DEMAND_ID", f'Duplicate demand id "{_s(did)}".',
                     "Make demand row ids unique (e.g. dem-{customer}-{sku}).", did))
        demand_ids.add(did)
        if cust_id not in site_ids:
            orphan += 1
            I(_issue("error", "ORPHAN_DEMAND_CUSTOMER", f'Demand "{_s(did)}" customer "{_s(cust_id)}" is not a site.',
                     "Add a demand-kind site with that id, or retarget customerId.", did))
        else:
            cust = site_by_id.get(cust_id)
            if cust is not None and _g(cust, "kind") != "demand":
                I(_issue("warn", "ORPHAN_DEMAND_CUSTOMER",
                         f'Demand "{_s(did)}" customer "{_s(cust_id)}" is kind "{_s(_g(cust, "kind"))}", not demand.',
                         "Point demand at a site with kind=demand.", did))
        if sku_ids and sku_id not in sku_ids:
            orphan += 1
            I(_issue("error", "ORPHAN_DEMAND_SKU", f'Demand "{_s(did)}" SKU "{_s(sku_id)}" is not in skus[].',
                     "Add the SKU to skus[] or fix skuId.", did))
        if not (_num(vol_r) > 0):
            I(_issue("error", "DEMAND_VOLUME_NONPOSITIVE", f'Demand "{_s(did)}" volume must be > 0 (got {_s(vol_r)}).',
                     "Set a positive volume or remove the row.", did))
        else:
            vol_total += _num(vol_r)

    lane_ids: set = set()
    route_modes: dict = {}
    missing_ep = 0
    for lane in lanes:
        lid, frm, to = _g(lane, "id"), _g(lane, "from"), _g(lane, "to")
        if lid in lane_ids:
            I(_issue("error", "DUPLICATE_LANE_ID", f'Duplicate lane id "{_s(lid)}".', "Make lane ids unique.", lid))
        lane_ids.add(lid)
        if frm not in site_ids:
            missing_ep += 1
            I(_issue("error", "LANE_FROM_MISSING", f'Lane "{_s(lid)}" from "{_s(frm)}" is not a site.',
                     "Add the origin site or correct the from id.", lid))
        if to not in site_ids:
            missing_ep += 1
            I(_issue("error", "LANE_TO_MISSING", f'Lane "{_s(lid)}" to "{_s(to)}" is not a site.',
                     "Add the destination site or correct the to id.", lid))
        if _num(_g(lane, "costPerUnit")) < 0:
            I(_issue("error", "LANE_COST_NEGATIVE", f'Lane "{_s(lid)}" costPerUnit is negative.',
                     "Set costPerUnit >= 0 ($/unit).", lid))
        cap_r = _g(lane, "capacity")
        cap = _num(cap_r)
        if not (cap > 0):
            cap_issues += 1
            I(_issue("error", "LANE_CAPACITY_NONPOSITIVE", f'Lane "{_s(lid)}" capacity must be > 0 (got {_s(cap_r)}).',
                     "Set a positive lane capacity (units) or a large planning default.", lid))

        modes = _g(lane, "modes")
        if modes is not UNDEF:
            if not isinstance(modes, list) or len(modes) == 0:
                I(_issue("warn", "LANE_MODE_EMPTY", f'Lane "{_s(lid)}" has an empty modes list.',
                         "Remove modes[] (single-mode lane) or add Truck / Rail / Intermodal options.", lid))
            else:
                seen: set = set()
                cap_sum = 0.0
                all_capped = True
                for m in modes:
                    mv = _g(m, "mode")
                    label = ("" if _nullish(mv) else _s(mv)).strip()
                    key = label.lower()
                    ref = f"{_s(lid)}/{label or '?'}"
                    if not label:
                        I(_issue("error", "LANE_MODE_UNKNOWN", f'Lane "{_s(lid)}" has a mode option without a mode name.',
                                 f"Set mode to one of {', '.join(KNOWN_LANE_MODES)}.", lid))
                    elif not any(k.lower() == key for k in KNOWN_LANE_MODES):
                        I(_issue("warn", "LANE_MODE_UNKNOWN", f'Lane "{_s(lid)}" mode "{label}" is not a known planning mode.',
                                 f"Known modes: {', '.join(KNOWN_LANE_MODES)} (custom modes use Truck CO₂ factors).", ref))
                    if key and key in seen:
                        I(_issue("error", "LANE_MODE_DUPLICATE", f'Lane "{_s(lid)}" lists mode "{label}" more than once.',
                                 "Keep one option per mode per lane (the optimizer uses the first).", ref))
                    if key:
                        seen.add(key)
                    cpu = _g(m, "costPerUnit")
                    if not (_finite(cpu) and cpu >= 0):
                        I(_issue("error", "LANE_MODE_COST_NEGATIVE", f'Lane "{ref}" costPerUnit must be ≥ 0 (got {_s(cpu)}).',
                                 "Set the per-mode $/unit rate.", ref))
                    ld = _g(m, "leadDays")
                    if not (_finite(ld) and ld >= 0):
                        I(_issue("error", "LANE_MODE_LEAD_INVALID", f'Lane "{ref}" leadDays must be a number ≥ 0 (got {_s(ld)}).',
                                 "Set transit days — used against maxLeadTimeDays for hard service.", ref))
                    mc = _g(m, "capacity")
                    if not _nullish(mc):
                        if not (_num(mc) > 0):
                            cap_issues += 1
                            I(_issue("error", "LANE_MODE_CAPACITY_NONPOSITIVE", f'Lane "{ref}" capacity must be > 0 (got {_s(mc)}).',
                                     "Omit capacity for an uncapacitated mode or set a positive limit.", ref))
                        else:
                            cap_sum += _num(mc)
                    else:
                        all_capped = False
                    fcm = _g(m, "fixedCostM")
                    if not _nullish(fcm) and not (_num(fcm) >= 0):
                        I(_issue("error", "LANE_MODE_FIXED_COST_NEGATIVE", f'Lane "{ref}" fixedCostM must be ≥ 0 (got {_s(fcm)}).',
                                 "Fixed activation charge in $M (0 = no charge).", ref))
                    co2 = _g(m, "co2KgPerUnit")
                    if not _nullish(co2) and not (_num(co2) >= 0):
                        I(_issue("error", "LANE_MODE_CO2_NEGATIVE", f'Lane "{ref}" co2KgPerUnit must be ≥ 0 (got {_s(co2)}).',
                                 "kg CO₂ per unit shipped on this mode.", ref))
                if all_capped and cap > 0 and cap_sum < cap:
                    I(_issue("info", "LANE_MODE_CAPACITY_BELOW_LANE",
                             f'Lane "{_s(lid)}" mode capacities sum to {_s(cap_sum)} < lane capacity {_s(cap_r)}; mode caps bind first.',
                             "Effective lane capacity = min(lane capacity, Σ mode capacities).", lid))

        lm = _g(lane, "mode")
        route_key = f"{_s(frm)}→{_s(to)}|{('' if _nullish(lm) else _s(lm)).lower()}"
        if not (isinstance(modes, list) and len(modes) > 0):
            if route_key in route_modes:
                I(_issue("warn", "LANE_ROUTE_DUPLICATE",
                         f'Lanes "{_s(route_modes[route_key])}" and "{_s(lid)}" repeat {_s(frm)}→{_s(to)} with the same mode.',
                         "The optimizer keeps the last row; use distinct modes (they become alternatives) or merge into modes[].", lid))
            else:
                route_modes[route_key] = lid

    bom_ids: set = _IdSet()
    for row in bom:
        rid, par, chi = _g(row, "id"), _g(row, "parentSkuId"), _g(row, "childSkuId")
        if rid in bom_ids:
            I(_issue("error", "DUPLICATE_BOM_ID", f'Duplicate BOM row id "{_s(rid)}".', "Make BOM row ids unique.", rid))
        bom_ids.add(rid)
        if sku_ids and par not in sku_ids:
            I(_issue("error", "BOM_ORPHAN_PARENT", f'BOM "{_s(rid)}" parent SKU "{_s(par)}" missing.',
                     "Add the finished-good SKU or fix parentSkuId.", rid))
        if sku_ids and chi not in sku_ids:
            I(_issue("error", "BOM_ORPHAN_CHILD", f'BOM "{_s(rid)}" child SKU "{_s(chi)}" missing.',
                     "Add the component/RM SKU or fix childSkuId.", rid))
        if not (_num(_g(row, "qtyPerUnit")) > 0):
            I(_issue("error", "BOM_QTY_NONPOSITIVE", f'BOM "{_s(rid)}" qtyPerUnit must be > 0.',
                     "Set qty of child per one parent unit to a positive number.", rid))
        pl, su = _g(row, "plantId"), _g(row, "supplierId")
        if pl and not _nullish(pl) and pl not in site_ids:
            I(_issue("error", "BOM_PLANT_MISSING", f'BOM "{_s(rid)}" plant "{_s(pl)}" is not a site.',
                     "Point plantId at an existing plant site.", rid))
        if su and not _nullish(su) and su not in site_ids:
            I(_issue("error", "BOM_SUPPLIER_MISSING", f'BOM "{_s(rid)}" supplier "{_s(su)}" is not a site.',
                     "Point supplierId at an existing supplier site.", rid))

    cycles = _detect_bom_cycles(bom)
    for cyc in cycles[:5]:
        I(_issue("error", "BOM_CYCLE", f"BOM cycle detected: {' -> '.join(_s(x) for x in cyc)}.",
                 "Break the cycle — a parent cannot eventually require itself as a child."))

    return _scorecard(issues, pack, {
        "geocodeHits": geo_hits, "geocodeTotal": geo_total, "orphanDemandCount": orphan,
        "missingEndpointCount": missing_ep, "capacityIssues": cap_issues,
        "bomCycleDetected": bool(cycles), "demandVolumeTotal": vol_total,
    })


def _scorecard(issues: list, pack: dict | None, extra: dict) -> dict[str, Any]:
    err = sum(1 for i in issues if i["level"] == "error")
    warn = sum(1 for i in issues if i["level"] == "warn")
    info = sum(1 for i in issues if i["level"] == "info")
    gt, gh = extra.get("geocodeTotal", 0), extra.get("geocodeHits", 0)
    cov = 0 if gt == 0 else _jround(gh / gt * 100)
    score = 100 - err * 12 - warn * 3 - max(0, 100 - cov) / 4
    if extra.get("bomCycleDetected"):
        score -= 15
    score = min(100, max(0, _jround(score)))
    p = pack or {}
    sites = p.get("sites") if isinstance(p.get("sites"), list) else []
    lanes = _arr(p.get("lanes"))
    ver = p.get("schemaVersion")
    return {
        "schemaVersion": SCHEMA_VERSION if _nullish(ver) else ver,
        "ok": err == 0 and len(sites) > 0,
        "score": score,
        "errorCount": err,
        "warnCount": warn,
        "infoCount": info,
        "geocodeCoveragePct": cov,
        "siteCount": len(sites),
        "demandRowCount": len(_arr(p.get("demand"))),
        "demandVolumeTotal": _jround(extra.get("demandVolumeTotal", 0)),
        "laneCount": len(lanes),
        "skuCount": len(_arr(p.get("skus"))),
        "bomRowCount": len(_arr(p.get("bom"))),
        "orphanDemandCount": extra.get("orphanDemandCount", 0),
        "missingEndpointCount": extra.get("missingEndpointCount", 0),
        "capacityIssues": extra.get("capacityIssues", 0),
        "bomCycleDetected": extra.get("bomCycleDetected", False),
        "multiModeLaneCount": sum(1 for ln in lanes if isinstance(_g(ln, "modes"), list) and len(ln["modes"]) > 0),
        "laneModeOptionCount": sum(len(ln["modes"]) for ln in lanes if isinstance(_g(ln, "modes"), list)),
        "issues": issues,
    }
