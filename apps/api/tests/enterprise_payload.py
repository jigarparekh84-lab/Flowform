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
    for row in pack.get("demand") or []:
        cid = row["customerId"]
        demand_volume[cid] = demand_volume.get(cid, 0.0) + float(row.get("volume") or 0)

    lanes: list[dict[str, Any]] = []
    for i, lane in enumerate(pack.get("lanes") or []):
        lanes.append(
            {
                "id": lane.get("id") or f"l{i}",
                "from": lane["from"],
                "to": lane["to"],
                "mode": lane.get("mode") or "Truck",
                "costPerUnit": float(lane.get("costPerUnit") or 1.0),
                "leadDays": int(lane.get("leadDays") or 2),
                "co2Kg": float(lane.get("co2Kg") or 10),
                "capacityUnits": lane.get("capacity"),
            }
        )

    facilities: list[dict[str, Any]] = []
    for s in sites:
        if s.get("kind") not in ("dc", "plant", "candidate"):
            continue
        status = s.get("status") or (
            "candidate" if s.get("kind") == "candidate" else "open"
        )
        facilities.append(
            {
                "nodeId": s["id"],
                "status": status,
                "capacityMin": float(s.get("capacityMin") or 0),
                "capacityMax": float(s.get("capacityMax") or 25000),
                "fixedCapexM": float(s.get("fixedCostM") or 0),
                "fixedOpexM": float(s.get("fixedOpexM") or 0.7),
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

    return {
        "network": {
            "nodes": nodes,
            "lanes": lanes,
            "demandVolume": demand_volume,
            "bomDemand": bom_demand or None,
        },
        "constraints": {
            "serviceTargetPct": float(g.get("serviceTargetPct") or 95),
            "serviceRadiusMiles": float(g.get("serviceRadiusMiles") or 800),
            "capexBudgetM": float(g.get("capexBudgetM") or 40),
            "maxFacilities": int(g.get("maxFacilities") or 12),
            "facilities": facilities,
        },
        "bom": {"rows": bom_rows} if bom_rows else {},
        "enterpriseSchemaVersion": pack.get("schemaVersion") or "enterprise-data-v1",
    }
