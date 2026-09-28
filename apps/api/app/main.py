"""Flowform optimize API — FastAPI on port 5182."""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .multi_period import solve_multi_period
from .solver import solve_optimize

app = FastAPI(
    title="Flowform Optimize API",
    description=(
        "Fixed-charge multi-echelon MIP (PuLP + HiGHS/CBC): "
        "open/close DCs & plants, capacitated flows plant→DC→customer, "
        "optional supplier→plant BOM, multi-SKU/product-group flows, hard service constraints, "
        "infeasibility diagnostics, objective breakdown + capacity duals. "
        "Multi-period CapEx NPV: POST /optimize/multi-period."
    ),
    version="0.4.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5180",
        "http://127.0.0.1:5180",
        "http://localhost:5181",
        "http://127.0.0.1:5181",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class FacilityConstraintIn(BaseModel):
    nodeId: str
    status: str | None = None
    capacityMin: float | None = 0
    capacityMax: float | None = None
    fixedCapexM: float | None = None
    fixedOpexM: float | None = None
    capableProductIds: list[str] | None = None
    capableGroupIds: list[str] | None = None
    capacityByProduct: dict[str, float] | None = None


class BomRowIn(BaseModel):
    plantId: str | None = None
    preferredSupplierId: str | None = None
    supplierId: str | None = None
    qtyPerUnit: float | None = 1.0
    finishedGoodId: str | None = None
    componentId: str | None = None


class BomIn(BaseModel):
    rows: list[BomRowIn] | list[dict[str, Any]] = Field(default_factory=list)


class BomDemandIn(BaseModel):
    supplierId: str | None = None
    plantId: str | None = None
    qtyPerUnit: float | None = 1.0
    volumePerFg: float | None = None
    from_: str | None = Field(default=None, alias="from")
    to: str | None = None

    model_config = {"populate_by_name": True}


class CapexRoadmapEventIn(BaseModel):
    id: str | None = None
    name: str | None = None
    kind: str = "open"
    year: int = 0
    nodeId: str
    nodeName: str | None = None
    capexM: float = 0
    capacityDelta: float = 0
    facilityKind: str | None = "dc"
    earliestYear: int | None = None
    latestYear: int | None = None
    fixedYear: int | None = None
    locked: bool | None = None
    region: str | None = None
    notes: str | None = None


class CapexRoadmapIn(BaseModel):
    baseYearLabel: str | None = "FY26"
    yearCount: int = 3
    discountRate: float = 0.10
    mode: str = Field(
        default="choose_timing",
        description="choose_timing | force_timeline",
    )
    events: list[CapexRoadmapEventIn] | list[dict[str, Any]] = Field(
        default_factory=list
    )
    demandScaleByYear: list[float] | None = None
    demandGrowthPct: float | None = None
    hardServiceConstraints: bool | None = None
    capexBudgetTotalM: float | None = None
    enforceCapexBudget: bool | None = True


class OptimizeRequest(BaseModel):
    network: dict[str, Any] = Field(
        ...,
        description=(
            "nodes, lanes, demandVolume; optional demandByProduct, skus, "
            "productGroups, bomDemand, facilityProducts"
        ),
    )
    constraints: dict[str, Any] = Field(
        ...,
        description=(
            "globals (serviceRadiusMiles, capexBudgetM, maxFacilities, "
            "serviceTargetPct, hardServiceConstraints, maxLeadTimeDays, "
            "aggregateProductsByGroup, maxProductCommodities, "
            "optimizePlants, forceOpenSeed) "
            "+ facilities[] with capacity/fixedCapexM/capableProductIds"
        ),
    )
    reference: dict[str, Any] | None = Field(
        default=None, description="Optional reference scenario for KPI deltas"
    )
    bom: BomIn | dict[str, Any] | None = Field(
        default=None,
        description="Optional BOM rows (supplier→plant) for multi-echelon inbound",
    )
    bomDemand: list[dict[str, Any]] | None = Field(
        default=None,
        description="Optional explicit supplier→plant BOM arcs",
    )
    enterpriseSchemaVersion: str | None = Field(
        default=None,
        description="Client enterprise pack schema id (e.g. enterprise-data-v1)",
    )


class MultiPeriodOptimizeRequest(OptimizeRequest):
    roadmap: CapexRoadmapIn | dict[str, Any] = Field(
        ...,
        description=(
            "CapEx roadmap: events (open/expand/close), yearCount, discountRate, "
            "mode choose_timing|force_timeline"
        ),
    )


@app.get("/health")
def health() -> dict[str, str]:
    return {
        "status": "ok",
        "service": "flowform-api",
        "model": "fixed-charge-multi-echelon-v1+multi-period-capex-npv-v1",
    }


@app.post("/optimize")
def optimize(body: OptimizeRequest) -> dict[str, Any]:
    try:
        return solve_optimize(
            {
                "network": body.network,
                "constraints": body.constraints,
                "reference": body.reference or {},
                "bom": body.bom if isinstance(body.bom, dict) else (
                    body.bom.model_dump() if body.bom else {}
                ),
                "bomDemand": body.bomDemand or body.network.get("bomDemand") or [],
                "enterpriseSchemaVersion": body.enterpriseSchemaVersion,
            }
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Optimize failed: {e}") from e


@app.post("/optimize/multi-period")
def optimize_multi_period(body: MultiPeriodOptimizeRequest) -> dict[str, Any]:
    try:
        roadmap = (
            body.roadmap
            if isinstance(body.roadmap, dict)
            else body.roadmap.model_dump()
        )
        return solve_multi_period(
            {
                "network": body.network,
                "constraints": body.constraints,
                "reference": body.reference or {},
                "bom": body.bom if isinstance(body.bom, dict) else (
                    body.bom.model_dump() if body.bom else {}
                ),
                "bomDemand": body.bomDemand or body.network.get("bomDemand") or [],
                "enterpriseSchemaVersion": body.enterpriseSchemaVersion,
                "roadmap": roadmap,
            }
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    except Exception as e:  # noqa: BLE001
        raise HTTPException(
            status_code=500, detail=f"Multi-period optimize failed: {e}"
        ) from e
