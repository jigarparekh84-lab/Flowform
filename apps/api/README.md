# Flowform Optimize API

Minimal FastAPI service that runs a **real MIP** (facility open/close + demand assignment) with **PuLP + HiGHS** (preferred) or **PuLP CBC**.

- Default port: **5182**
- CORS: `http://localhost:5180` (Flowform web)
- Endpoint: `POST /optimize`

> Optional: Google **OR-Tools** CP-SAT is *not* required for this MVP. If you prefer it later, add `ortools` and swap the solver backend in `app/solver.py`.

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
    "nodes": [{ "id": "n1", "name": "…", "kind": "dc", "x": 50, "y": 40, "lat": 39.9, "lng": -83.0, "capacity": "12k" }],
    "lanes": [],
    "demandVolume": { "n4": 9200 }
  },
  "constraints": {
    "serviceTargetPct": 95,
    "serviceRadiusMiles": 250,
    "capexBudgetM": 30,
    "maxFacilities": 6,
    "facilities": [
      { "nodeId": "n1", "status": "open", "capacityMin": 0, "capacityMax": 20000, "fixedCapexM": 4 }
    ]
  },
  "reference": {
    "id": "baseline",
    "kpis": { "cost": { "value": "$48.2M" }, "co2": { "value": "12.4 kt" } }
  }
}
```

Response includes `openedIds`, `closedIds`, `keptOpenIds`, `flows`, `kpis`, `solver`, and `log`.

## Smoke test

```bash
curl -s http://127.0.0.1:5182/health
curl -s -X POST http://127.0.0.1:5182/optimize \
  -H 'Content-Type: application/json' \
  -d '{"network":{"nodes":[{"id":"f1","name":"DC A","kind":"dc","x":40,"y":40,"capacity":"10k"},{"id":"f2","name":"Cand B","kind":"candidate","x":70,"y":40,"capacity":"10k"},{"id":"d1","name":"Demand","kind":"demand","x":55,"y":40,"capacity":"5k"}],"lanes":[],"demandVolume":{"d1":5000}},"constraints":{"serviceTargetPct":95,"serviceRadiusMiles":250,"capexBudgetM":30,"maxFacilities":4,"facilities":[{"nodeId":"f1","status":"open","capacityMin":0,"capacityMax":20000,"fixedCapexM":0},{"nodeId":"f2","status":"candidate","capacityMin":0,"capacityMax":20000,"fixedCapexM":6}]}}'
```

## Web client

The Flowform web app (`apps/web`) calls this API from **Run** when reachable (`VITE_API_URL`, default `http://127.0.0.1:5182`). If the API is down, Run falls back to the client heuristic v1.
