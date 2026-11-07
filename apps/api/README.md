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

Requires Python 3.12 — the version the lock, CI and the container image target.

```bash
cd "$(git rev-parse --show-toplevel)/apps/api"
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt          # pinned, hash-checked lock
pip install --no-deps -e ../engine       # local engine package
pip install -r requirements-dev.txt      # mypy and ruff, pinned
```

`highspy` provides the HiGHS solver; PuLP also ships CBC as a fallback.

### Dependencies, locks and the type gate (CR-034)

| File | Role |
|---|---|
| [`requirements.in`](requirements.in) | Human-edited version ranges — the intent |
| [`requirements.txt`](requirements.txt) | Generated lock: every package pinned with SHA-256 hashes |
| [`requirements-dev.in`](requirements-dev.in) / [`requirements-dev.txt`](requirements-dev.txt) | The same for mypy and ruff |
| [`scripts/lock-requirements.sh`](scripts/lock-requirements.sh) | Regenerates a lock inside `python:3.12-slim`, so the resolver sees CI's interpreter |

pip puts a hashed requirements file in hash-checking mode automatically, so an
unexpected version, or a tampered artifact, fails the install instead of
shipping. After editing a `.in` file, regenerate and commit the lock:

```bash
./scripts/lock-requirements.sh                 # requirements.txt
./scripts/lock-requirements.sh requirements-dev
```

A local editable package cannot appear in a hashed lock, which is why the engine
is installed separately with `--no-deps`.

Solver versions are pinned exactly (`pulp==2.9.0`, `highspy==1.15.1`) in both
[`requirements.in`](requirements.in) and
[`apps/engine/pyproject.toml`](../engine/pyproject.toml): a solver upgrade can
change branching order, and with it objective values, duals and the facilities a
plan opens, while `Run.solver_version` still claims a comparable result.
[`tests/test_solver_pins.py`](tests/test_solver_pins.py) fails when a pin is a
range, when the two declarations disagree, when the lock lags the `.in` file, or
when the installed version is not the pinned one.

Type-check the API with the config in [`pyproject.toml`](pyproject.toml):

```bash
mypy        # checks app/ (25 modules); CI runs this before pytest
ruff check --select E9,F63,F7,F82 .
```

The gate covers `app/`. The engine is not type-checked yet — enabling it there
starts from ~113 existing errors, which is its own piece of work.

## Run

```bash
cd "$(git rev-parse --show-toplevel)/apps/api"
source .venv/bin/activate
uvicorn app.main:app --reload --host 127.0.0.1 --port 5182
```

Health checks: `GET /livez` (process only — a crash loop restarter should use
this), `GET /readyz` (database reachable — load balancers should use this) and
`GET /health`. `readyz` returns 503 with a per-check body when the database is
down; `livez` stays 200 so a DB outage never triggers a restart storm.
`/readyz` also reports `queue`, `reaper` and `authMode`. See
[OBSERVABILITY.md](../../docs/OBSERVABILITY.md).

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
| `objectiveBreakdown` | transportM, fixedCapexM, fixedOpexM, uncoveredPenaltyM, totalM (+ uncoveredPenaltyPerUnit, offLaneRatePerUnitMile echo) |
| `costScale` | Off-lane rate + unmet-demand penalty actually used (see *Cost units*) |
| `shadowPrices` | Capacity duals (LP with binaries fixed) or reduced-cost proxy |
| `kpis` | servicePct, capexUsedM, opexUsedM, transportCostM, costM, … |
| `solver` / `model` / `log` | `pulp-highs` / `fixed-charge-multi-echelon-v1` |

### Cost units

One convention for every objective term:

- Money (objective, breakdown, explain flip costs) is **$M**.
- Lane `costPerUnit` is **$ per unit**; the MIP divides by 1,000, so one model
  volume unit = **1,000 physical units** (demand `9200` ≈ 9.2M units). Explain
  reasons print physical units (`strands 2.3M units`) and capacity duals as
  `$/unit`.
- Facility `fixedCapexM` / `fixedOpexM` are already $M.
- **Off-lane arcs** (no lane rate, within radius) cost the network's median lane
  $/unit-mile × `offLanePremium` (default **1.35**). `offLaneRatePerUnitMile`
  overrides; with no rated lanes the fallback is $0.0015/unit-mile.
- **Unmet demand** costs `uncoveredPenaltyPerUnit` $/unit (default
  max($15, 10 × median lane $/unit)) — well above landed cost, reported
  separately as `uncoveredPenaltyM` / explain `penaltyDeltaM`.
- Knobs are read from `constraints`, then `network.costFactors` (enterprise
  packs' `costFactors`). Legacy `costFactors.uncoveredPenaltyM` (80 "$M/unit")
  is ignored. Before this fix the off-lane rate was a hard-coded 0.002 $M per
  model unit-mile (≈ $2/unit-mile, ~1,500× stress-200 lane rates) and the
  penalty 80 $M per model unit ($80k/unit); set `offLaneRatePerUnitMile: 2` and
  `uncoveredPenaltyPerUnit: 80000` to reproduce old objectives.

## Tests

```bash
cd "$(git rev-parse --show-toplevel)/apps/api"
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

## Server persistence (FF-104)

    docker compose up -d db          # Postgres 16 + PostGIS on 127.0.0.1:5433
    export DATABASE_URL=postgresql+psycopg://flowform:flowform@127.0.0.1:5433/flowform
    .venv/bin/alembic upgrade head
    AUTH_MODE=dev .venv/bin/uvicorn app.main:app --port 5182

`/v1/projects` (list, create, get, `GET /{id}/snapshot[?version=]`, update →
new version, delete) stores ProjectSnapshot JSON verbatim. `AUTH_MODE=dev`
takes identity from `X-Dev-Tenant` (UUID) / `X-Dev-User` headers; any other
mode returns 401 until WorkOS (FF-106). Tenant isolation is enforced twice:
every query filters `tenant_id`, and Postgres RLS (FORCEd, via the
`flowform_app` role + `app.tenant_id`) hides other tenants' rows.
DB tests skip when `DATABASE_URL` is unset.

Scenarios: `/v1/projects/{id}/scenarios` (list, create, get, update, delete;
`{name, spec}`). Runs: `GET /v1/projects/{id}/runs` (creation via the job API, FF-105).

### Quotas and snapshot retention (CR-005)

A save stores a whole snapshot, so three limits bound one tenant's history.
They are read per request — no restart to change one — and a non-integer or
`< 1` value falls back to the default (a typo must not mean "unlimited"):

| Setting | Default | Enforced on |
|---|---|---|
| `MAX_PROJECT_SNAPSHOT_BYTES` | 5 MiB | one request body → `413` |
| `MAX_PROJECTS_PER_TENANT` | 100 | `POST /v1/projects` → `403` |
| `MAX_VERSIONS_PER_PROJECT` | 50 | every save, by pruning older versions |
| `MAX_TENANT_STORAGE_BYTES` | 512 MiB | every snapshot write → `403` |

**Retention.** A save keeps the newest `MAX_VERSIONS_PER_PROJECT` versions of
that project and deletes the rest in the same transaction. Saves are never
rejected for being one version too many, the current version is always among
the newest N, and a pruned version simply `404`s from
`GET /{id}/snapshot?version=`. History of projects that are never saved again
keeps its old rows until their next save (periodic compaction is CR-017).

**Storage.** The check runs after the insert and after pruning, so a save that
compacts history is allowed to succeed. Crossing the cap rolls back the whole
write — version bump, version row and audit event — so the stored size never
exceeds the limit.

**Status codes** are distinct on purpose, because the client shows a different
message for each: `413` this body is too large, `403` the tenant is at a quota
(with `X-Quota-Limit: projects|storage` and the actionable detail), `409` the
base version is stale, `429` (CR-007) too many requests. The workspace banner
treats a `403` carrying `X-Quota-Limit` as "workspace limit reached", not as
"not signed in", and keeps the unsaved project local.

## Async solve jobs (FF-105)

`POST /v1/projects/{id}/runs` `{kind: optimize|multi-period|stochastic, payload, scenarioId?}`
→ 202 queued run (input hash + engine/solver versions stored). Then
`GET .../runs/{rid}` (result when terminal), `GET .../runs/{rid}/events` (SSE),
`POST .../runs/{rid}/cancel`. The sync `/optimize*` endpoints are unchanged.

Queue backend via `QUEUE_BACKEND`: `inline` (default, in-process threads — local
dev and CI), `arq` (Redis; `docker compose up -d redis`, `REDIS_URL=redis://127.0.0.1:6380/0`,
worker `arq app.jobs.worker.WorkerSettings`), `manual` (tests). The Run row is the
state of record; cancel flips its status and late results are discarded.

### Crash recovery (CR-004)

Delivery is at-least-once, and a worker crash never leaves a run stuck. Each
claim is a conditional `UPDATE … WHERE status='queued'` that bumps
`runs.attempts`; the solving worker refreshes `runs.heartbeat_at` every
`RUN_HEARTBEAT_S`, and its result is written with the attempt number in the
`WHERE` clause. A duplicate queue message is therefore a no-op, and a
partitioned worker that wakes up late cannot overwrite the attempt that
replaced it.

`app.jobs.reaper` reclaims both stuck states: a `running` row with no heartbeat
for `RUN_STALE_AFTER_S` is requeued while `attempts < RUN_MAX_ATTEMPTS`, then
failed with an explicit "interrupted" message; a `queued` row whose
`dispatched_at` is older than `RUN_QUEUED_STALE_AFTER_S` is re-dispatched
(lost queue message).

| Setting | Default | Meaning |
|---|---|---|
| `RUN_HEARTBEAT_S` | `30` | Worker lease refresh interval |
| `RUN_STALE_AFTER_S` | `180` | Silence before a run is considered dead |
| `RUN_QUEUED_STALE_AFTER_S` | `120` | Silence before a queued run is re-dispatched |
| `RUN_MAX_ATTEMPTS` | `2` | Claims per run before it is failed |
| `RUN_REAPER_ENABLED` | `true` | Sweep thread in the API process |
| `RUN_REAPER_INTERVAL_S` | `300` | Sweep cadence |

It runs automatically on API startup (a daemon thread; skipped when
`QUEUE_BACKEND=manual`), once when an Arq worker starts, and on demand:

```bash
python -m app.jobs.reaper --once            # cron / CronJob
python -m app.jobs.reaper --interval 60     # standalone sweeper
```

`run_out` exposes `attempts`, `startedAt`, `heartbeatAt` and `dispatchedAt`, so
a retried run is explainable in the UI and in support tickets. Every recovery
action also writes an `AuditEvent` (`run.requeue`, `run.interrupted`,
`run.dispatch_retry`).

## Auth + roles (FF-106)

`AUTH_MODE`: `dev` (headers `X-Dev-Tenant`, `X-Dev-User`, `X-Dev-Role`), `jwt`
(Bearer JWT; `AUTH_JWKS_URL` or `AUTH_JWT_PUBLIC_KEY`, optional `AUTH_JWT_ISSUER`,
`AUTH_JWT_AUDIENCE`; `AUTH_JWT_SECRET` HS256 for tests), `workos` (AuthKit tokens,
JWKS `https://api.workos.com/sso/jwks/$WORKOS_CLIENT_ID`; needs `WORKOS_API_KEY`,
`WORKOS_CLIENT_ID`, `WORKOS_REDIRECT_URI` — inert/401 until set). Anything else → 401.

**Dev mode is local-only (CR-012).** `X-Dev-*` headers are trivially forged, so
they are honoured only when the socket peer is loopback (or the in-process test
client) **and** no proxy header (`X-Forwarded-For`, `Forwarded`, `X-Real-IP`, …)
is present. Anything else is a 401 that names the guard. `DEV_AUTH_ALLOW_REMOTE=1`
is the explicit escape hatch for the Docker Compose stack, whose published ports
are bound to `127.0.0.1`. Startup logs `DEV AUTH — …` (or `DEV AUTH EXPOSED — …`
with the override), and `/v1/auth/config` returns `devAuth` plus that `warning`
so the web account menu can show it.

Tenant = token `org_id`; role = `role` claim (`member`→editor). Tenants/users
auto-provision on first request. RBAC on every /v1 route:

| Role | Allowed |
|---|---|
| viewer | read projects, snapshots, scenarios, runs, run events |
| editor | + create/update projects & scenarios, start/cancel runs |
| admin | + delete projects & scenarios |
| owner | + WorkOS Admin Portal link (`POST /v1/auth/admin-portal`), future billing |

### Session surfaces (CR-010/CR-011)

| Endpoint | Role | Purpose |
|---|---|---|
| `GET /v1/auth/config` | public | mode, WorkOS availability, redirect URI, roles |
| `GET /v1/auth/login` | public | signed `state` + AuthKit URL (`redirect_uri`, `returnTo`, `organizationId`, `screenHint`) |
| `POST /v1/auth/callback` | public | `{code, state}` → tokens + user + organisation (state is mandatory) |
| `POST /v1/auth/refresh` | public (refresh token) | rotate tokens; `organizationId` switches the active organisation |
| `POST /v1/auth/logout` | viewer | WorkOS session logout URL (uses the token's `sid`) |
| `GET /v1/auth/organizations` | viewer | active memberships, current one flagged |
| `GET /v1/auth/me` | viewer | tenant, user, role, session id |

**Hardening.** `redirect_uri` must be `WORKOS_REDIRECT_URI`, an entry in
`WORKOS_ALLOWED_REDIRECT_URIS`, or a loopback `/auth/callback` (RFC 8252 dev
rule) — anything else is a 400 before WorkOS is called. `returnTo` is a relative
path or a trusted origin (no open redirect). `/v1/auth/login` mints an
HMAC-signed state bound to the redirect URI with a 10-minute TTL; the callback
rejects missing, forged or expired state without spending the code. WorkOS
access tokens must carry this app's `client_id` (or matching `azp`) — a token
minted for another WorkOS client is a 401; `WORKOS_ENFORCE_CLIENT_CLAIM=0`
relaxes that. Token responses are `Cache-Control: no-store`. States expire after 10 minutes and the authorization code itself is single-use at the provider.

| Setting | Default | Meaning |
|---|---|---|
| `WORKOS_REDIRECT_URI` | — | the app's callback URL |
| `WORKOS_ALLOWED_REDIRECT_URIS` | — | comma-separated extra allowlist entries |
| `WORKOS_STATE_SECRET` | API key | HMAC key for the login state |
| `WORKOS_ENFORCE_CLIENT_CLAIM` | `1` | require `client_id`/`azp` = `WORKOS_CLIENT_ID` |
| `DEV_AUTH_ALLOW_REMOTE` | — | accept dev headers from any peer (isolated dev containers only) |

The web client ([`data/session.ts`](../web/src/data/session.ts)) completes the
redirect at `/auth/callback`, keeps the access token in memory and the refresh
token in `sessionStorage` (never `localStorage`), refreshes ahead of expiry and
once on a 401, and exposes sign-in / sign-out / organisation switching in the
account menu.

## Observability

Every response carries `X-Request-ID` (an inbound value is reused only when it
is a sane 8–128 char token, otherwise one is generated) and every log line
written during that request includes `request_id=…`, so a customer's cited ID
maps to lines. Runs log `run.create`, `run.start` and `run.finish` with the run
ID and attempt, so one solve can be followed across queue, worker and reaper.

| Setting | Default | Meaning |
|---|---|---|
| `LOG_LEVEL` | `INFO` | level of the `flowform` logger |
| `HTTP_REQUEST_LOG` | `1` | one line per request (health probes excluded) |
| `SENTRY_DSN` | — | enable Sentry error reporting |
| `SENTRY_TRACES_SAMPLE_RATE` | `0` | Sentry performance traces |
| `SENTRY_ENVIRONMENT` / `APP_ENV` | — | Sentry environment |
| `SENTRY_RELEASE` / `APP_RELEASE` | — | release tag |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | — | enable OTLP/HTTP tracing |
| `OTEL_SERVICE_NAME` | `flowform-api` | resource `service.name` |
| `OTEL_TRACES_SAMPLE_RATE` | `0.1` | head sampling ratio |
| `OTEL_SDK_DISABLED` | — | `1` forces tracing off |
| `READYZ_TIMEOUT_S` / `READYZ_CACHE_S` | `2` / `2` | probe bound / cache |
| `READYZ_REQUIRE_DB` | auto | `0`/`1` overrides deployment-aware readiness |
| `METRICS_ENABLED` | `1` | `0` makes `GET /metrics` return 404 |
| `METRICS_TOKEN` | — | when set, `/metrics` needs `Authorization: Bearer <token>` |

`GET /metrics` exports Prometheus counters/histograms for HTTP traffic, run
outcomes, queue wait, reaper actions and readiness. Labels are route templates
and statuses only — never a tenant, user, project or run id. Alert rules and
their unit tests live in [`ops/prometheus/`](../../ops/prometheus).

Sentry and OTel are optional extras: unset DSN and endpoint mean no telemetry,
no collector and no outbound network. `app/observability.py` owns setup, the
request-ID middleware and the access log; [`docs/OBSERVABILITY.md`](../../docs/OBSERVABILITY.md)
has the probe wiring, privacy defaults, metric catalogue and the alert playbook.
