# Flowform Optimize API

Fixed-charge **multi-echelon MIP** (PuLP + HiGHS preferred, CBC fallback):

- Open/close DCs (and optional plants) with fixed CapEx + OpEx
- Capacitated facilities; optional minimum throughput when open
- Flow conservation **plant → DC → customer** (and **supplier → plant** when BOM present)
- Variable transport cost on lanes (or distance proxy)
- Returns objective breakdown, open facilities, flows (with echelon), capacity shadow prices / duals

- Default port: **5182**
- CORS: `http://localhost:5180` (Flowform web)
- Endpoints: `POST /optimize`, `POST /optimize/multi-period`, `POST /optimize/stochastic`

## Setup

Requires Python 3.10+ (3.11–3.14 tested).

```bash
cd /Users/jigar/Projects/Flowform/apps/api
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

`highspy` provides the HiGHS solver; PuLP also ships CBC as a fallback.

## Run

```bash
cd /Users/jigar/Projects/Flowform/apps/api
source .venv/bin/activate
uvicorn app.main:app --reload --host 127.0.0.1 --port 5182
```

Health check: http://127.0.0.1:5182/health

## `POST /optimize`

Request body (JSON):

```json
{
  "network": {
    "nodes": [
      { "id": "n1", "name": "Plant", "kind": "plant", "x": 30, "y": 50, "capacity": "30k" },
      { "id": "n2", "name": "DC", "kind": "dc", "x": 55, "y": 50, "capacity": "20k" },
      { "id": "n4", "name": "Demand", "kind": "demand", "x": 70, "y": 50, "capacity": "5k" }
    ],
    "lanes": [
      { "id": "l1", "from": "n1", "to": "n2", "mode": "Rail", "costPerUnit": 0.64, "leadDays": 5, "co2Kg": 9 }
    ],
    "demandVolume": { "n4": 5000 }
  },
  "constraints": {
    "serviceTargetPct": 95,
    "serviceRadiusMiles": 250,
    "capexBudgetM": 30,
    "maxFacilities": 6,
    "optimizePlants": false,
    "forceOpenSeed": false,
    "facilities": [
      { "nodeId": "n1", "status": "open", "capacityMin": 0, "capacityMax": 30000, "fixedCapexM": 0, "fixedOpexM": 1.2 },
      { "nodeId": "n2", "status": "open", "capacityMin": 0, "capacityMax": 20000, "fixedCapexM": 4, "fixedOpexM": 0.7 }
    ]
  },
  "bom": {
    "rows": [{ "plantId": "n1", "preferredSupplierId": "n7", "qtyPerUnit": 1.2 }]
  },
  "reference": {
    "id": "baseline",
    "kpis": { "cost": { "value": "$48.2M" }, "co2": { "value": "12.4 kt" } }
  }
}
```

Response includes:

| Field | Description |
|-------|-------------|
| `openIds` / `openedIds` / `closedIds` / `keptOpenIds` | Facility decisions |
| `openFacilities` | Throughput, util %, CapEx/OpEx per open site |
| `flows` | Multi-echelon arcs (`echelon`: plant→dc, dc→customer, supplier→plant, …) |
| `objectiveBreakdown` | transportM, fixedCapexM, fixedOpexM, uncoveredPenaltyM, totalM |
| `shadowPrices` | Capacity duals (LP with binaries fixed) or reduced-cost proxy |
| `kpis` | servicePct, capexUsedM, opexUsedM, transportCostM, costM, … |
| `solver` / `model` / `log` | `pulp-highs` / `fixed-charge-multi-echelon-v1` |

## Tests

```bash
cd /Users/jigar/Projects/Flowform/apps/api
source .venv/bin/activate
pytest -q
```

## Web client

The Flowform web app (`apps/web`) calls this API from **Run** when reachable (`VITE_API_URL`, default `http://127.0.0.1:5182`), passing network + constraints + BOM. Compare / Brief show the objective breakdown. If the API is down, Run falls back to the client heuristic v1.


## Stress benchmarks

```bash
pytest -q tests/test_stress_benchmark.py -s
```

Loads `tests/fixtures/stress-{120,200}-demand.enterprise.json`, times `solve_optimize`, and asserts:

| Check | Threshold |
|-------|-----------|
| Status | Optimal (or service ≥ 90%) |
| Open facilities | ≥ 1 |
| `solveSeconds` | ≤ 60s |
| Model | `fixed-charge-multi-echelon-v1` |

Response includes `solveSeconds`, `objectiveBreakdown`, `openIds`, and multi-echelon `flows` used by Compare CTS.

## Depth slice 4

- **Multi-SKU / product-group flows** — `network.demandByProduct` + `skus` / `productGroups`; auto-aggregates to groups when commodity count exceeds `maxProductCommodities` (default 8). Facility `capableProductIds` / `capacityByProduct`. Response `productBreakdown` + flow `productId`.
- **Hard service** — `constraints.hardServiceConstraints=true` forbids uncovered demand; optional `maxLeadTimeDays`. Soft mode keeps uncovered penalty.
- **Infeasibility diagnostics** — on `status: Infeasible`, `infeasibilityReport` with best-effort hints (`UNREACHABLE_DEMAND`, `SERVICE_RADIUS_TOO_TIGHT`, `CAPACITY_SHORTFALL`, …) without full IIS.

## Depth slice 5 — Multi-period CapEx NPV

`POST /optimize/multi-period` accepts the same network/constraints as `/optimize` plus a `roadmap`:

```json
{
  "roadmap": {
    "baseYearLabel": "FY26",
    "yearCount": 3,
    "discountRate": 0.10,
    "mode": "choose_timing",
    "demandScaleByYear": [1.0, 1.1, 1.2],
    "events": [
      {
        "id": "ev-open-east",
        "kind": "open",
        "year": 1,
        "nodeId": "dc_e",
        "capexM": 8,
        "capacityDelta": 10000,
        "earliestYear": 0,
        "latestYear": 2
      }
    ]
  }
}
```

| Mode | Behavior |
|------|----------|
| `choose_timing` | Choose year for each event in `[earliestYear, latestYear]` to minimize NPV |
| `force_timeline` | Apply each event in its stated `year` |

Capacity in year **t** = cumulative opens/expands − closes through t. Objective: **NPV** of CapEx + OpEx + transport (optional uncovered penalty) with discount rate `r`.

Response: `npv`, `eventTiming`, `years[]` (open set, CapEx, flows summary, NPV contribution).

```bash
pytest -q tests/test_multi_period.py
```

## Depth slice 6 — Stochastic / scenario-tree (robust)

`POST /optimize/stochastic` accepts network/constraints plus a `scenarioTree`:

```json
{
  "scenarioTree": {
    "objective": "expected",
    "cvarAlpha": 0.3,
    "computeEvpi": true,
    "scenarios": [
      { "id": "soft", "name": "Soft", "probability": 0.5, "demandScale": 0.85 },
      { "id": "surge", "name": "Surge", "probability": 0.5, "demandScale": 1.25 }
    ]
  }
}
```

| Objective | Behavior |
|-----------|----------|
| `expected` | Minimize fixed CapEx+OpEx + Σ p_s · (transport + uncovered)_s |
| `minimax` | Minimize worst-scenario total cost |
| `cvar_lite` | (1−α)·E[total] + α·worst |

First-stage open/close binaries are **shared**; second-stage flows are per scenario.
Optional `costScale` multiplies transport unit cost. Response includes `firstStage`,
per-scenario costs/flows, and an EVPI-ish gap (here-and-now E[cost] − wait-and-see E[cost]).

```bash
pytest -q tests/test_stochastic.py
```

## Depth slice 7 — Lane capacity + transport mode choice

`POST /optimize` lanes may carry a total `capacity` / `capacityUnits` and a
`modes[]` list; the MIP picks the mode split per lane:

```json
{ "id": "ln-1", "from": "plt-1", "to": "dc-1", "capacity": 50000,
  "modes": [
    { "mode": "Truck", "costPerUnit": 0.45, "leadDays": 3, "capacity": 30000, "co2KgPerUnit": 12 },
    { "mode": "Intermodal", "costPerUnit": 0.369, "leadDays": 4, "capacity": 20000, "co2KgPerUnit": 5, "fixedCostM": 0.02 },
    { "mode": "Rail", "costPerUnit": 0.315, "leadDays": 5, "capacity": 15000, "co2KgPerUnit": 2.5, "fixedCostM": 0.05 }
  ] }
```

- Per-mode $/unit, transit days (modes slower than `maxLeadTimeDays` are cut), CO₂/unit,
  optional capacity, optional fixed activation charge (binary per lane-mode).
- Lane capacity caps the total across modes and products; mode capacity caps that mode.
- Duplicate `from→to` rows with different `mode` become alternatives (same mode → last row wins, as before).
- Constraints: `enforceLaneCapacity` (default true), `carbonPricePerTonne`, `tonsPerUnit`,
  `emissionKgPerTonMileByMode` (fallback CO₂ when a mode has no `co2KgPerUnit`).
- Response adds `laneFlows`, `laneUtilization`, `laneCapacity` (with LP shadow prices from a
  pure LP with every binary fixed), `bindingLaneCapacities`, `laneCapacityShortfalls`,
  `modeChoice`, and `objectiveBreakdown.modeMix / laneFixedM / carbonM`; flows carry `mode`, `laneId`, `leadDays`, `co2Kg`.
- Infeasibility hints: `LANE_CAPACITY_SHORTFALL`, `MODE_SERVICE_CAPACITY_CONFLICT`, `PLANT_OUTBOUND_LANE_SHORTFALL`.
- Networks without modes/lane capacity build the identical legacy model.

```bash
pytest -q tests/test_depth7_lane_modes.py
```

## Depth slice 8 — Why-opened/closed explain cards + real facility duals

- **Facility capacity duals** are now real HiGHS row duals of `cap_<facility>`, read
  from the same pure LP (every open/close + lane-mode binary fixed at its MIP value)
  that already serves lane-capacity duals. One LP pass replaces the old copy+MIP
  re-solve; the flat −0.08 proxy only remains as a fallback when the solver returns
  no duals (CBC). Closed sites report `shadowPrice: 0, closed: true`.
- **Explain block** (opt-in): `POST /optimize` with `"explain": true` (or
  `{"maxCounterfactuals": 12, "timeLimitSec": …, "budgetSec": 60}`), or
  `POST /optimize/explain`. Per decidable facility: decision (opened / kept-open /
  closed / kept-closed), fixed CapEx+OpEx, inbound/outbound transport, utilization,
  capacity dual, customers + demand share, cost-to-serve share + landed-cost rank,
  and a **counterfactual**: the full MIP re-solved with that facility forced to the
  opposite state (scenario lock lifted), giving the $ flip penalty (objective,
  operating-cost and unmet-demand-penalty split), service impact and which other
  sites open/close. Ranked plain-language `reasons[]` + `headline`.
- Counterfactuals: all facilities when ≤ `maxCounterfactuals` (default 12), else
  top-N by impact (≥⅓ slots reserved for closed candidates), bounded by `budgetSec`.
  Stress-200: 11 re-solves ≈ 0.3 s on top of the base solve.
- Without `explain` the response is unchanged (no `explain` key).

```bash
pytest -q tests/test_depth8_explain.py
```
