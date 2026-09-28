"""Best-effort infeasibility diagnostics without full IIS (HiGHS/PuLP limited)."""

from __future__ import annotations

from typing import Any


def diagnose_network_conflicts(
    *,
    dem_map: dict[tuple[str, str], float],
    product_ids: list[str],
    product_labels: dict[str, str],
    reachable: dict[tuple[str, str], set[str]],
    openable: list[dict[str, Any]],
    cmap: dict[str, Any],
    fac_by_id: dict[str, Any],
    capable: dict[str, set[str] | None],
    radius: float,
    budget: float,
    max_fac: int,
    hard_service: bool,
    capex_of,
    parse_volume,
) -> dict[str, Any]:
    """
    Structural conflict hints for infeasible (or near-infeasible) MIPs.

    dem_map keys are (customer_id, product_id) -> volume.
    reachable[(cust, prod)] = set of facility ids that can serve that demand.
    capable[fid] = set of product ids or None (= all).
    """
    hints: list[dict[str, Any]] = []
    metrics: dict[str, Any] = {}

    total_demand = sum(dem_map.values())
    metrics["totalDemand"] = round(total_demand, 2)
    metrics["productCount"] = len(product_ids)
    metrics["demandRows"] = len(dem_map)
    metrics["serviceRadiusMiles"] = radius
    metrics["capexBudgetM"] = budget
    metrics["maxFacilities"] = max_fac
    metrics["hardServiceConstraints"] = hard_service

    unreachable: list[dict[str, Any]] = []
    for (cust, prod), vol in dem_map.items():
        servers = reachable.get((cust, prod)) or set()
        if not servers:
            unreachable.append(
                {
                    "customerId": cust,
                    "productId": prod,
                    "volume": round(vol, 2),
                }
            )
    metrics["unreachableDemandRows"] = len(unreachable)
    metrics["unreachableVolume"] = round(sum(u["volume"] for u in unreachable), 2)
    if unreachable:
        sample = unreachable[:8]
        hints.append(
            {
                "code": "UNREACHABLE_DEMAND",
                "severity": "high",
                "message": (
                    f"{len(unreachable)} demand row(s) have no reachable capable "
                    f"server within {radius:.0f} mi"
                    + (" / lead-time limit" if hard_service else "")
                    + f" (vol {metrics['unreachableVolume']:.0f})."
                ),
                "entities": [
                    f"{u['customerId']}/{u['productId']}" for u in sample
                ],
                "hint": (
                    "Widen serviceRadiusMiles / maxLeadTimeDays, open nearer "
                    "candidates, add lanes, or relax facility product capability."
                ),
            }
        )
        if total_demand > 0 and metrics["unreachableVolume"] >= 0.5 * total_demand:
            hints.append(
                {
                    "code": "SERVICE_RADIUS_TOO_TIGHT",
                    "severity": "high",
                    "message": (
                        f"Service radius {radius:.0f} mi leaves "
                        f"{100 * metrics['unreachableVolume'] / total_demand:.0f}% "
                        "of demand unreachable."
                    ),
                    "entities": [],
                    "hint": "Increase serviceRadiusMiles or add regional candidates.",
                }
            )

    openable_caps: list[tuple[str, float, float]] = []
    for f in openable:
        fid = f["id"]
        st = (cmap.get(fid) or {}).get("status")
        if st is None:
            st = "candidate" if f.get("kind") == "candidate" else "open"
        if st == "closed":
            continue
        c = cmap.get(fid) or {}
        cap_max = float(c.get("capacityMax") or parse_volume(f.get("capacity"), 1e9))
        cx = float(capex_of(fid))
        openable_caps.append((fid, cap_max, cx))

    total_openable_cap = sum(c for _, c, _ in openable_caps)
    metrics["openableCapacity"] = round(total_openable_cap, 2)
    metrics["openableFacilityCount"] = len(openable_caps)

    forced = [(fid, cap, cx) for fid, cap, cx in openable_caps if cx <= 1e-9]
    candidates = [(fid, cap, cx) for fid, cap, cx in openable_caps if cx > 1e-9]
    est_cap = sum(c for _, c, _ in forced)
    forced_count = sum(
        1
        for fid, _, _ in forced
        if (fac_by_id.get(fid) or {}).get("kind") in ("dc", "candidate")
    )
    est_n = 0
    est_spent = 0.0
    for fid, cap, cx in sorted(candidates, key=lambda t: -t[1]):
        kind = (fac_by_id.get(fid) or {}).get("kind")
        counts = kind in ("dc", "candidate")
        if counts and forced_count + est_n >= max_fac:
            continue
        if est_spent + cx > budget + 1e-9:
            continue
        est_cap += cap
        est_spent += cx
        if counts:
            est_n += 1
    metrics["estimatedFeasibleCapacity"] = round(est_cap, 2)
    metrics["estimatedOpenCount"] = forced_count + est_n

    reachable_vol = total_demand - metrics["unreachableVolume"]
    if est_cap + 1e-6 < reachable_vol and reachable_vol > 0:
        hints.append(
            {
                "code": "CAPACITY_SHORTFALL",
                "severity": "high",
                "message": (
                    f"Under CapEx ${budget:.0f}M / max {max_fac} facilities, "
                    f"estimated capacity {est_cap:.0f} < reachable demand "
                    f"{reachable_vol:.0f}."
                ),
                "entities": [fid for fid, _, _ in (forced + candidates)[:6]],
                "hint": (
                    "Raise capexBudgetM / maxFacilities / capacityMax, or "
                    "lower demand / allow more candidates."
                ),
            }
        )

    for prod in product_ids:
        dem_p = sum(v for (c, p), v in dem_map.items() if p == prod)
        if dem_p <= 0:
            continue
        cap_p = 0.0
        capable_facs: list[str] = []
        for fid, cap, _cx in openable_caps:
            able = capable.get(fid)
            if able is not None and prod not in able:
                continue
            cap_p += cap
            capable_facs.append(fid)
        if not capable_facs:
            hints.append(
                {
                    "code": "NO_CAPABLE_FACILITY",
                    "severity": "high",
                    "message": (
                        f"Product '{product_labels.get(prod, prod)}' demand "
                        f"{dem_p:.0f} has no capable openable facility."
                    ),
                    "entities": [prod],
                    "hint": "Add capableProductIds on DCs/plants for this product/group.",
                }
            )
        elif cap_p + 1e-6 < dem_p:
            hints.append(
                {
                    "code": "PRODUCT_CAPACITY_SHORTFALL",
                    "severity": "medium",
                    "message": (
                        f"Product '{product_labels.get(prod, prod)}': capable "
                        f"capacity {cap_p:.0f} < demand {dem_p:.0f}."
                    ),
                    "entities": capable_facs[:6],
                    "hint": "Expand capacityByProduct / capacityMax for capable sites.",
                }
            )

    if hard_service and not hints:
        hints.append(
            {
                "code": "HARD_SERVICE_INFEASIBLE",
                "severity": "medium",
                "message": (
                    "Hard service constraints made the MIP infeasible "
                    "(no uncovered demand allowed)."
                ),
                "entities": [],
                "hint": (
                    "Set hardServiceConstraints=false for soft uncovered "
                    "penalty, or loosen radius / capacity / budget."
                ),
            }
        )

    seen: set[str] = set()
    uniq: list[dict[str, Any]] = []
    for h in hints:
        if h["code"] in seen:
            continue
        seen.add(h["code"])
        uniq.append(h)

    summary = (
        "; ".join(h["message"] for h in uniq[:3])
        if uniq
        else "Solver reported Infeasible; no structural conflict isolated."
    )

    return {
        "status": "Infeasible",
        "summary": summary,
        "hints": uniq,
        "metrics": metrics,
        "method": "structural-best-effort",
        "note": (
            "Best-effort conflict hints without full IIS "
            "(HiGHS/PuLP do not expose a portable IIS API here)."
        ),
    }
