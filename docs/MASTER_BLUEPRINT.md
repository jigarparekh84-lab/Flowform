# Flowform — Master Blueprint

**Codename:** Flowform · supply-chain network **design** studio
**Owner:** Jigar Parekh
**Repo:** `jigarparekh84-lab/Flowform` (private) · branch `master` · written against HEAD `8e2d909` (Oct 23, 2026) **plus the uncommitted hardening pass** in §11.3 (input guards, project versioning, SSE deadline, parity test). Solve numbers did not change in that pass; where a number is pinned to an older commit it says so.
**Status:** Living document. **Replaces** `docs/PRODUCT_BLUEPRINT.md` and extends `docs/UX_BRIEF.md` (both written Sep 28, 2026, before the optimizer depth work). Those files stay for history; read this one first.
**Companions:** [`USER_WORKFLOWS.md`](USER_WORKFLOWS.md) (**how to use the product** — every workflow end to end) · [`MANUAL_TEST_WORKBOOK.md`](MANUAL_TEST_WORKBOOK.md) (full manual QA) · [`SMOKE_CHECKLIST.md`](SMOKE_CHECKLIST.md) (quick smoke) · [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md) (plan of record) · [`adr/`](adr/README.md) (ADR-001…007)

> **Source of truth.** This Markdown file is authoritative. `Flowform_Master_Blueprint.docx` is a point-in-time export and is now behind this text; regenerate it if a Word copy is needed.

> **How this document was checked.** Every feature, field, and number here was read from the code or captured by running it. The API was started with `uvicorn` and called with the same payloads the web app builds (`buildEnterprisePack` → `packToOptimizePayload`). Values marked **(captured)** came from those runs. The headline solve numbers were reproduced on the Mac (repo root, Python 3.14) and on a Linux box (Python 3.13), and re-checked at `8e2d909` + the hardening pass. §11 lists the gaps and defects; §11.3 lists what the hardening pass fixed.

---

## Contents

1. Product vision and positioning
2. Personas
3. Architecture (browser · API · engine · platform)
4. Data model
5. Rooms (12) and global chrome
6. Optimizer capabilities and API
7. Explainability
8. Sample datasets and reference numbers
9. Run instructions
10. Testing assets
11. Known limitations and defects found
12. Roadmap
13. Depth-slice commit map

---

## 1. Product vision and positioning

**One-liner.** Flowform is a map-first studio for drawing, optimizing, stress-testing, and explaining a supply-chain **footprint**: which plants, DCs, and lanes to run, and at what capacity. The finished design goes to a planning system as a structured package.

**Problem.** Decisions about where plants and DCs go, which lanes to run, and how much capacity to commit tend to live in spreadsheets or deep inside planning tools. Teams need a design surface that comes before planning, and it has to be quantitative (MIP), explainable (why each site is open or closed), and scenario-native.

**Positioning: network design vs day-to-day planning.**

| | **Flowform (network design)** | **Day-to-day planning / APS (e.g. Ritara)** |
|---|---|---|
| Question | *What network should we have?* Sites, lanes, capacity, territory, CapEx timing | *How do we run the network we have?* Orders, schedules, MRP, execution |
| Horizon | Strategic (Y0–Y5 roadmap, FY26–FY28 horizon picker) | Tactical/operational (days–weeks) |
| Decisions | Open/close/expand facilities, lane mode and capacity, service radius, product capability | Supply/demand balancing, sequencing, replenishment |
| Engine | Fixed-charge multi-echelon MIP (PuLP + HiGHS), multi-period NPV, scenario-tree robust, plus client heuristics (DES-lite, sensitivity, territory, hub-spoke) | APS solvers (out of scope) |
| Surface | Map canvas, scenarios, compare, brief | Plan grids, order books |
| Exit | **Handoff** package `flowform.handoff.v1` (JSON + Markdown ops brief) | Consumes the package (intake adapter: future work) |

**Non-goals (still true in code).** No APS, scheduling, or MRP. No embedded or copied Ritara code: the Ritara link is a JSON **contract stub** only (`target: "Ritara APS (intake contract)"`). No live Ritara sync. Multi-tenant auth and server storage now exist on `/v1` (FF-104…FF-107) but are **optional**: with `AUTH_MODE=off` and `VITE_PROJECT_STORE=local` the whole studio runs browser-only, exactly as it did before.

**Design principles** (from `UX_BRIEF.md`, still valid): the canvas owns the viewport, spatial comes before tabular, scenarios sit next to the map, you compare without losing your place, greenfield is a mode rather than another app, handoff is an exit ramp, and advanced controls use progressive disclosure.

---

## 2. Personas

| Persona | Goals in Flowform | Primary rooms |
|---|---|---|
| **Network design lead** (primary) | Build or load a footprint, run the MIP, read why each site is open or closed, compare what-ifs, recommend one | Network, Scenarios, Compare, Brief |
| **Ops strategy / IBP reviewer** | Challenge the recommendation: sensitivity, robustness, service risk, territory | Compare (Sensitivity, Robust, DES-lite, Resilience), Brief |
| **Finance / CapEx partner** | Phase CapEx, read NPV, see objective breakdown and $M units | Roadmap, Compare (objective breakdown), Brief |
| **Data / analytics engineer** | Load enterprise data, fix validation codes, run stress benchmarks | Data, Projects, API (`curl`, `pytest`) |
| **First-time analyst** (self-serve) | Answer four questions, get a labelled starter model and a first optimal result without a consultant | Projects → **Start with 4 questions** (wizard), Network, Compare |
| **Workspace owner / IT admin** | Invite the team, set roles, connect SSO, keep projects on the server instead of one browser | `/v1/auth` (WorkOS), Projects → sync banner |
| **Downstream planner** (Ritara / S&OP) | Receive a clean design package: sites, lanes, preferred territory, CapEx calendar, mix, BOM RM, inventory targets | Handoff (consumer of JSON/MD) |
| **M&A integration analyst** | Merge an acquired network, resolve id conflicts, draft a merged baseline | Merge |

---

## 3. Architecture

### 3.1 System diagram

```mermaid
flowchart LR
  subgraph Browser["Browser — apps/web (Vite + React 19 + TS) :5180"]
    UI["12 rooms + TopChrome<br/>(LeftNav, Inspector, KPI strip)"]
    CTX["FlowformContext<br/>(single state store)"]
    LS[("localStorage<br/>flowform-projects-index<br/>flowform-project-&lt;id&gt;<br/>flowform-theme")]
    ENG["Client engines (TS)<br/>heuristic v1 · DES-lite · cost tornado/MC<br/>territory · hub-spoke · BOM · lane bids<br/>inventory · resilience · CTS · merge · handoff · narrative"]
    PACK["enterprisePack.ts<br/>buildEnterprisePack → validate → packToOptimizePayload"]
    SYNC["workspaceSync.ts · jobsApi.ts · apiAuth.ts<br/>server links · offline queue · job polling · auth headers"]
    MAP["MapLibre GL canvas<br/>(SVG schematic fallback)"]
    UI <--> CTX
    CTX <--> LS
    CTX --> ENG
    CTX --> PACK
    UI --> MAP
  end
  TILES[("OpenFreeMap tiles (default)<br/>Carto raster if VITE_BASEMAP=carto")]
  MAP --> TILES
  subgraph API["apps/api — FastAPI :5182 (CORS 5180/5181)"]
    MAIN["Sync solve API (main.py)<br/>GET /health<br/>POST /optimize · /optimize/explain · /optimize/validate<br/>POST /optimize/multi-period · /optimize/stochastic"]
    V1["/v1 workspace API<br/>projects · scenarios · runs · auth/RBAC"]
    JOBS["jobs/ — queue (inline | arq) + runner"]
    DBS[("Postgres 16 + PostGIS :5433<br/>RLS by tenant")]
    Q[("Redis :6380<br/>(optional arq backend)")]
    MAIN --> ENGINE
    V1 --> DBS
    V1 --> JOBS
    JOBS --> ENGINE
    JOBS --> DBS
    JOBS --> Q
  end
  subgraph Engine["apps/engine — flowform_engine 0.1.0 (pure Python, no web deps)"]
    ENGINE["solver · solvers adapter (HiGHS/CBC)<br/>multi_period · multi_period_run · stochastic<br/>explain · diagnostics · validation · pack_validation · limits"]
  end
  HIGHS[["PuLP → HiGHS (highspy)<br/>CBC fallback"]]
  ENGINE --> HIGHS
  SYNC -- "sync solve (fetch)" --> MAIN
  SYNC -- "projects · scenarios · runs (auth)" --> V1
  CTX -- "Handoff JSON + MD (download)" --> OUT[("flowform.handoff.v1<br/>→ Ritara intake stub")]
```

### 3.2 Run pipeline (top-chrome **Run**)

1. `checkApiHealth()`: `GET /health` with a 1.2 s timeout.
2. `buildEnterprisePack()` from live state (network, constraints, product mix, BOM, emission factors), then `validateEnterprisePack()` produces the scorecard, and `packToOptimizePayload()` builds the MIP payload: one SKU per product group (`sku-<group>`), `demandByProduct`, `bomDemand`, `costFactors`.
3. **Pre-run guardrails (FF-108).** When the API is up the web calls `POST /optimize/validate` (cheap, no solve) with the same network/constraints. Any blocking issue stops the Run *before* the MIP with the actual reason and fix in the status bar (`Run blocked — There is no customer demand to serve. Fix: Add demand.`), and the shortfall tables ride along with the result for infeasibility hints. An older API without the route is ignored.
4. **Solve transport (FF-105).** The client tries the async job API first: `POST /v1/projects/{id}/runs` → 202, then polls `GET …/runs/{id}`. The top chrome shows a `Run · queued 20% · message` chip with **Cancel** (`POST …/cancel`). If the project is not linked to the workspace it is pushed first (FF-107). A run that has reached the server is **never silently re-run sync**; only a failure before enqueue (no project, 401, no DB, network) falls back to the sync `POST /optimize`. A 422 from either path is returned to the user unchanged.
5. The sync call uses `explain: {maxCounterfactuals: 12, budgetSec: 30}` and `reference` = the Baseline scenario. `applyOptimizeResult()` creates a new scenario named **"Optimize MIP <time>"** (or **"Optimize Infeasible <time>"**). It stores `optimizeMeta` (objective breakdown, flows, duals, explain, lane utilization, product breakdown, infeasibility report), applies open/close decisions to constraints (skipped when infeasible), and appends a `run_optimize` decision-log entry.
6. If the API is down or errors, it falls back to `runHeuristicOptimize` (greedy, "Heuristic v1 — greedy open/close (not a full MIP)").

The same routing serves **Roadmap → Optimize timing** (`multi-period`) and **Compare/Scenarios → Robust** (`stochastic`); the job payload is normalised through the *same* request→engine mapping as the sync endpoint (`normalize_request`), so a job and a sync call with the same body solve the identical model.

The status line in the chrome shows: `API pulp-highs · Optimal · <s> · fixed-charge-multi-echelon-v1 · service x% · obj $…M (tx … + CapEx … + OpEx …) · N SKUs/groups · modes … · K binding lane cap(s)`. Chips show model, status (red when Infeasible), solve seconds, solver, SKU count, and the first infeasibility code.

### 3.3 Repository layout (HEAD `8e2d909` + hardening pass)

| Path | Role | Size |
|---|---|---|
| `apps/web/src/App.tsx` | Room router, global keys (Esc, ?), wizard overlay | 107 lines |
| `apps/web/src/state/FlowformContext.tsx` | All studio state + actions (run/optimize/robust/multi-period, scenarios, log, sync) | 2,785 |
| `apps/web/src/components/*` | 28 room/panel components (Compare 3,278; Data 1,508; NetworkMap 764) plus `WorkspaceSyncPanel`, `ActiveJobChip`, `RunNarrativeCard`, `ShortfallTables`, `onboarding/OnboardingWizard` | — |
| `apps/web/src/data/*` | Domain engines + types (enterprisePack 1,874; `workspaceSync`, `jobsApi`, `apiAuth`, `validation`, `onboarding`, `narrative`) | — |
| `apps/web/public/samples/` | `na-footprint-2027.flowform.json`, `stress-120/200-demand.enterprise.json` | — |
| `apps/engine/flowform_engine/` | `solver.py` (3,066), `multi_period.py` (739), `multi_period_run.py`, `stochastic.py` (979), `explain.py` (593), `diagnostics.py` (299), `validation.py` (184), `pack_validation.py` (526), `limits.py`, `solvers.py` | — |
| `apps/api/app/main.py` | Sync solve API + guards + CORS | 426 |
| `apps/api/app/v1/` | `projects` (versioned snapshots, `If-Match`), `scenarios`, `runs` (202 + SSE + cancel), `auth` (dev/JWT/WorkOS, RBAC), `workos` (login/callback/portal) | — |
| `apps/api/app/jobs/` | Queue interface (`inline` / `arq` / `manual`), run runner, arq worker | — |
| `apps/api/app/db/` | SQLAlchemy models + `tenant_session` / `admin_session` (RLS) | — |
| `apps/api/alembic/` | `0001` tenancy core (FORCE RLS, `flowform_app`), `0002` run progress/message/payload | — |
| `apps/api/tests/` | 133 passing tests, 4 DB-gated skips (golden harness, RLS/RBAC, jobs, guards, parity, stress benchmark, depth 4/7/8, multi-period, stochastic) | — |
| `docker-compose.yml` | web :5180 · api :5182 · Postgres/PostGIS :5433 · Redis :6380 · arq worker | — |
| `.github/workflows/ci.yml` | web (data tests, lint, typecheck, build) · api (ruff, alembic upgrade + check, pytest) · benchmark (stress-120/200 under `STRESS_TIMEOUT_S`, writes the job summary) | — |

**Persistence.** `localStorage` is always the working copy: `flowform-projects-index`, `flowform-active-project-id`, `flowform-project-<id>` (a `ProjectSnapshot`), `flowform-theme`, plus `flowform-server-links` and `flowform-sync-pending` when the workspace is on. Every local save is mirrored to `/v1/projects` after a 1.5 s debounce (FF-107); if the API is down or unauthenticated the write stays local and is queued. This is deliberate: an offline browser is still a usable studio, and the server is a backup/sharing layer rather than a hard dependency.

### 3.4 Platform layer (FF-104…FF-108)

Flowform ships in three deployment shapes. All three run the same UI and engine; only the optional server layer changes.

| Mode | What is on | Persistence | Identity |
|---|---|---|---|
| **Browser-only** | web (static) + API for solves | `localStorage` only | none |
| **Single-tenant workspace** | + Postgres, `AUTH_MODE=dev` | local working copy mirrored to `/v1` | `X-Dev-Tenant` / `X-Dev-User` headers, **loopback peers only** |
| **Multi-tenant workspace** | + Postgres/Redis, `AUTH_MODE=workos` | same | WorkOS AuthKit JWT (`org_id` → tenant, `sub` → user), in-app sign-in and organisation picker |

**Endpoints.** `/v1` is a separate surface from the solve endpoints; it is the workspace, not the optimizer.

| Method | Path | Purpose | Role |
|---|---|---|---|
| GET | `/v1/auth/config` | public: auth mode, WorkOS availability, roles | — |
| GET | `/v1/auth/login` | signed state + AuthKit authorization URL | — |
| POST | `/v1/auth/callback` | exchange AuthKit code → access/refresh token (state required) | — |
| POST | `/v1/auth/refresh` | rotate tokens; `organizationId` switches organisation | — |
| POST | `/v1/auth/logout` | WorkOS session logout URL from the token's `sid` | viewer |
| GET | `/v1/auth/organizations` | switchable organizations, each confirmed with the provider (confirmations cached ~60s, denials re-checked); current one flagged | viewer |
| GET | `/v1/auth/me` | current tenant/user/role | viewer |
| POST | `/v1/auth/admin-portal` | self-serve SSO / directory link for the tenant's IT | owner |
| GET/POST | `/v1/projects` | list / create (body = `ProjectSnapshot` JSON) | viewer / editor |
| GET/PUT/DELETE | `/v1/projects/{id}` | metadata / save new version / delete | viewer / editor / admin |
| GET | `/v1/projects/{id}/snapshot?version=` | stored snapshot bytes + `X-Project-Version` | viewer |
| GET/POST | `/v1/projects/{id}/scenarios` | list / create `{name, spec}` | viewer / editor |
| GET/PUT/DELETE | `/v1/projects/{id}/scenarios/{sid}` | read / update / delete | viewer / editor / admin |
| GET | `/v1/projects/{id}/runs` | run history (status, hash, versions) | viewer |
| POST | `/v1/projects/{id}/runs` | enqueue `{kind, payload, scenarioId?}` → 202 | editor |
| GET | `/v1/projects/{id}/runs/{rid}` | status/progress (+ `result` when terminal) | viewer |
| GET | `/v1/projects/{id}/runs/{rid}/events` | SSE `status` / `done` / `timeout` / `gone` | viewer |
| POST | `/v1/projects/{id}/runs/{rid}/cancel` | flip to cancelled, abort transport | editor |

**Dev mode is local-only (CR-012).** `AUTH_MODE=dev` trusts `X-Dev-*` headers, so the API honours them only when the socket peer is loopback (or the in-process test client) and no proxy header is present; every other request is 401. `DEV_AUTH_ALLOW_REMOTE=1` exists for the Compose stack, whose ports are published on `127.0.0.1`. Startup logs a `DEV AUTH` warning (`DEV AUTH EXPOSED` with the override) and `/v1/auth/config` returns `devAuth`/`warning`, which the account menu displays.

**Sign-in and session.** `/v1/auth/login` mints an HMAC-signed state (10-minute TTL) bound to an allowlisted `redirect_uri`; the callback verifies it before spending the code, so a forged or replayed redirect never receives tokens. WorkOS access tokens must also carry this app's `client_id` (or matching `azp`) — the AuthKit audience check, since WorkOS does not document an `aud` claim. The web completes the redirect at `/auth/callback`, keeps the access token in memory and the refresh token in `sessionStorage` (never `localStorage`), refreshes ahead of expiry and once on a 401, and exposes sign-in, sign-out, the current role and organisation switching in the top-chrome account menu. A signed-in viewer sees Run/Share disabled; local and dev modes stay ungated.

**Tenancy and isolation.** Every `/v1` query filters `tenant_id`, and Postgres enforces the same rule independently: tables are `FORCE ROW LEVEL SECURITY`, and `tenant_session()` switches to the non-owner `flowform_app` role and sets `app.tenant_id` for the transaction. The RLS tests deliberately query **without** a tenant filter to prove the database, not the application code, is doing the isolation. Roles are `viewer → editor → admin → owner`; WorkOS `member` maps to editor, unknown roles fall back to viewer. Tenants and users are provisioned on first sight.

**Project versioning.** Each save appends a `ProjectVersion` row (snapshot stored verbatim) and bumps `Project.current_version` with a compare-and-swap (`UPDATE … WHERE current_version = :base`), not a read-modify-write — two concurrent saves cannot both claim version *n+1*. A client may send `If-Match: "<version>"`; a stale base gets **409** with the current `ETag`, absent `If-Match` keeps the legacy last-write-wins behaviour. `updated_at` advances on every save, so project ordering is real.

**Jobs.** The `Run` row in Postgres is the state of record; the queue only carries `(run_id, tenant_id)`. `QUEUE_BACKEND=inline` (default) uses an in-process thread pool, `arq` uses Redis (`docker compose` runs a worker), `manual` is for tests. Cancellation is a status flip: the runner checks it before starting and refuses to overwrite a cancelled run with a late result. Delivery is at-least-once: a claim is a conditional `UPDATE … WHERE status='queued'` that bumps `attempts`, so a duplicate message is a no-op, and the worker's result is written with that attempt number in the `WHERE` clause, so a partitioned worker cannot overwrite the attempt that replaced it. A heartbeat thread refreshes `heartbeat_at` while the solver runs; `app.jobs.reaper` requeues or fails runs whose heartbeat went stale and re-dispatches `queued` rows whose `dispatched_at` is old (lost queue message). The SSE stream has a 15-minute deadline (`RUN_EVENTS_MAX_S`), a 15 s keep-alive comment, and ends with `event: gone` if the run disappears — it is a convenience, never the source of truth.

**Environment.** `DATABASE_URL` (default `postgresql+psycopg://flowform:flowform@127.0.0.1:5433/flowform`), `QUEUE_BACKEND`, `REDIS_URL` (6380), `AUTH_MODE`, `AUTH_JWKS_URL` / `AUTH_JWT_PUBLIC_KEY` / `AUTH_JWT_SECRET`, `AUTH_JWT_ISSUER` / `AUTH_JWT_AUDIENCE`, `WORKOS_API_KEY` / `WORKOS_CLIENT_ID` / `WORKOS_REDIRECT_URI` / `WORKOS_ALLOWED_REDIRECT_URIS` / `WORKOS_STATE_SECRET` / `WORKOS_ENFORCE_CLIENT_CLAIM`, `DEV_AUTH_ALLOW_REMOTE` (isolated dev containers; unset = loopback only), `MAX_CONCURRENT_SOLVES` (2), `SOLVE_QUEUE_WAIT_S` (5), `RUN_EVENTS_MAX_S` (900), `MAX_PROJECT_SNAPSHOT_BYTES` (5 MiB), `MAX_PROJECTS_PER_TENANT` (100), `MAX_VERSIONS_PER_PROJECT` (50), `MAX_TENANT_STORAGE_BYTES` (512 MiB). Web: `VITE_API_URL`, `VITE_PROJECT_STORE` (`api` default, `local` disables sync), `VITE_RUN_MODE` (`jobs` default, `sync` forces the old path), `VITE_DEV_TENANT`, `VITE_DEV_USER`, `VITE_BASEMAP`, `VITE_CARTO_API_KEY`, `VITE_SENTRY_DSN` / `VITE_SENTRY_ENVIRONMENT` / `VITE_SENTRY_RELEASE` (browser error reporting; unset = off).

---

## 4. Data model

### 4.1 Enterprise pack — `flowform-enterprise-pack` @ `enterprise-data-v1`

Defined in `apps/web/src/data/enterprisePack.ts`. The pack is the canonical import/export format and the only path into the MIP (Run rebuilds a pack from studio state every time).

| Entity | Key fields | Notes |
|---|---|---|
| `sites[]` | `id, name, kind (plant/dc/demand/supplier/candidate), lat, lng, x, y, region, capacityMin, capacityMax, fixedCostM, fixedOpexM?, status (open/closed/candidate), capableProductIds?, capacityByProduct?` | `fixedCostM` = CapEx $M to open (0 if sunk). Demand sites are the "customers". |
| `skus[]` | `id, name, code, groupId?, handling?` | |
| `productGroups[]` | `id, name, code, color?, description?` | Catalogs: Ambient/Chilled/Hazmat or Finished/WIP/RM |
| `demand[]` | `id, customerId, skuId, volume` | Demand by SKU × customer |
| `lanes[]` | `id, from, to, mode, costPerUnit ($/unit), leadDays, capacity, co2Kg?, modes[]?` | `modes[] = {mode, costPerUnit, leadDays, capacity?, co2KgPerUnit?, fixedCostM?}`. Known modes: Truck, Rail, Intermodal, Ocean, Air, Parcel |
| `bom[]` | `id, parentSkuId, childSkuId, qtyPerUnit, plantId?, supplierId?` | Becomes `bomDemand` supplier→plant arcs |
| `costFactors` | `emissionKgPerTonMileByMode, transportCostScale, offLanePremium (1.35), offLaneRatePerUnitMile?, uncoveredPenaltyPerUnit (15)` | Legacy `uncoveredPenaltyM` is ignored by the solver |
| `globals?` | `serviceTargetPct, serviceRadiusMiles, capexBudgetM, maxFacilities, hardServiceConstraints, maxLeadTimeDays, aggregateProductsByGroup, maxProductCommodities, enforceLaneCapacity, carbonPricePerTonne` | Optimize globals carried with the pack |

**Validation scorecard** (`validateEnterprisePack`). Fields: `ok, score, errorCount, warnCount, infoCount, geocodeCoveragePct, siteCount, demandRowCount, demandVolumeTotal, laneCount, skuCount, bomRowCount, orphanDemandCount, missingEndpointCount, capacityIssues, bomCycleDetected, multiModeLaneCount, laneModeOptionCount, issues[] {level, code, message, entityId, hint}`.

**Score formula:** `100 − 12·errors − 3·warns − (100 − geocode%)/4 − 15 (if BOM cycle)`, clamped to 0–100. `ok = errors == 0 && sites > 0`. Import is **blocked** when `errorCount > 0`; warnings load.

**Validation codes (38).** Severity was captured by running each negative case through `parseEnterprisePackJson` (see workbook WF08):

| Code | Level (captured) | Code | Level (captured) |
|---|---|---|---|
| `EMPTY_PACK` | error | `LANE_MODE_EMPTY` | flagged |
| `SCHEMA_MISMATCH` | warn | `LANE_MODE_UNKNOWN` | warn |
| `DUPLICATE_SITE_ID` | error | `LANE_MODE_DUPLICATE` | flagged |
| `UNKNOWN_SITE_KIND` | flagged | `LANE_MODE_COST_NEGATIVE` | flagged |
| `INVALID_SITE_STATUS` | flagged | `LANE_MODE_LEAD_INVALID` | flagged |
| `GEOCODE_GAP` | warn | `LANE_MODE_CAPACITY_NONPOSITIVE` | flagged |
| `CAPACITY_NONPOSITIVE` | error | `LANE_MODE_FIXED_COST_NEGATIVE` | flagged |
| `CAPACITY_MIN_GT_MAX` | error | `LANE_MODE_CO2_NEGATIVE` | flagged |
| `FIXED_COST_NEGATIVE` | flagged | `LANE_MODE_CAPACITY_BELOW_LANE` | flagged |
| `DUPLICATE_GROUP_ID` | flagged | `LANE_ROUTE_DUPLICATE` | warn |
| `DUPLICATE_SKU_ID` | flagged | `DUPLICATE_BOM_ID` | flagged |
| `ORPHAN_SKU_GROUP` | flagged | `BOM_ORPHAN_PARENT` | flagged |
| `DUPLICATE_DEMAND_ID` | flagged | `BOM_ORPHAN_CHILD` | flagged |
| `ORPHAN_DEMAND_CUSTOMER` | error | `BOM_QTY_NONPOSITIVE` | flagged |
| `ORPHAN_DEMAND_SKU` | error | `BOM_CYCLE` | error (−15 extra) |
| `DEMAND_VOLUME_NONPOSITIVE` | error | `BOM_PLANT_MISSING` | flagged |
| `DUPLICATE_LANE_ID` | flagged | `BOM_SUPPLIER_MISSING` | flagged |
| `LANE_FROM_MISSING` / `LANE_TO_MISSING` | error | `LANE_COST_NEGATIVE` | error |
| `LANE_CAPACITY_NONPOSITIVE` | flagged | | |

"flagged" means the code exists and is covered by `enterprisePack.test.ts` (15/15 pass) but its level was not captured separately.

### 4.2 Project snapshot — `flowform-project` v1

`ProjectSnapshot` keys (from the sample pack): `version, horizon, scenarios, activeScenarioId, deltas, network, constraints, brief, handoffPayload, emissionFactors, lastCandidates, theme, inventoryPolicies, comments, productMix, laneRates, bom, capexRoadmap, decisionLog`. The export file is `{format: "flowform-project", version: 1, meta: {id, name, createdAt, updatedAt}, state}`.

**Constraints** (`NetworkConstraints`): globals (`serviceTargetPct 95, serviceRadiusMiles 250, capexBudgetM 30, maxFacilities = clamp(#facilities, 3, 8)`, optional `hardServiceConstraints, maxLeadTimeDays, aggregateProductsByGroup, maxProductCommodities`) plus `facilities[] {nodeId, status, capacityMin, capacityMax, fixedCapexM}`. Defaults from `defaultConstraintsFromNetwork`: **min = 60 % and max = 125 % of nominal capacity**, CapEx 8 (plant), 4 (DC), or 6 (candidate) $M.

**Scenario.** `{id, name, tag, kpis {cost, service, capex, co2, risk, inventory?, invUnits?}, optimizeMeta?, desLite?, costSensitivity?, resilience?, …}`. Optimize results arrive as new scenarios. Baseline KPIs start from a seed (**$48.2M · 94.1 % · $0 · 12.4 kt · Med**) and are **replaced on the first API Run** by the as-is costing of the current network (`computeBaseline` → `response.baseline`; sample: **$99.0M · 100.0 % · $0 · ≈5.5 kt · Low**).

### 4.3 Units

- **All money is $M.** Lane `costPerUnit` is **$ per physical unit**. One model volume unit = **1,000 physical units**, so demand `9200` means 9.2M units and explain text prints physical units.
- **Off-lane arcs** (no lane, inside the radius) cost the median lane $/unit-mile × `offLanePremium` (default **1.35**). The fallback is $0.0015/unit-mile when no lanes are rated.
- **Unmet demand** costs `uncoveredPenaltyPerUnit` = **max($15, 10 × median lane $/unit)**. It is reported separately as `uncoveredPenaltyM`.

### 4.4 Handoff package — `flowform.handoff.v1`

Top-level fields: `schema_version, product ("Flowform"), target ("Ritara APS (intake contract)"), readme (embedded), meta, brief, network {sites, lanes, demand_volume, site_count, lane_count}, preferred_lanes, territory, capex_events, capex_year_slices, product_mix, bom {rows, fg_shares, implied_rm, rollup}, inventory_targets, scenarios, section_counts`. Files: `flowform-handoff-<horizon>-flowform.handoff.v1.json` and `flowform-handoff-ops-<horizon>.md`. **It is a contract stub. No Ritara code and no live API.**

### 4.5 Server schema (Postgres, tenant-scoped)

Every table below `tenants` carries `tenant_id` and is covered by a Postgres RLS policy on `app.tenant_id` (`FORCE ROW LEVEL SECURITY`, non-owner `flowform_app`). The browser snapshot remains the document; these tables store, version and index it.

| Table | Key columns | Notes |
|---|---|---|
| `tenants` | `id`, `name`, `external_id`, `created_at` | `external_id` = WorkOS organisation id |
| `users` | `id`, `tenant_id`, `email`, `role`, `external_id`, `created_at` | unique `(tenant_id, email)`; role is `owner/admin/editor/viewer` |
| `projects` | `id`, `tenant_id`, `name`, `current_version`, `created_by`, `created_at`, `updated_at` | `current_version` is the CAS target |
| `project_versions` | `id`, `tenant_id`, `project_id`, `version`, `snapshot_raw`, `created_by`, `created_at` | unique `(project_id, version)`; snapshot stored **verbatim** |
| `scenarios` | `id`, `tenant_id`, `project_id`, `name`, `spec` (JSONB), `created_at` | server-side scenario records, separate from the browser's scenario list |
| `runs` | `id`, `tenant_id`, `project_id`, `scenario_id`, `kind`, `status`, `progress`, `message`, `payload`, `input_hash`, `engine_version`, `solver_version`, `result`, `created_at`, `finished_at`, `attempts`, `started_at`, `heartbeat_at`, `dispatched_at` | the run is the state of record (`queued/running/succeeded/failed/cancelled`); the last four columns are the recovery lease (CR-004) |
| `audit_events` | `id`, `tenant_id`, `actor_id`, `action`, `target`, `detail` (JSONB), `created_at` | append-only trail for project/scenario/run actions |

Migrations: `0001_tenancy_core` (tables, RLS policies, `flowform_app` role, PostGIS) and `0002_runs_progress_message_payload`. `alembic check` is part of CI, so a model change without a migration fails the build.

---

## 5. Rooms (12) and global chrome

Nav order in code (`LeftNav.tsx`): **Projects · Network · Greenfield · Hubs · Territory · Roadmap · Scenarios · Compare · Brief · Data · Merge · Handoff**. The app opens on **Network**.

### 5.0 Global chrome (TopChrome)

| Control | Behavior |
|---|---|
| Project button | Opens Projects; shows the active project name |
| `Active · <scenario>` chip | Current Active scenario |
| Horizon | FY26 / FY27 / FY28 |
| Run status | Progress bar while running. When the async job API is in use, `ActiveJobChip` shows `Run/Roadmap/Robust · status % · message` with **Cancel** (FF-105). When done: message, model, status, seconds, solver, SKU count, infeasibility chip (hover lists all hints) |
| ☀ Light / ☾ Dark | Toggles `data-theme` on `<html>`; persisted in `flowform-theme`; first default follows `prefers-color-scheme` |
| **Run** | API MIP if reachable, otherwise heuristic v1 |
| **Share** | Copies a `flowform://share?v=1&project=…&name=…&readonly=1` deep-link stub and downloads `<name>.share.json` (`format: flowform-share`). An alert confirms. |
| **Compare** | Jumps to Compare |
| **Help ?** | Opens the keyboard shortcuts dialog |
| Search ⌘K | Command palette **stub** (no action) |

**Keyboard** (`App.tsx`, `KeyboardHelp.tsx`): `Esc` closes help, otherwise clears the map/table selection. `?` toggles help. Shift+click multi-selects nodes or lanes. Clicking the map background clears the selection. Shortcuts are ignored while typing in inputs, textareas, selects, or contenteditable elements.

### 5.1 Projects

- **Purpose:** workspace home for design studies.
- **Inputs:** `*.flowform.json` imports; stress packs.
- **Outputs:** an Active project; `*.flowform.json` export; decision log panel.
- **Key controls:** **Start with 4 questions** (onboarding wizard, FF-110) · New project · Import JSON · Load stress-200 · Load stress-120 · Open · Rename (Save/Cancel) · Duplicate · Export · Delete. Delete is disabled with the tooltip "Keep at least one project" when only one project exists.
- **Workspace banner (FF-107):** *Saved to your workspace* · *Working offline — saving in this browser* · *Not signed in — saving in this browser only* · *Projects are stored in this browser only (server sync disabled)*. When online and local-only projects exist, **Move my N local project(s) to my workspace** pushes them and imports workspace projects this browser does not have.
- **Onboarding wizard:** four answers (products, customers, sites, question) → a starter `enterprise-data-v1` pack with every assumption explicitly labelled "assumed" → guardrails → first Run → plain-language result (FF-115) with a jump to Compare. Locations resolve offline: "City, ST" against a built-in metro table, US ZIP by prefix (approximate beyond the table), or `lat, lng`.

### 5.2 Network (primary canvas)

- **Purpose:** design and inspect the active footprint on a map.
- **Inputs:** network, constraints, product mix, BOM, last MIP result.
- **Outputs:** edited nodes, lanes, and constraints; selection; KPIs.
- **Key controls:**
  - **Layer rail:** Plants, DCs, Demand, Suppliers (off), Lanes, Service radii (off), Candidates, Capacity heat (off), Territory (off).
  - **Map:** MapLibre with OpenFreeMap (`styles/liberty` light, `styles/dark` dark), or the Carto raster style. Tiles/SVG toggle with SVG schematic fallback.
  - **Lane paint:** selected `#7dd3fc` → MIP binding **red `#f87171`** → MIP util ≥ 80 % **amber `#fbbf24`** → BOM lanes `#c084fc` → default.
  - **Inspector, node:** name/type/region/capacity, demand product mix, product capabilities, BOM production and outbound, and the **"Why this site?"** explain card (after an API run). Facility rows: Status (Open/Closed/Candidate), Capacity min/max, Open CapEx $M.
  - **Inspector, lane:** cost/unit, lead time, CO₂, lane product groups, **Transport mode** (changing it rescales cost by mode relatives: Road/Truck 1, Rail 0.55, Intermodal 0.72, Ocean 0.32, Air 4.5, and refreshes CO₂), and carrier bids (Cheapest/Fastest/Balanced, Apply, Add bid, Apply winner).
  - **Inspector, nothing selected:** **Network constraints**: Service radius (mi), CapEx budget ($M), **Max DCs (open)** (DCs + candidates only; plants stay open and are not counted; API also accepts a separate `maxPlants` when `optimizePlants` is on), **Hard service constraints**, Max lead-time (days, optional).
  - **Product group filter:** All / per group; dims entities outside the group.
  - KPI strip, bottom Facilities/Lanes tables, scenario footer (**+ New** is a stub).

### 5.3 Greenfield

- **Purpose:** blank-slate candidate DC placement (a mode, not a separate app).
- **Inputs:** Demand set (NA Core demand (sample); East-heavy growth (stub); West Coast push (stub)), site count 2–6 (default 3), service miles (250), Euclidean distance, Lock existing sites.
- **Outputs:** Candidates table (Name, Region, Score, Reach) and a mini-map. **Promote → Candidates delta** goes to the Scenarios delta library.
- **Note:** candidate placement is a **mock heuristic** (`generateCandidates`) that runs on the static sample `NODES`, not the MIP. Composed-scenario KPIs come from a formula (`kpisForComposedScenario`).

### 5.4 Hubs (hub-and-spoke)

- **Purpose:** designate hubs, assign demand spokes, generate hub→spoke lanes, and draft a before/after scenario.
- **Key controls:** Suggest 2 hubs / Suggest 3 hubs; Assign spokes by (distance / volume / balanced, volume weight 0.45); New lane mode (Truck); Replace existing demand-inbound lanes; Draft scenario name; **Apply + draft scenario**.
- **Outputs:** Before (Active) vs After (preview) KPIs, Hub loads (util %), Spoke assignments, and the decision log entry `apply_hub`.

### 5.5 Territory

- **Purpose:** assign demand to serving DCs and plants, measure coverage, find gaps and overlaps, and apply preferred inbound lanes.
- **Key controls:** Select all servers; Assign by (**distance / capacity / lanes**); coverage miles (400) and lead days (3); New lane mode; Scenario name; **Apply as scenario + update preferred lanes**.
- **Outputs:** After KPIs, territory load vs capacity, assignments with status (assigned/overlap/gap), map territory colors and gap/overlap ring, and the log entry `apply_territory`. The same view appears in Compare → Territory.

### 5.6 Roadmap (CapEx phasing)

- **Purpose:** multi-year open/close/expand events with CapEx and capacity Δ, plus NPV timing optimization.
- **Inputs:** Base year label (FY26), Years (2–8, default 6 → Y0–Y5), events (Kind, Year, Facility, Name, CapEx $M, Capacity Δ).
- **Key controls:**
  - **Optimize timing** (Call API `/optimize/multi-period`): Mode = Choose timing (NPV) / Force timeline; Discount rate % (10).
  - **Apply year slice** (Through year; Scenario name → Apply as scenario).
  - **Export to Brief** / **Export NPV to Brief**; Reset sample.
- **Outputs:** Gantt-lite timeline, cumulative CapEx & capacity table, Multi-period NPV results (NPV total, CapEx/OpEx/Transport NPV, per-year rows), timing written back to events, and log entry `optimize_timing`.

### 5.7 Scenarios

- **Purpose:** library of what-ifs, presets, and composition.
- **Key controls:**
  - **Sensitivity presets:** Fuel +20%, Demand shift East, Node outage (DC), Tariff / duty (MX inbound). Each creates a new what-if from Active.
  - **Cost tornado + Monte Carlo** (Run on Active).
  - **Robust optimize:** Objective Expected cost / Minimax / CVaR-lite; Export to Brief. It uses library scenarios as shocks when 2 or more exist.
  - Network scenarios list (activate), Delta items, **Compose** (Scenario name, Base + promoted greenfield deltas).

### 5.8 Compare

- **Purpose:** side-by-side KPIs and diagnostics versus a Reference. Up to **5** scenarios; defaults to Baseline + Active.
- **Tabs (14):** Matrix · Map diff · Waterfall · Cost-to-serve · DES-lite · Sensitivity · Inventory · Resilience · Mode mix · Products · Bids · BOM · Territory · **Robust**.
- **Matrix extras:** **Run narrative** (plain language, traceable numbers) · *Optimize objective breakdown* (Total, Transport, CapEx, OpEx, Uncovered pen., Open sites, Model) · *Optimized flows by mode · lane capacity* (mode mix + binding lane caps with π) · **Why this network — <scenario>** explain panel · *Infeasibility diagnostics* with **shortfall tables** (lane cap vs required, facility min vs feasible) · *SKU / product-group breakdown*.
- **Also present:** Comments panel and decision log panel.

### 5.9 Brief

- **Purpose:** the Decision Brief: recommendation vs Reference, scenario cards, assumptions checklist, and notes.
- **Key controls:** Recommended scenario; **Download Markdown** (`flowform-brief-<horizon>.md`); **Printable HTML** (`flowform-brief-<horizon>.html`); **Send to Handoff**; assumptions (6 defaults, 5 checked); Notes.
- **Explain:** "Why this network" uses MIP explain when present. Otherwise it shows the hint "run Optimize with the API online…".
- **Also present:** decision log and comments panels.

### 5.10 Data

- **Purpose:** get data in, validate it, and edit reference data.
- **Sections:**
  - **Uploads:** Sites / Demand / Lanes CSV templates (Template download), Load into Network, Reset to sample, Restore sample network.
  - **Enterprise data model:** Export pack JSON, Import pack JSON, Load stress-200/120. **Validation scorecard** (schema, score, geocode, demand/lanes, issues with fix-it hints).
  - Constraints linked to Network.
  - **Product / commodity groups:** catalog switch, demand mix by node, facility capabilities, lane product tags.
  - **Lane rate tables & bids:** strategy, bids by corridor, Apply / Apply all winners / Reset rates.
  - **Bill of materials:** FG demand shares, BOM rows, implied RM, echelon flows, Highlight BOM lanes, Draft inbound scenario, Reset sample.
  - **CO₂ emission factors** (kg/ton-mile).

### 5.11 Merge

- **Purpose:** M&A merge studio.
- **Key controls:** Load sample acquired / Import network JSON; Sources (Primary, Acquired, Merged preview); Conflicts table with Resolution (Keep both (rename acquired) / Keep primary only / Replace with acquired); **Apply merge + draft scenario**.

### 5.12 Handoff

- **Purpose:** the S&OP design exit ramp toward Ritara (stub).
- **Inputs:** the Brief (shows "Waiting for Brief" until Brief → Send to Handoff).
- **Outputs:** Package ready + schema; **Download JSON**; **Ops brief (Markdown)**.
- **Section tabs:** overview, network, preferred lanes, territory, CapEx, products, BOM, inventory, scenarios, README, raw JSON preview. Log entry `handoff_export`.

---

## 6. Optimizer capabilities and API

### 6.1 Endpoints (FastAPI `0.7.0`, port 5182)

The solve endpoints are **unauthenticated by design** in the current deployment (they are reached directly by the browser) and are instead size-capped, time-limited and concurrency-limited (§6.6). The workspace endpoints under `/v1` are authenticated and tenant-scoped (§3.4).

| Method | Path | Purpose | Errors |
|---|---|---|---|
| GET | `/health` | `{"status":"ok","service":"flowform-api","model":"fixed-charge-multi-echelon-v1+multi-period-run-basis-v2+stochastic-scenario-tree-v1+explain-v1"}` (legacy liveness alias) | — |
| GET | `/livez` | `{"status":"alive","service":"flowform-api"}` — no dependencies touched, for restart probes | — |
| GET | `/readyz` | `{"status":"ready","checks":{"database":…,"queue":…},"requestId":…}` — deployment-aware DB/queue checks, 2 s bound, cached | 503 when a required dependency is down; body names the failing check and the exception class only |
| GET | `/metrics` | Prometheus text format: HTTP, run, queue-wait, reaper and readiness series (no tenant/user/run labels) | 404 with `METRICS_ENABLED=0`; 401 when `METRICS_TOKEN` is set and the bearer token is wrong |
| POST | `/optimize` | Single-period MIP (optional `explain`) | 422 schema (e.g. missing `constraints`); 400 bad/oversized payload ("Network lanes (25000) exceeds the limit of 20000…", "No facility nodes…"); 429 worker busy; 503 time limit hit or solver missing; 500 logged, generic |
| POST | `/optimize/explain` | Same as `/optimize` with `explain` forced on | same |
| POST | `/optimize/validate` | Pre-run guardrails (FF-108); `?deep=true` also solves and turns Infeasible root causes into blocking issues | 400/422 for an unusable body; 429/503 only in deep mode |
| POST | `/optimize/multi-period` | CapEx NPV timing (Run basis by default) | 400 ("No demand nodes in network.", size caps); 429/503 |
| POST | `/optimize/stochastic` | Scenario-tree / robust | 400 ("Need 2–5 scenarios, got 1.", size caps); 429/503 |

### 6.2 `POST /optimize`: fixed-charge multi-echelon MIP (`fixed-charge-multi-echelon-v1`)

**Model.**
- Binary open/close per decidable facility (DCs and candidates; plants when `optimizePlants`). Fixed CapEx (if not already open) + OpEx; capacity max and min-throughput-when-open (`capacityMin`).
- Flow conservation supplier→plant (BOM `qtyPerUnit`), plant→DC, DC→customer, and plant→customer, **per commodity**.
- Arcs exist within `serviceRadiusMiles`, or wherever an explicit lane exists (lanes override the radius).
- Budget (`capexBudgetM`) and `maxFacilities` (counts DCs/candidates). Unmet demand is penalized (soft) or forbidden (`hardServiceConstraints`).
- `maxLeadTimeDays` cuts slow arcs and modes.

**Multi-SKU.** `network.demandByProduct` + `skus`/`productGroups`. Products aggregate to groups automatically when the commodity count exceeds `maxProductCommodities` (default 8; `aggregateProductsByGroup` auto/always/never). Facility `capableProductIds` accepts SKU or group ids (expanded via `groupId`).

**Lanes and modes (depth 7).**
- `lanes[].capacity|capacityUnits` and `lanes[].modes[]`; the MIP chooses the split.
- Per-mode $/unit, transit, CO₂/unit, capacity, and an optional fixed activation charge (binary).
- `enforceLaneCapacity` (default true), `carbonPricePerTonne`, `tonsPerUnit`, `emissionKgPerTonMileByMode`.
- Duplicate `from→to` rows with different modes become alternatives.

**Request highlights.** `network {nodes, lanes, demandVolume, demandByProduct?, skus?, productGroups?, bomDemand?, costFactors?}`, `constraints {globals + facilities[]}`, `reference?`, `bom?`, `bomDemand?`, `enterpriseSchemaVersion?`, `explain?` (`true` or `{maxCounterfactuals (12, max 50), timeLimitSec, budgetSec (60), topDecisions (6)}`).

**Response highlights.**

| Field | Contents |
|---|---|
| `ok, status, solver ("pulp-highs"), model, solveSeconds` | Solve metadata |
| `openIds / openedIds / closedIds / keptOpenIds` | Decisions |
| `openFacilities[]` | Throughput, capacityMax, util %, CapEx/OpEx, capable products |
| `flows[]` | `from, to, volume, miles, unitCost, transportCostM, echelon, productId, laneId, mode, leadDays, co2Kg` |
| `objectiveBreakdown` | `totalM, transportM, fixedCapexM, fixedOpexM, uncoveredPenaltyM, laneFixedM, carbonM, modeMix[], currency` |
| `costScale` | median lane rate, off-lane rate + source, penalty + source |
| `shadowPrices[]` | `facilityId, shadowPrice, binding, slack, method ("lp-dual")` |
| `kpis` | `servicePct, capexUsedM, opexUsedM, transportCostM, costM, co2Kt, uncoveredDemand, targetPct, objectiveTotalM, productCount, transportCo2Kt, bindingLaneCount` |
| `productBreakdown[]` | Per SKU/group demand, served, service %, transport |
| `laneFlows, laneUtilization, laneCapacity, bindingLaneCapacities, laneCapacityShortfalls, modeChoice` | Depth 7 |
| `infeasibilityReport` | `{status, summary, hints[{code, severity, message, entities, hint}], metrics, method: "structural-best-effort", note}` |
| `explain` | Depth 8 (see §7) |
| `log[]` | Model size, solver, status, summary lines |

**Infeasibility hint codes:** `UNREACHABLE_DEMAND, SERVICE_RADIUS_TOO_TIGHT, CAPACITY_SHORTFALL, NO_CAPABLE_FACILITY, PRODUCT_CAPACITY_SHORTFALL, HARD_SERVICE_INFEASIBLE, LANE_CAPACITY_SHORTFALL, MODE_SERVICE_CAPACITY_CONFLICT, PLANT_OUTBOUND_LANE_SHORTFALL` (plus `MULTI_PERIOD_INFEASIBLE`, `STOCHASTIC_INFEASIBLE`). Best effort; no full IIS.

### 6.3 `POST /optimize/multi-period` (`multi-period-run-basis-v2`)

- **Request:** `/optimize` body plus `roadmap {baseYearLabel, yearCount (2–8), discountRate (0–0.5, default 0.10), mode: choose_timing | force_timeline, basis: run | legacy-aggregate, compareRun, mipGapRel, timeLimitSec, events[{id, kind open|expand|close, year, nodeId, capexM, capacityDelta, earliestYear, latestYear, locked}], demandScaleByYear? | demandGrowthPct?, hardServiceConstraints?, capexBudgetTotalM?, enforceCapexBudget}`.
- **Model (default `basis: "run"`):** every period is the **Run model** — fixed charges, SKUs, BOM, lane modes and lane capacity, carbon and lane fixed charges — linked by one timing binary per event and year. Capacity in year *t* = cumulative opens and expands − closes. `basis: "legacy-aggregate"` keeps the older aggregate model for comparison.
- **Objective:** minimize NPV(CapEx + OpEx + transport + uncovered) at the discount rate.
- **Solver budget:** gap **1e-4** (2e-3 above 2,000 variables), **120 s** time limit, both overridable on the roadmap.
- **Materialization:** open events whose node is missing from the network are materialized as DC nodes; a site with an open event starts **closed** until that year.
- **Response:** `npv {totalM, capexNpvM, opexNpvM, transportNpvM, uncoveredPenaltyNpvM}`, `eventTiming[]`, `years[] {openIds, capexM, opexM, transportM, totalCostM, npvContributionM, servicePct, flowsSummary}`, `basis {model, commodities, commodityMode, gapRel, …}`, `runCheck?`, `kpis`, `log`, `infeasibilityReport?`.
- **The web sends** the same Run payload (network + SKUs/groups + BOM + lane modes), `basis: "run"`, `compareRun: true`, `enforceCapexBudget: false`, and timing windows `[0, yearCount−1]` (choose) or `[year, year]` locked (force). It displays the basis and gap from the response rather than assuming them.

### 6.4 `POST /optimize/stochastic` (`stochastic-scenario-tree-v1`)

- **Request:** `/optimize` body plus `scenarioTree {objective expected|minimax|cvar_lite, cvarAlpha (0.3), computeEvpi (true), scenarios[2–5] {id, name, probability, demandScale, costScale, demandVolume?}}`. The shorthand `scenarios` + `objective` at the top level is also accepted.
- **Model:** first-stage open/close is **shared**; second-stage flows are per scenario.
- **Objectives:** expected = fixed + Σ p·(transport + uncovered); minimax = worst; CVaR-lite = (1−α)·E + α·worst.
- **Response:** `firstStage {openIds, capexM, opexM, fixedCostM}`, `scenarios[] {transportM, uncoveredPenaltyM, totalCostM, servicePct, openIds, flowsSummary}`, `objectiveValueM, expectedCostM, worstCostM`, `evpi {hereAndNowExpectedM, waitAndSeeExpectedM, evpiGapM, waitAndSeeByScenario[]}`.
- **Web defaults:** Base 0.4 ×1.0 · Soft −15% 0.3 ×0.85 · Surge +25% 0.3 ×1.25. Compare and Scenarios can instead map scenario chips to shocks by name: fuel → cost ×1.2, demand/shift → demand ×1.15, outage → cost ×1.05, tariff/duty → cost ×1.1, baseline → ×1.0, others → spreads 0.9/1.0/1.1/1.2/0.95.

### 6.5 Client-side engines (no API)

| Engine | File | What it does | Defaults |
|---|---|---|---|
| Heuristic v1 | `optimize.ts` | Greedy open/close fallback when the API is down | radius from constraints |
| DES-lite | `desLite.ts` | Monte Carlo fill rate / late % / lead | 200 trials, demand noise 15 %, lead noise 20 %, target 5 d, seed 42 |
| Cost tornado + MC | `costSensitivity.ts` | OAT tornado + MC on 6 drivers vs the cost KPI | 300 trials, seed 42; ranges transport 15 %, fuel 20 %, tariff 25 %, demand 15 %, facility fixed 12 %, inventory holding 20 % |
| Inventory | `inventoryPolicy.ts` | Safety stock: ASCM combined (default) or simple z·σ·√LT | per-node policies |
| Resilience | `resilience.ts` | SPOF scoring via coverage drop | threshold = service target (95) |
| Territory | `serviceTerritory.ts` | Distance / capacity / lanes assignment | 400 mi, 3 d |
| Hub-spoke | `hubSpoke.ts` | Spoke assignment + lane generation | balanced, w = 0.45 |
| BOM | `bom.ts` | Implied RM, echelon flows, inbound lanes | sample 3 FG / 6 rows |
| Lane bids | `laneRates.ts` | Rank bids Cheapest/Fastest/Balanced, apply | balanced |
| Cost-to-serve | `costToServe.ts` | Uses MIP flows when present (totals = transport + variable OpEx) | — |

---

### 6.6 Request guards and failure modes (hardening pass)

All three solve entry points call `guard_payload` **before** a model is built and `time_limit_sec` when configuring the solver. The point is that a bad request is cheap: it is refused, never truncated and never turned into a bogus optimum.

| Guard | Default | Override | On violation |
|---|---|---|---|
| Network nodes | 5,000 | `constraints.maxNetworkNodes` | 400 naming actual, limit and remedy |
| Network lanes | 20,000 | `constraints.maxNetworkLanes` | 400 |
| Demand rows | 5,000 | `constraints.maxDemandRows` | 400 |
| SKUs / commodities | 500 | `constraints.maxCommodities` | 400 |
| Roadmap events | 200 | `constraints.maxRoadmapEvents` | 400 |
| Scenarios | 10 | `constraints.maxScenarios` | 400 |
| Solver wall clock | **120 s** | `constraints.solverTimeLimitSec`, clamped **1–600 s** | **503** when the solver stops non-optimal at the limit |
| Concurrent solves | 2 per worker | `MAX_CONCURRENT_SOLVES` | **429** + `Retry-After: 2` after a 5 s wait (`SOLVE_QUEUE_WAIT_S`) |

Two behaviours are deliberate:

- **A time-limited solve is not a result.** PuLP leaves every variable at `0.0` when it stops at the limit, which used to be summarised as a complete, zero-cost network. A non-optimal stop now raises, and the HTTP layer returns 503 naming the limit and what to simplify.
- **Capacity `0` means zero.** An explicit `capacityMax: 0` (or `capacity: 0`) now serves nothing. Only a *missing* capacity means unlimited. This was a real bug: `0` was treated as falsy and fell through to “unlimited”.

The cheap non-deep `/optimize/validate` path does not consume a solve slot; the deep path does. Error mapping is shared by every solve route: `ValueError`/`PayloadTooLarge` → 400, `RuntimeError` → 503, `HTTPException` passed through, anything else logged server-side and returned as a generic 500 (`<label> failed; the error was logged on the server.`) so internals never reach the client.

**Cross-language parity.** `flowform_engine/pack_validation.py` mirrors the TypeScript `validateEnterprisePack` so server-side jobs can score a pack without a browser. It is **not wired to a route yet**; it is a library. Its parity fixture is generated from the TypeScript validator itself (`npm run gen:pack-parity` → `apps/web/src/data/packParity.fixture.json`) and asserted by `apps/api/tests/test_pack_validation_parity.py`. The three divergences it caught (Python collapsing id `1` and `true` as duplicates, TS reporting 4 sites for `sites: "nope"`, a string demand volume concatenating to `400250` instead of summing to `650`) are fixed in both implementations.

---

## 7. Explainability

1. **Objective breakdown.** Transport / CapEx / OpEx / unmet penalty / lane fixed / carbon, all in $M, shown in the Compare Matrix and the Brief.
2. **Capacity duals.** These are real HiGHS row duals of `cap_<facility>`, taken from one pure LP with every binary fixed at its MIP value. Shown as "Capacity binding (100 % utilized): each extra unit of capacity saves $x/unit". A flat −0.08 proxy is used only when the solver gives no duals (CBC). Closed sites report `shadowPrice 0, closed: true`.
3. **Lane duals and binding lanes.** `bindingLaneCapacities[]` with π. Map lanes turn **red** when binding and **amber** at ≥ 80 % utilization. Compare shows *Optimized flows by mode · lane capacity*.
4. **Explain block (`explain`)**:
   - Top level: `enabled, method ("counterfactual-mip-resolve+lp-duals"), baseCostM, baseServicePct, gapToleranceM, headline, facilities[], topOpenedIds, topClosedIds, maxCounterfactuals, timing, note`.
   - Per facility: `decision (opened / kept-open / closed / kept-closed), fixed CapEx+OpEx, inbound/outbound transport, utilization, capacity dual, customers served + demand share, reachable demand %, cost-to-serve + share, landed cost + rank, counterfactual {flipTo, status, costM, deltaM, deltaPct, servicePct, operatingDeltaM, penaltyDeltaM, unservedDeltaUnits, alsoOpens, alsoCloses, lockLifted}, reasons[] (ranked, tone), headline`.
   - **Counterfactual:** the full MIP is re-solved with the facility forced to the opposite state (scenario lock lifted). All facilities are covered when there are ≤ 12; otherwise the top-N by impact, with at least ⅓ of slots reserved for closed candidates, bounded by `budgetSec`.
5. **UI surfaces:** Network Inspector "Why this site?" card · Compare Matrix "Why this network — <scenario>" (Open sites — top by flip cost; Closed sites — why not) · Brief "Why this network" plus a Markdown section (`explainMarkdown`, top 5 opened + top 5 closed).

**Captured example (built-in sample):**
- **Headline:** "The MIP closed Reno DC; kept 3 existing site(s) open. Costliest flip: closing Austin Plant strands 27.7M units (service 0.0%)."

| Site | Decision | Headline reason | Flip (captured) |
|---|---|---|---|
| Columbus DC (n2) | Kept open | "Required: closing it makes the network infeasible" | infeasible |
| Austin Plant (n1) | Kept open | "Closing it strands 27.7M units of demand (service drops to 0.0%); operating cost falls $98.3M only because that demand goes unserved" | +$317.23M total (incl. penalty) |
| Atlanta DC (n3) | Kept open | "Closing it raises cost by $850k (0.9%); service holds at 100.0%" | +$0.8504M |
| Reno DC (n8) | Closed | "No customers within service radius / lead-time limits" | +$0.70M to open |

---

## 8. Sample datasets and reference numbers

### 8.1 Built-in sample: "NA Footprint 2027"

| id | Name | Kind | Capacity | Region |
|---|---|---|---|---|
| n1 | Austin Plant | plant | 42k u/wk | South |
| n2 | Columbus DC | dc | 18k pallet | Midwest |
| n3 | Atlanta DC | dc | 14k pallet | Southeast |
| n4 | Chicago Hub | demand | 9.2k | Midwest |
| n5 | Dallas Metro | demand | 7.1k | South |
| n6 | NYC Corridor | demand | 11.4k | Northeast |
| n7 | Monterrey Sup | supplier | 22k | MX |
| n8 | Reno DC | dc | 12k pallet | West |

Lanes: l1 n7→n1 Truck $1.12 · l2 n1→n2 Rail $0.64 · l3 n1→n3 Truck $0.88 · l4 n2→n4 Truck $0.41 · l5 n3→n6 Intermodal $0.97 · l6 n1→n5 Truck $0.35 · l7 n8→n2 Rail $0.72 · l8 n3→n5 Truck $0.79 · **l9 n2→n6 Truck $1.38 (hazmat lane Columbus→NYC)**. Demand 27,700 model units (27.7M units). Product mix Ambient/Chilled/Hazmat. Atlanta is not hazmat-capable, which is why l9 matters. BOM: 3 FGs, 6 rows, all supplied from Monterrey to Austin.

**Captured Run (default sample, API up):**
- **Optimal**, objective **$98.2706M** = transport $95.6706M + CapEx $0 + OpEx $2.6M; unmet $0.
- **Service 100 %** (all 3 SKUs). Open n1, n2, n3; **closed n8 (Reno)**. Solve 0.003–0.008 s.
- Supplier→plant BOM inbound is $62.048M of transport (55,400 model units × $1.12).
- KPI card: cost **$98.3M (−0.7 % vs the computed Baseline $99.0M**, i.e. Reno's $0.7M OpEx), service 100.0 % (+0.0 pp), CapEx $0M, CO₂ **5.5 kt** (modelled transport CO₂ from unit weights, −0 %; $100/t carbon → $0.5495M, total $98.8201M), Risk Low.

### 8.2 Sample project pack

`apps/web/public/samples/na-footprint-2027.flowform.json` (`flowform-project` v1, "NA Footprint 2027 (sample)") contains the built-in network, Baseline + East Coast DC / Nearshore MX / Lean Lanes, product mix, lane rates, BOM, CapEx roadmap (5 events), and inventory policies. It gives the same Run result as §8.1 (pytest `test_sample_network_solves_optimal_with_full_service_and_closes_reno`).

### 8.3 Stress packs (`enterprise-data-v1`)

| Pack | Sites | Demand rows | Volume | Lanes (multi-mode) | Globals | Captured Run |
|---|---|---|---|---|---|---|
| stress-120 | 132 (3 plants, 6 DCs, 2 candidates, 1 supplier, 120 demand) | 240 | 119,420 | 265 (24 with Truck/Intermodal/Rail = 72 options) | target 92 %, radius 400, budget $40M, max 10 | Optimal **$89.1312M** (tx $81.0008M, OpEx $7.8M, lane fixed $0.32M), 9 open, 100 %, 3 binding lanes (ln-10, ln-20, ln-22), modes Truck 59 % / Rail 36 % / Intermodal 4 %, solve 0.07–0.16 s |
| stress-200 | 212 (… 200 demand) | 400 | 197,500 | 425 (24 multi-mode / 72 options) | same | Optimal **$176.8118M** (tx $168.4817M, OpEx $7.8M, lane fixed $0.53M), **9 open** (6 DCs + 3 plants; candidates Seattle dc-7 and Miami dc-8 stay closed), 100 %, 6 binding lanes (ln-1, ln-10, ln-11, ln-20, ln-21, ln-22), modes Truck 61 % / Rail 34 % / Intermodal 6 %, solve 0.85 s (Mac) – 1.35 s (box); with explain (11 counterfactuals) ≈ 3.7 s wall |

---

## 9. Run instructions

```bash
# Run from anywhere inside the checkout.
cd "$(git rev-parse --show-toplevel)"

# API (5182) — solve endpoints only; /v1 returns 401 with AUTH_MODE=off
cd apps/api
python3 -m venv .venv && source .venv/bin/activate   # first time
pip install -r requirements.txt && pip install --no-deps -e ../engine   # hashed lock + local engine
source .venv/bin/activate
uvicorn app.main:app --reload --host 127.0.0.1 --port 5182
curl -s http://127.0.0.1:5182/health

# Web (5180 — never 5173, which is Ritara)
cd ../web
npm install    # first time
npm run dev    # http://localhost:5180 ; preview build: npm run preview -> 5181

# Workspace (optional): Postgres/PostGIS :5433 + Redis :6380 + arq worker
cd "$(git rev-parse --show-toplevel)" && docker compose up -d db redis
cd apps/api && source .venv/bin/activate
export DATABASE_URL=postgresql+psycopg://flowform:flowform@127.0.0.1:5433/flowform
alembic upgrade head
AUTH_MODE=dev QUEUE_BACKEND=inline uvicorn app.main:app --port 5182
# worker instead of inline: QUEUE_BACKEND=arq arq app.jobs.worker.WorkerSettings

# Docker (everything)
cd "$(git rev-parse --show-toplevel)" && docker compose up --build
```

**Environment (`apps/web/.env.local`, gitignored; never commit):** `VITE_API_URL` (default `http://127.0.0.1:5182`), `VITE_PROJECT_STORE=api|local`, `VITE_RUN_MODE=jobs|sync`, `VITE_DEV_TENANT`, `VITE_DEV_USER`, `VITE_BASEMAP=openfreemap|carto`, `VITE_CARTO_API_KEY` (Carto only), `VITE_SENTRY_DSN` (+) for browser error reporting. API side: §3.4. Hard-refresh after changes.

**Ports:** web **5180** · preview **5181** · API **5182** · Postgres **5433** · Redis **6380**. Docker publishes the same numbers; the containers listen on the standard ones internally.

**Tests:**
- `cd apps/api && pytest -q` → **133 passed, 4 skipped** at the hardening pass (was 79). The 4 skips are the Postgres/RLS modules when `DATABASE_URL` is unset — CI sets it, so a plain local run reports green while skipping tenancy.
- `cd apps/api && python -m pytest -q tests/test_stress_benchmark.py -s` → stress-120 `$89.1312M`, stress-200 `$176.8118M`, 9 open, Optimal; fails if a solve exceeds `STRESS_TIMEOUT_S` (60 s).
- `cd apps/web && npm run test:data` → 8 suites (enterprise 15, CTS 2, defect fixes, workspace sync, validation, onboarding, narrative, jobs).
- `npm run typecheck`, `npm run lint`, `npm run build` → clean apart from the pre-existing chunk-size warning.
- **Golden cases:** `pytest -q tests/test_golden.py` compares stable summaries for G-S, G-M120, G-M200, G-INF, G-RMP, G-ROB and explain. Regenerate deliberately with the command in `apps/api/tests/golden/README.md`; a drift self-test proves the harness notices changes.
- **Parity:** `npm run gen:pack-parity` rewrites the TS→Python fixture; `pytest -q tests/test_pack_validation_parity.py` asserts it.

---

## 10. Testing assets

- [`USER_WORKFLOWS.md`](USER_WORKFLOWS.md): every way to use the product, room by room, with the decision each workflow supports.
- `docs/MANUAL_TEST_WORKBOOK.md` and `docs/Flowform_Manual_Test_Workbook.xlsx`: **21 workflows** (WF00–WF20), 199 original cases plus **28** platform/hardening cases, expected values, a 20-check regression suite, and a defect log.
- `docs/SMOKE_CHECKLIST.md`: a 10-minute smoke that points to the workbook.
- **Golden harness** (`apps/api/tests/test_golden.py`, cases in `tests/golden/cases.py`): stable summaries for the sample, stress-120/200, infeasibility, roadmap, robust and explain, with a drift-detection self-test and a documented regeneration command.
- **Tenancy/identity** (`test_auth_rbac.py`, `test_projects_api.py`, `test_runs_api.py`, `test_scenarios_api.py`): RLS proven by querying without a tenant filter, RBAC matrix, versioned snapshots and `If-Match` conflicts, job lifecycle. Skipped without `DATABASE_URL`.
- **Guards and parity** (`test_guards.py`, `test_pack_validation_parity.py`): size caps, time limit, capacity `0`, 429/503/400 mapping, TS↔Python validator agreement.
- **CI** (`.github/workflows/ci.yml`): `web` (data tests → oxlint → `tsc -b` → `vite build`), `api` (ruff E9/F63/F7/F82 → `alembic upgrade head` + `alembic check` → pytest against PostGIS/Redis services), `benchmark` (stress-120/200 under `STRESS_TIMEOUT_S`, result written to the job summary).

---

## 11. Known limitations and defects found

### 11.1 Known gaps (confirmed in code, refreshed at the hardening pass)

1. ~~Baseline is hard-coded.~~ **Fixed (`a6d3fae`).** The first API Run also costs the as-is network (existing sites open, candidates closed, no decisions; `capacityMin` relaxed only if the as-is network is infeasible) and writes it onto the Baseline scenario. Sample: Run **$98.3M** vs Baseline **$99.0M** → **−0.7 %**. Before the first API Run (or with the API offline) the seed $48.2M is still shown.
2. ~~Multi-period not on the Run basis.~~ **Fixed (`6821f58`).** `/optimize/multi-period` now builds every period with the Run model (SKUs, BOM, lane modes, carbon, lane fixed) and links periods with event binaries; Y0 forced-at-current equals Run (sample $98.2706M, Δ 0; stress-200 +0.02% at default gap 2e-3). Gap 1e-4 (2e-3 above 2,000 vars), 120 s limit. Stress-200 5-period roadmap (7,740 vars) solves in ~3 s (8.5–11 s at gap 1e-4). `roadmap.basis: "legacy-aggregate"` keeps the old model. Remaining: per-period CapEx budget only enforced at Y0; demand growth is uniform; larger packs may stop at the time limit with a non-zero gap.
3. **Supplier lanes have no mode choice.** BOM supplier→plant arcs carry no `laneId` or `mode` in flows.
4. ~~Per-product-group capacity is ignored with per-SKU products.~~ **Fixed (`a6d3fae`):** a group-keyed `capacityByProduct` cap is shared by every SKU commodity in that group. Default group caps are now the full site capacity (so they only bind when a planner lowers them); the sample's saved caps were updated the same way.
5. **Headless map worker warning** in non-GUI runs (MapLibre); cosmetic.
6. **Collaboration is local.** The share deep link `flowform://…` still has no receiver, and comments live in project storage. Sign-in, sign-out, refresh, the role surface and an organisation picker now exist in the web (CR-010) on top of the server-side auth/RBAC, but there is no invite flow, SSO self-serve portal entry point or project-level ACL yet. Search ⌘K and the scenario footer "+ New" are still stubs.
7. **Basemap.** OpenFreeMap today; move to **self-hosted Protomaps** before commercial launch.
8. **Greenfield and composed scenarios are mock heuristics**, not MIP-driven (`generateCandidates` uses static `NODES`; `kpisForComposedScenario` is a formula).
9. **Server persistence is a mirror, not a collaboration protocol.** `localStorage` remains the working copy; saves are debounced to `/v1/projects` and queued when offline. The browser mirror sends `PUT` **without** `If-Match`, so two browsers editing the same project resolve last-write-wins at the server even though the API supports optimistic concurrency (`If-Match` → 409 + `ETag`). A real multi-editor flow needs the client to track and send the version.
10. **CO₂ basis (fixed `dcd1196`).** CO₂ = tonne-distance × mode factor (Truck 0.161, Rail 0.022, Intermodal 0.065 kg/tonne-mile); carbon cost uses the same tonnes. Weight per unit: SKU `unitWeightKg` → group `unitWeightKg` → project `defaultUnitWeightKg` → legacy `tonsPerUnit` → 20 kg. Sample weights (Ambient 2 kg, Chilled 1.5, Hazmat 3.5 — case-pick consumer goods, ~2 kg average per shipped unit) give **5.5 kt** (5,494.6 t, 106.19M tonne-km, 51.7 g/tkm); stress packs (FG-A 4 kg, FG-B 2.5, RM 1; regenerated by `scripts/generate-stress-packs.mts`) give stress-200 **51.0 kt**, stress-120 **32.0 kt**. `co2WeightBasis: "legacy-1t"` restores the old 2,703.5 kt. Limitations: weights are planning assumptions, not measured; seed (unsolved) scenarios in Brief/Scenarios still show seed CO₂ (e.g. 11.1 / 10.2 kt) until Run; an explicit lane-mode `co2KgPerUnit` overrides weight; empty-backhaul and load factor are not modelled.
11. **Robust is design enumeration**, not one monolithic two-stage MIP: candidate designs = each scenario's wait-and-see optimum + the legacy two-stage design + their union, each re-solved on the full model in every scenario. Minimum throughput scales down with a demand shock (flagged per scenario if relaxed).
12. **Infeasibility root-cause probes** re-solve up to 3 times (minimums off / lane caps off / both), so an infeasible Run takes a little longer. They are budgeted only by the normal solver time limit, not by a separate probe budget.
13. **The cost model exists twice.** The browser computes costs for the heuristic/KPIs in TypeScript and the engine computes the MIP objective in Python. They agree today on the documented conventions ($M, $/unit, 1,000-unit scale) and are pinned by golden and parity tests, but there is no single schema contract; a change to one side must be mirrored by hand.
14. **The solve endpoints are unauthenticated.** Anyone who can reach port 5182 can spend CPU. The deployment answer is the guard stack (§6.6) plus network placement; per-token quotas belong with the multi-tenant deployment, not the browser-direct one.
15. **`ArqQueue.enqueue` blocks.** It wraps an async pool in `asyncio.run`, which is fine for the current FastAPI sync routes and worker, but a fully async route would need `await`. `inline` remains the default for local/CI.
16. **Web verification is data-layer only.** There is no component/DOM test runner; `npm run test:data` covers pure functions and the UI is verified manually (workbook) or by `tsc`/build. The oxlint warnings are React-refresh/style advisories, not failures. The production bundle is ~1.7 MB and not code-split.
17. **Snapshot history is bounded per project, not per tenant-wide compaction.** Every save appends a full `project_versions` row (stored verbatim). CR-005 added retention (`MAX_VERSIONS_PER_PROJECT`, default 50, pruned in the writing transaction), a per-tenant project quota and a tenant storage cap — see `apps/api/README.md`. Two gaps remain: a project that is never saved again keeps its old rows until its next save (periodic compaction is CR-017), and there is still no backup/restore drill (CR-008).

### 11.2 Defects found while writing this blueprint — all fixed in `a6d3fae`

| ID | Finding | Fix (`a6d3fae`) | Verified (captured after fix) |
|---|---|---|---|
| D-01 | Roadmap → Optimize timing Infeasible on the default roadmap; the materialized `roadmap-kc-dc` was treated as already open. | `multi_period.py`: any site with an open event starts closed at Y0 (the event *is* the opening). | Fresh sample: choose_timing **Optimal NPV $119.79M** (CapEx $18.13M, OpEx $15.81M, transport $85.85M; all events Y5); force_timeline **Optimal NPV $128.36M** (CapEx $22.40M, OpEx $16.91M, transport $89.04M). After a Run (Reno closed): $116.44M / $125.01M. Headless Chrome light + dark. |
| D-02 | No-l9 diagnosed as `UNREACHABLE_DEMAND`; real blocker is `capacityMin`. | Relaxation probes: re-solve with minimums off / lane caps off; feasible relaxation ⇒ root cause. New `MIN_THROUGHPUT_CONFLICT` (sites, min vs feasible throughput, relaxed $ and service). Soft unreachable demand is kept as `info` context. | No-l9 (target 95 or 90): root cause `MIN_THROUGHPUT_CONFLICT` — *n2 min 10800 vs feasible 9200*; relaxed **91.8 %, $122.76M**. |
| D-03 | Lane-capacity infeasibility returned no hints. | New `LANE_CAPACITY_CONFLICT` (lane, from→to, cap vs required flow, short-by, customers). Both families reported when both bind. | l9 cap 1000: `MIN_THROUGHPUT_CONFLICT` (n2 min 10800 vs 10200) + `LANE_CAPACITY_CONFLICT` *l9 (n2→n6) cap 1000 vs needed 2280 (short 1280)*. |
| D-04 | Robust forced existing sites open and omitted SKUs/BOM. | `stochastic.py` v2: full Run model per scenario (open/close, SKUs, BOM, modes, cost scale); web sends the Run payload; Compare → Robust shows a basis note. `modelBasis: "legacy"` keeps the old model. | Built-in shocks: opens **n1, n2, n3** (Reno closes). E[cost] **$101.14M**, worst **$122.19M**, CVaR-lite (α 0.3) **$107.45M**, EVPI $0.00M. Base scenario **$98.27M** = Run. |
| D-05 | Carbon $ inconsistent with reported CO₂. | CO₂ reported per physical unit (×1,000 per model unit) so `carbonM = price × transportCo2Tonnes`; new `transportCo2Tonnes`, `carbonM` KPIs; CO₂ KPI = modelled transport CO₂. | Price 100: carbon **$197.3422M** = 100 × **1,973,422 t**; total $296.4632M. Price 0: 2,703.5 kt. |
| D-06 | `kpis.costM` excluded lane fixed. | `costM` += lane fixed; `kpis.laneFixedM`; Run status line shows lane fixed / carbon. | stress-200 KPI **$176.8M** (lane fixed $0.53M) = objective $176.81M. |
| D-07 | `maxFacilities` silently excluded plants. | `maxFacilities` = max **DCs + candidates** (always); optional `maxPlants`; Inspector label *Max DCs (open)* + help, Data snapshot *N DCs (plants not counted)*. | Max DCs 2 → $98.27M, n1 + n2 + n3 (plant + 2 DCs). `maxPlants: 0` with `optimizePlants` closes n1. |
| D-08 | Resilience flagged all 4 sites critical on Baseline. | Lane-aware reachability (radius **or** lane), DCs need plant supply, SPOF requires ≥ 0.5 pp drop **and** service below threshold. | Fresh Baseline, threshold 95: baseline svc **100 %**, score **35**, critical **Austin Plant (−100 pp)**, **Columbus DC (−33.2 pp)**; Atlanta, Reno 0 pp (not critical). |

### 11.3 Defects found in the hardening review (fixed in the working tree)

These are not in `8e2d909`; they are fixed but **uncommitted** at the time of writing. Nothing here changed a golden solve number.

| ID | Severity | Finding | Fix | Verified |
|---|---|---|---|---|
| D-09 | High | `/optimize` had no payload size cap and **no time limit on HiGHS** (only CBC got 60 s); an infeasible request then triggered 2–4 more full solves via the root-cause probes. | `flowform_engine/limits.py` guards every solve entry point before model build; `solverTimeLimitSec` (120 s default, clamped 1–600) reaches all adapters; per-worker solve slots (`MAX_CONCURRENT_SOLVES=2`) return **429 + Retry-After**. | `test_guards.py`; stress-200 still Optimal `$176.8118M` in 0.89 s. |
| D-10 | High | An explicit `capacityMax: 0` was treated as “unlimited”, so a facility declared unable to serve could serve anything for free. | `solver.py` distinguishes *missing* capacity (unlimited) from *explicit zero* (zero); both occurrences fixed. | `test_guards.py` — a zero-capacity network now serves nothing instead of everything. |
| D-11 | High | A solve stopped at the time limit returned a complete-looking, **zero-cost** network (PuLP leaves every variable at 0). | A non-optimal stop raises; HTTP returns **503** naming the limit and what to simplify. | `test_guards.py`; no change to optimal cases. |
| D-12 | High | Project saves were read-modify-write: two concurrent PUTs could both claim version *n+1* (unique-version violation or a lost write), and `updated_at` never advanced. | Compare-and-swap `UPDATE … WHERE current_version = :base`; `If-Match` → **409 + ETag**; `updated_at = now()` on save. | Two-thread race: `rowcounts [0, 1]`, exactly one winner, final version 2; `test_projects_api.py` covers `If-Match`. |
| D-13 | Medium | The run SSE stream had no deadline, no keep-alive, and raised if the run disappeared mid-stream. | 15-minute deadline (`RUN_EVENTS_MAX_S`) emitting `event: timeout`, 15 s comment heartbeat, `event: gone` on a vanished run, `poll_s` clamped. | `test_runs_api.py`; stream still ends with `event: done` on success. |
| D-14 | Medium | Unexpected exceptions were returned to the client (internals leaked), and `/optimize/validate` returned 500 for an unusable body. | One shared error mapping on every solve route (400/422/429/503/500, generic 500 with server-side log); the cheap validate path returns issues instead of raising. | `test_guards.py`. |
| D-15 | Medium | `pack_validation.py` claimed a parity test that did not exist; the two validators had drifted. | Fixture generated from the TypeScript validator (`npm run gen:pack-parity`) + `test_pack_validation_parity.py`; fixed Python `1`/`true` id collapse, TS `sites: "nope"` counting 4 sites, and string demand concatenation (`400250` → `650`). | 16 parity tests pass. |
| D-16 | Low | Nine scripts called `npx --yes tsx`, fetching an unpinned tool from the network on every CI run. | `tsx` is a pinned devDependency; scripts call it directly. | `npm ci` + `npm run test:data` + build green. |

---

## 12. Roadmap

**Done:** D-01…D-08 (`a6d3fae`), computed Baseline, group caps for SKUs, delete-lane, unit weights (`dcd1196`), roadmap on the Run basis (`6821f58`), then the platform programme: CI gates (`2a05d93`), golden harness (`87d7b7b`), engine package (`6a8f630`), Postgres/RLS + projects (`292abb6`, `4d18245`), async jobs (`964e3e5`), workspace sync (`f5cc5fa`), pre-run guardrails (`8732780`), onboarding (`5ee3c33`), run narrative (`2120782`), job routing in the web (`120ed36`), auth/RBAC + WorkOS (`8e2d909`), and the hardening pass (§11.3). Run leases and crash recovery (CR-004) are in the working tree: atomic claim, heartbeat, attempt-fenced finish, and the reaper. Shortfall tables now render in results (`ShortfallTables.tsx`), so the old “summary text only” gap is closed.

**Now (make the workspace safe to share):**
1. A real sign-in surface: token acquisition/refresh, organisation picker, and `If-Match` on the browser's sync writes so concurrent editors get 409 instead of silent overwrite.
2. Wire `pack_validation.py` to a route (or delete it) so server-side import validation has one owner; keep the parity fixture generated, never hand-edited.
3. Per-run/tenant quotas and an audit view over `AuditEvent`; the `/v1` tables already record every create/update/delete/run/cancel.

**Next (depth):**
4. Per-period CapEx budgets and per-SKU (not uniform) demand growth in multi-period; supplier-lane mode choice.
5. MIP-backed Greenfield (candidate generation + open decision in the MIP).
6. Map: self-hosted Protomaps; fix the headless MapLibre worker warning.
7. Collapse the duplicated TS/Python cost model behind one schema contract (§11.1 item 13).

**Later (product):**
8. Real share links and threaded comments (the current share and comment paths are local stubs).
9. Ritara intake adapter that consumes `flowform.handoff.v1` (contract only; no Ritara source copied).
10. Run scheduling/retention and a queue that is not `asyncio.run` per enqueue.

---

## 13. Depth-slice commit map (verified in `git log`)

| Commit | Slice | Verified in code |
|---|---|---|
| `9316434` | Fixed-charge multi-echelon MIP + BOM + capacities + objective breakdown + shadow prices | `solver.py` |
| `16eed36` | `enterprise-data-v1` pack, validation codes, scorecard | `enterprisePack.ts` |
| `c2dce5c` | stress-120/200 packs, MIP benchmarks, CTS fidelity, solve status chips | `test_stress_benchmark.py`, `TopChrome.tsx` |
| `b3ae4b9` | Multi-SKU flows, hard service + max lead time, infeasibility diagnostics | `solver.py`, `diagnostics.py` |
| `b98c336` | `POST /optimize/multi-period` NPV, Roadmap Optimize timing | `multi_period.py`, `RoadmapStudio.tsx` |
| `650098f` | `POST /optimize/stochastic` (expected/minimax/CVaR-lite, EVPI) in Compare Robust + Scenarios | `stochastic.py`, `CompareResults.tsx`, `ScenariosLibrary.tsx` |
| `33863ee` | Lane capacity + Truck/Rail/Intermodal mode choice, lane duals, flows-by-mode panel, red/amber lanes | `solver.py`, `MipLaneModes.tsx`, `laneMip.ts` |
| `e516c51` | Explain cards, counterfactual flip cost, real facility duals, `POST /optimize/explain`, Inspector + Brief + Compare | `explain.py`, `ExplainCards.tsx` |
| `1b2afc2` | Feasible sample (hazmat lane l9), realistic cost scaling ($M; off-lane ×1.35; penalty max($15, 10× median)) | `test_demo_cost_scaling.py` |
| `a6d3fae` | Defect fixes D-01…D-08, computed Baseline, group caps for SKUs, delete-lane | `test_defect_fixes.py`, `defectFixes.test.ts` |
| `6821f58` | Roadmap on the Run model basis | `multi_period_run.py`, `test_roadmap_run_basis.py` |
| `dcd1196` | Unit weights + realistic CO₂ | `test_unit_weights_co2.py` |
| `2a05d93` | CI: data tests, lint, typecheck, build, pytest, stress-200 gate | `.github/workflows/ci.yml` |
| `87d7b7b` | Golden harness (G-S, G-M120/200, G-INF, G-RMP, G-ROB, explain) | `test_golden.py`, `golden/cases.py` |
| `6a8f630` | Extract `flowform_engine` package with solver adapter (no result change) | `apps/engine/flowform_engine/` |
| `292abb6`, `4d18245` | Postgres/PostGIS tenancy + RLS, `/v1/projects` and scenarios CRUD | `alembic/versions/0001`, `app/v1/projects.py`, `test_auth_rbac.py` |
| `964e3e5` | Async run API + Redis/Arq worker behind a thin queue interface | `app/v1/runs.py`, `app/jobs/` |
| `f5cc5fa` | Mirror projects to `/v1` with local fallback, offline queue, one-click migration | `workspaceSync.ts`, `WorkspaceSyncPanel.tsx` |
| `8732780` | Pre-run guardrails (`/optimize/validate`) + shortfall tables | `validation.py`, `ShortfallTables.tsx` |
| `5ee3c33` | Four-question onboarding wizard → labelled starter model → first Run | `OnboardingWizard.tsx`, `data/onboarding.ts` |
| `2120782` | Plain-language Run narrative with traceable numbers | `RunNarrativeCard.tsx`, `data/narrative.ts` |
| `120ed36` | Web Run/Roadmap/Robust via the async job API, sync fallback | `jobsApi.ts`, `ActiveJobChip.tsx` |
| `8e2d909` | Auth core: JWT verification, tenant from claims, RBAC, WorkOS adapter (inert without keys) | `app/v1/auth.py`, `app/v1/workos.py` |
| *working tree* | Hardening pass D-09…D-16 (guards, time limit, capacity `0`, version CAS, SSE deadline, parity) | `limits.py`, `test_guards.py`, `test_pack_validation_parity.py` |
