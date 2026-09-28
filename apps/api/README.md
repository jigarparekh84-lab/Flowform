# Flowform Optimize API

Fixed-charge **multi-echelon MIP** (PuLP + HiGHS preferred, CBC fallback):

- Open/close DCs (and optional plants) with fixed CapEx + OpEx
- Capacitated facilities; optional minimum throughput when open
- Flow conservation **plant → DC → customer** (and **supplier → plant** when BOM present)
- Variable transport cost on lanes (or distance proxy)
- Returns objective breakdown, open facilities, flows (with echelon), capacity shadow prices / duals

- Default port: **5182**
- CORS: `http://localhost:5180` (Flowform web)
- Endpoint: `POST /optimize`

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
