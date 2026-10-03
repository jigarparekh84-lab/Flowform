"""Convert flowform-enterprise-pack JSON into MIP optimize payloads."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

FIXTURES = Path(__file__).resolve().parent / "fixtures"


def load_enterprise_pack(name: str) -> dict[str, Any]:
    path = FIXTURES / name
    if not path.exists():
        # Fall back to web public samples (monorepo)
        alt = (
            Path(__file__).resolve().parents[3]
            / "apps"
            / "web"
            / "public"
            / "samples"
            / name
        )
        path = alt
    with path.open() as f:
        return json.load(f)


def pack_to_optimize_payload(pack: dict[str, Any]) -> dict[str, Any]:
    sites = pack.get("sites") or []
    nodes: list[dict[str, Any]] = []
    for s in sites:
        cap = s.get("capacityMax") or 10000
        nodes.append(
            {
                "id": s["id"],
                "name": s.get("name", s["id"]),
                "kind": s["kind"],
                "x": 50,
                "y": 50,
                "lat": s.get("lat"),
                "lng": s.get("lng"),
                "capacity": f"{int(cap)}",
                "region": s.get("region", "NA"),
            }
        )

    demand_volume: dict[str, float] = {}
    demand_by_product: list[dict[str, Any]] = []
    for row in pack.get("demand") or []:
        cid = row["customerId"]
        vol = float(row.get("volume") or 0)
        demand_volume[cid] = demand_volume.get(cid, 0.0) + vol
        sku = row.get("skuId") or row.get("productId")
        if sku and vol > 0:
            demand_by_product.append(
                {
                    "customerId": cid,
                    "productId": str(sku),
                    "skuId": str(sku),
                    "volume": vol,
                }
            )

    lanes: list[dict[str, Any]] = []
    for i, lane in enumerate(pack.get("lanes") or []):
        row: dict[str, Any] = {
            "id": lane.get("id") or f"l{i}",
            "from": lane["from"],
            "to": lane["to"],
            "mode": lane.get("mode") or "Truck",
            "costPerUnit": float(lane.get("costPerUnit") or 1.0),
            "leadDays": int(lane.get("leadDays") or 2),
            "co2Kg": float(lane.get("co2Kg") or 10),
            "capacityUnits": lane.get("capacity"),
        }
        # Depth 7: per-lane transport mode options (enterprise-data-v1 lanes[].modes)
        if lane.get("modes"):
            row["modes"] = [dict(m) for m in lane["modes"]]
        lanes.append(row)

    skus = list(pack.get("skus") or [])
    product_groups = list(pack.get("productGroups") or [])
    group_ids = {str(g["id"]) for g in product_groups}

    facilities: list[dict[str, Any]] = []
    facility_products: list[dict[str, Any]] = []
    for s in sites:
        if s.get("kind") not in ("dc", "plant", "candidate"):
            continue
        status = s.get("status") or (
            "candidate" if s.get("kind") == "candidate" else "open"
        )
        capable = s.get("capableProductIds") or s.get("capableGroupIds")
        # Default: all product groups (or all SKUs) when pack has multi-SKU
        if not capable and group_ids:
            capable = sorted(group_ids)
        elif not capable and skus:
            capable = [str(x["id"]) for x in skus if x.get("groupId") or True]
        fac: dict[str, Any] = {
            "nodeId": s["id"],
            "status": status,
            "capacityMin": float(s.get("capacityMin") or 0),
            "capacityMax": float(s.get("capacityMax") or 25000),
            "fixedCapexM": float(s.get("fixedCostM") or 0),
            "fixedOpexM": float(s.get("fixedOpexM") or 0.7),
        }
        if capable:
            fac["capableProductIds"] = list(capable)
        if s.get("capacityByProduct"):
            fac["capacityByProduct"] = dict(s["capacityByProduct"])
        facilities.append(fac)
        if capable:
            facility_products.append(
                {
                    "nodeId": s["id"],
                    "capableProductIds": list(capable),
                    "capacityByProduct": dict(s.get("capacityByProduct") or {}),
                }
            )

    g = pack.get("globals") or {}
    bom_rows = []
    bom_demand = []
    for b in pack.get("bom") or []:
        plant_id = b.get("plantId")
        supplier_id = b.get("supplierId")
        qty = float(b.get("qtyPerUnit") or 1.0)
        if plant_id:
            bom_rows.append(
                {
                    "plantId": plant_id,
                    "preferredSupplierId": supplier_id,
                    "qtyPerUnit": qty,
                }
            )
        if plant_id and supplier_id:
            bom_demand.append(
                {
                    "supplierId": supplier_id,
                    "plantId": plant_id,
                    "qtyPerUnit": qty,
                }
            )

    constraints: dict[str, Any] = {
        "serviceTargetPct": float(g.get("serviceTargetPct") or 95),
        "serviceRadiusMiles": float(g.get("serviceRadiusMiles") or 800),
        "capexBudgetM": float(g.get("capexBudgetM") or 40),
        "maxFacilities": int(g.get("maxFacilities") or 12),
        "facilities": facilities,
        "aggregateProductsByGroup": g.get("aggregateProductsByGroup", "auto"),
        "maxProductCommodities": int(g.get("maxProductCommodities") or 8),
        "hardServiceConstraints": bool(g.get("hardServiceConstraints", False)),
    }
    if g.get("maxLeadTimeDays") is not None:
        constraints["maxLeadTimeDays"] = float(g["maxLeadTimeDays"])
    if facility_products:
        constraints["facilityProducts"] = facility_products

    return {
        "network": {
            "nodes": nodes,
            "lanes": lanes,
            "demandVolume": demand_volume,
            "demandByProduct": demand_by_product or None,
            "skus": skus or None,
            "productGroups": product_groups or None,
            "bomDemand": bom_demand or None,
        },
        "constraints": constraints,
        "bom": {"rows": bom_rows} if bom_rows else {},
        "enterpriseSchemaVersion": pack.get("schemaVersion") or "enterprise-data-v1",
    }
