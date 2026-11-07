"""Flowform optimize API — FastAPI on port 5182."""

from __future__ import annotations

import logging
import os
import threading
from contextlib import asynccontextmanager, contextmanager
from typing import Any, AsyncIterator, Iterator

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from flowform_engine import solve_multi_period, solve_optimize, solve_stochastic, validate_optimize
from .health import router as health_router
from .metrics import AVAILABLE as METRICS_AVAILABLE, router as metrics_router
from .observability import (
    RequestContextMiddleware,
    configure_logging,
    init_sentry,
    init_tracing,
    shutdown_tracing,
)
from .v1.auth import warn_dev_auth
from .v1.projects import router as projects_router
from .v1.runs import router as runs_router
from .v1.workos import router as auth_router
from .v1.scenarios import router as scenarios_router
from .jobs.reaper import start_background_reaper

log = logging.getLogger("flowform.api")
# CR-006: request ids in every log line, then the error reporter (which must be
# initialised before the app is constructed so its ASGI middleware is installed).
configure_logging()
_SENTRY_ENABLED = init_sentry()
# CR-012: the dev bypass can only serve loopback clients, but it still deserves a
# startup warning whenever it is on at all.
warn_dev_auth(log)

#: Solve endpoints are expensive and unauthenticated in the current deployment
#: mode, so at most this many MIPs run at once per worker process. Extra
#: requests wait briefly, then get 429 instead of queueing behind each other
#: and starving the thread pool.
MAX_CONCURRENT_SOLVES = max(1, int(os.environ.get("MAX_CONCURRENT_SOLVES", "2")))
SOLVE_QUEUE_WAIT_S = max(0.0, float(os.environ.get("SOLVE_QUEUE_WAIT_S", "5")))
_SOLVE_SLOTS = threading.BoundedSemaphore(MAX_CONCURRENT_SOLVES)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Recover runs orphaned by a crashed process (CR-004).

    The reaper is a daemon thread with its own DB sessions; a database outage
    at boot is logged and retried, never fatal to the API itself.
    """
    stop = start_background_reaper()
    try:
        yield
    finally:
        if stop is not None:
            stop.set()
        shutdown_tracing()


app = FastAPI(
    lifespan=lifespan,
    title="Flowform Optimize API",
    description=(
        "Fixed-charge multi-echelon MIP (PuLP + HiGHS/CBC): "
        "open/close DCs & plants, capacitated flows plant→DC→customer, "
        "optional supplier→plant BOM, multi-SKU/product-group flows, hard service constraints, "
        "infeasibility diagnostics, objective breakdown + capacity duals. "
        "Lane transport mode choice (truck / rail / intermodal: $/unit, transit, CO2, "
        "capacity, fixed charge) with lane + lane-mode capacity and LP duals. "
        "Multi-period CapEx NPV: POST /optimize/multi-period. Stochastic scenario-tree / robust: POST /optimize/stochastic. "
        "Explain cards (why each site is open/closed, real HiGHS facility duals, "
        "counterfactual flip cost): POST /optimize with explain=true or POST /optimize/explain."
    ),
    version="0.7.0",
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
    # Let the browser read the support id off an error response (CR-006).
    expose_headers=["X-Request-ID"],
)

# Outermost middleware: every response (including 401/500 and CORS preflight)
# carries X-Request-ID, and logs inside the request carry the same id.
app.add_middleware(RequestContextMiddleware)

# Health probes (CR-006): /livez is dependency-free, /readyz checks DB + queue.
app.include_router(health_router)
# Prometheus scrape (CR-006). Aggregates only: no tenant, user or run ids.
app.include_router(metrics_router)

# Server persistence (FF-104); DB is only touched when /v1 is called.
app.include_router(projects_router)
app.include_router(scenarios_router)
app.include_router(runs_router)
app.include_router(auth_router)

_TRACING_ENABLED = init_tracing(app)
log.info(
    "observability ready: request_ids=on sentry=%s tracing=%s metrics=%s",
    _SENTRY_ENABLED, _TRACING_ENABLED, METRICS_AVAILABLE,
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
    rows: list[BomRowIn | dict[str, Any]] = Field(default_factory=list)


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
    events: list[CapexRoadmapEventIn | dict[str, Any]] = Field(
        default_factory=list
    )
    demandScaleByYear: list[float] | None = None
    demandGrowthPct: float | None = None
    hardServiceConstraints: bool | None = None
    capexBudgetTotalM: float | None = None
    enforceCapexBudget: bool | None = True
    basis: str | None = Field(
        default="run",
        description='"run" (default: every period is the Run MIP) | "legacy-aggregate"',
    )
    compareRun: bool | None = Field(
        default=False, description="Also solve Run and report Y0 vs Run (runCheck)."
    )
    mipGapRel: float | None = Field(
        default=None,
        description="Relative MIP gap (default 1e-4; 2e-3 for models > 2,000 vars).",
    )
    timeLimitSec: float | None = None


class OptimizeRequest(BaseModel):
    network: dict[str, Any] = Field(
        ...,
        description=(
            "nodes, lanes, demandVolume; optional demandByProduct, skus, "
            "productGroups, bomDemand, facilityProducts. skus[] / productGroups[] "
            "may carry unitWeightKg (CO2 = tonne-miles x mode factor). lanes[] may carry "
            "capacity/capacityUnits and modes[] = {mode, costPerUnit, leadDays, "
            "co2KgPerUnit, capacity, fixedCostM}"
        ),
    )
    constraints: dict[str, Any] = Field(
        ...,
        description=(
            "globals (serviceRadiusMiles, capexBudgetM, maxFacilities, "
            "serviceTargetPct, hardServiceConstraints, maxLeadTimeDays, "
            "aggregateProductsByGroup, maxProductCommodities, "
            "optimizePlants, forceOpenSeed, enforceLaneCapacity, "
            "carbonPricePerTonne, defaultUnitWeightKg (kg/unit, default 20), "
            "co2WeightBasis ('unit-weight' | 'legacy-1t'), tonsPerUnit (legacy), "
            "emissionKgPerTonMileByMode) "
            "+ facilities[] with capacity/fixedCapexM/capableProductIds"
        ),
    )
    reference: dict[str, Any] | None = Field(
        default=None, description="Optional reference scenario for KPI deltas"
    )
    computeBaseline: bool = Field(
        default=False,
        description="Also cost the current network as-is (existing open, candidates closed) → response.baseline",
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
    explain: bool | dict[str, Any] | None = Field(
        default=None,
        description=(
            "Depth 8: when true, adds an `explain` block — per-facility "
            "open/close rationale, cost-to-serve, capacity dual and "
            "counterfactual re-solve (facility forced to the opposite state). "
            "May be an object with maxCounterfactuals / timeLimitSec / budgetSec."
        ),
    )
    explainOptions: dict[str, Any] | None = Field(
        default=None,
        description="maxCounterfactuals (default 12), timeLimitSec, budgetSec (60), topDecisions (6)",
    )




class StochasticScenarioIn(BaseModel):
    id: str | None = None
    name: str | None = None
    probability: float = 1.0
    demandScale: float | None = 1.0
    costScale: float | None = 1.0
    demandVolume: dict[str, float] | None = None


class ScenarioTreeIn(BaseModel):
    objective: str = Field(
        default="expected",
        description="expected | minimax | cvar_lite",
    )
    cvarAlpha: float | None = Field(
        default=0.3,
        description="Weight on worst-case for cvar_lite (0–1)",
    )
    computeEvpi: bool | None = True
    scenarios: list[StochasticScenarioIn | dict[str, Any]] = Field(
        default_factory=list
    )


class StochasticOptimizeRequest(OptimizeRequest):
    scenarioTree: ScenarioTreeIn | dict[str, Any] | None = Field(
        default=None,
        description="2–5 demand/cost scenarios with probabilities + objective",
    )
    scenarios: list[StochasticScenarioIn] | list[dict[str, Any]] | None = Field(
        default=None,
        description="Shorthand: scenario list (objective via body.objective)",
    )
    objective: str | None = Field(
        default=None,
        description="expected | minimax | cvar_lite (when using scenarios shorthand)",
    )
    cvarAlpha: float | None = None
    computeEvpi: bool | None = True


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
        "model": "fixed-charge-multi-echelon-v1+multi-period-run-basis-v2+stochastic-scenario-tree-v1+explain-v1",
    }


def _optimize_payload(body: OptimizeRequest, force_explain: bool = False) -> dict[str, Any]:
    explain: Any = body.explain
    if force_explain and not explain:
        explain = True
    return {
        "network": body.network,
        "constraints": body.constraints,
        "reference": body.reference or {},
        "bom": body.bom if isinstance(body.bom, dict) else (
            body.bom.model_dump() if body.bom else {}
        ),
        "bomDemand": body.bomDemand or body.network.get("bomDemand") or [],
        "enterpriseSchemaVersion": body.enterpriseSchemaVersion,
        "explain": explain,
        "explainOptions": body.explainOptions,
        "computeBaseline": bool(getattr(body, "computeBaseline", False)),
    }


@contextmanager
def _solve_slot() -> Iterator[None]:
    """Reserve one of this worker's solve slots, or fail fast with 429."""
    if not _SOLVE_SLOTS.acquire(timeout=SOLVE_QUEUE_WAIT_S):
        raise HTTPException(
            status_code=429,
            detail="Too many concurrent solves on this worker; retry shortly.",
            headers={"Retry-After": "2"},
        )
    try:
        yield
    finally:
        _SOLVE_SLOTS.release()


def _run_solve(fn: Any, payload: dict[str, Any], label: str) -> dict[str, Any]:
    """Run one solve with slot limiting and a single error mapping.

    User-fixable problems (bad or oversized payload) are 400s; solver limits are
    503s; anything else is logged server-side and reported generically so
    internals never reach the response body.
    """
    with _solve_slot():
        try:
            return fn(payload)
        except HTTPException:
            raise
        except ValueError as e:  # includes PayloadTooLarge from the engine guards
            raise HTTPException(status_code=400, detail=str(e)) from e
        except RuntimeError as e:
            raise HTTPException(status_code=503, detail=str(e)) from e
        except Exception:  # noqa: BLE001
            log.exception("%s failed", label)
            raise HTTPException(
                status_code=500,
                detail=f"{label} failed; the error was logged on the server.",
            ) from None


@app.post("/optimize/explain")
def optimize_explain(body: OptimizeRequest) -> dict[str, Any]:
    """Optimize + explain block (same response as /optimize with explain=true)."""
    return _run_solve(
        solve_optimize, _optimize_payload(body, force_explain=True), "Explain"
    )


@app.post("/optimize")
def optimize(body: OptimizeRequest) -> dict[str, Any]:
    return _run_solve(solve_optimize, _optimize_payload(body), "Optimize")


@app.post("/optimize/validate")
def optimize_validate(body: OptimizeRequest, deep: bool = False) -> dict[str, Any]:
    """Pre-run guardrails (FF-108): blocking errors + warnings + shortfall tables.
    ``?deep=true`` also runs the solve and reports Infeasible root causes."""
    payload = _optimize_payload(body)
    if not deep:
        return validate_optimize(payload, deep=False)
    return _run_solve(
        lambda p: validate_optimize(p, deep=True), payload, "Deep validation"
    )


def multi_period_payload(body: "MultiPeriodOptimizeRequest") -> dict[str, Any]:
    roadmap = (
        body.roadmap
        if isinstance(body.roadmap, dict)
        else body.roadmap.model_dump()
    )
    payload = (
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
    return payload


def stochastic_payload(body: "StochasticOptimizeRequest") -> dict[str, Any]:
    tree: dict[str, Any]
    if body.scenarioTree is not None:
        tree = (
            body.scenarioTree
            if isinstance(body.scenarioTree, dict)
            else body.scenarioTree.model_dump()
        )
    else:
        scenarios = body.scenarios or []
        tree = {
            "scenarios": [
                s if isinstance(s, dict) else s.model_dump() for s in scenarios
            ],
            "objective": body.objective or "expected",
            "cvarAlpha": body.cvarAlpha,
            "computeEvpi": body.computeEvpi if body.computeEvpi is not None else True,
        }
    if body.objective and not tree.get("objective"):
        tree["objective"] = body.objective
    payload = (
        {
            "network": body.network,
            "constraints": body.constraints,
            "reference": body.reference or {},
            "bom": body.bom if isinstance(body.bom, dict) else (
                body.bom.model_dump() if body.bom else {}
            ),
            "bomDemand": body.bomDemand or body.network.get("bomDemand") or [],
            "enterpriseSchemaVersion": body.enterpriseSchemaVersion,
            "scenarioTree": tree,
            "objective": tree.get("objective") or body.objective or "expected",
            "cvarAlpha": tree.get("cvarAlpha", body.cvarAlpha),
            "computeEvpi": tree.get("computeEvpi", body.computeEvpi),
        }
    )
    return payload


@app.post("/optimize/multi-period")
def optimize_multi_period(body: MultiPeriodOptimizeRequest) -> dict[str, Any]:
    return _run_solve(
        solve_multi_period, multi_period_payload(body), "Multi-period optimize"
    )


@app.post("/optimize/stochastic")
def optimize_stochastic(body: StochasticOptimizeRequest) -> dict[str, Any]:
    return _run_solve(
        solve_stochastic, stochastic_payload(body), "Stochastic optimize"
    )
