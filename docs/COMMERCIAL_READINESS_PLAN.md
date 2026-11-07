# Flowform — Commercial Readiness Plan

**Status:** Active plan of record for the commercial SaaS track.
**Baseline:** `master` @ `8e2d909` + the uncommitted hardening pass, reviewed 6 Nov 2026.
**Owner:** Jigar Parekh
**Companions:** [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md) (module requirements and target architecture) · [`MASTER_BLUEPRINT.md`](MASTER_BLUEPRINT.md) (what exists today) · [`MANUAL_TEST_WORKBOOK.md`](MANUAL_TEST_WORKBOOK.md) (UAT).

> This plan **re-baselines the commercial track** from the 18 Oct 2026 plan. The module requirements in `IMPLEMENTATION_PLAN.md` §7 remain authoritative for product depth. This document changes the sequencing, the commercial gates, and the definition of done: **platform trust before feature breadth**.

---

## 1. Goal: 9.5/10 with evidence, not 10/10 by assertion

A literal 10/10 would require years of operating history, referenceable customers, and a zero-incident record. The commercial target is **9.5/10 with auditable evidence**:

- SOC 2 Type II report issued.
- 90 days of measured 99.9% availability against published SLOs.
- Zero open Sev-1/Sev-2 defects; pen-test high/critical findings closed.
- 5k-customer interactive and 50k-customer batch benchmarks met.
- Paying customers who self-onboarded and renewed.
- Scorecard total ≥ 9.5 with evidence, not self-assessment.

### Commercial scorecard

Scores are 0–10. Weights sum to 100%. "Evidence" is what an auditor or customer would accept.

| Dimension | Weight | Now | Target | Evidence required for 9.5 |
|---|---:|---:|---:|---|
| Security & compliance | 20% | 4.5 | 9.5 | SOC 2 Type II, pen test clean, IR exercises, encryption/KMS, vulnerability SLAs, access reviews |
| Reliability & operations | 15% | 5.0 | 9.5 | 99.9% over 90 days, run recovery, PITR backups, DR drill (RPO ≤ 15 min / RTO ≤ 4 h), status page, on-call |
| Data durability & tenancy | 15% | 5.5 | 9.5 | Server-authoritative state, versioning, quotas, retention, export/delete, cross-tenant isolation tests |
| Auth & access | 10% | 5.0 | 9.5 | Sign-in/logout/refresh, SSO/SAML/SCIM, role management, session policy, audit export |
| Core modeling & scale | 15% | 9.0 | 9.5 | Goldens intact, 5k interactive / 50k batch, cross-solver checks, no fake optima |
| Product completeness & UX | 15% | 7.0 | 9.5 | No stubs in paid paths, MIP greenfield, tariffs, inventory in MIP, real sharing/approvals, WCAG 2.1 AA |
| Quality engineering | 5% | 7.5 | 9.5 | Strict TS, Python type-checking, coverage gates, E2E, contract tests, no flaky suites |
| Commercial operations | 5% | 3.0 | 9.5 | Billing, trials, entitlements, tax, DPA, SLA, support, trust center |
| **Weighted total** | **100%** | **≈ 6.0** | **9.5** | |

The 6.5 in the 6 Nov review was engineering-weighted. This stricter scorecard includes billing, legal, and operations, which is why it lands near 6.0. The gap is the same either way: **the engine is ahead; the platform and commercial operations are behind.**

---

## 2. Current position

### 2.1 Strengths to protect

- Fixed-charge multi-echelon MIP with multi-SKU, BOM, lane modes, multi-period NPV, stochastic designs, real duals, and counterfactual explainability.
- 133 API tests passing, golden snapshots with tolerance, TS↔Python validator parity, RLS isolation tests, stress benchmarks (~0.9 s for stress-200).
- Unusually candid documentation and a real manual UAT workbook.
- Clean engine/API/web separation, solver adapter, queue interface, compare-and-swap project versioning.

### 2.2 What blocks a commercial score

| Blocker | Where it shows up | Commercial impact |
|---|---|---|
| Uncommitted hardening pass | 23 changed/untracked paths; docs describe fixes that CI does not protect | Work loss and unverifiable claims |
| TypeScript not strict | [`tsconfig.app.json`](../apps/web/tsconfig.app.json), [`tsconfig.node.json`](../apps/web/tsconfig.node.json) | Runtime null bugs in a 29k-line UI |
| No error boundary | [`main.tsx`](../apps/web/src/main.tsx) | One render error blanks the studio |
| Dev auth + incomplete auth UI | [`auth.py`](../apps/api/app/v1/auth.py), [`workos.py`](../apps/api/app/v1/workos.py), [`docker-compose.yml`](../docker-compose.yml) | Unsafe shared deployments; no end-user sign-in |
| No run recovery | [`queue.py`](../apps/api/app/jobs/queue.py) | Runs stuck `queued`/`running` forever after restart |
| Unbounded project bodies/versions | [`projects.py`](../apps/api/app/v1/projects.py#L22) | Tenant storage abuse; no retention |
| localStorage-first state | [`projects.ts`](../apps/web/src/data/projects.ts), [`workspaceSync.ts`](../apps/web/src/data/workspaceSync.ts) | Data loss on browser clear; last-write-wins overwrites |
| No observability/SLOs | `/health` only | Cannot operate or prove reliability |
| No billing/legal/trust | none | Cannot charge or pass procurement |
| Stubs in visible paths | Share, comments, ⌘K, Greenfield, composed scenarios | Paid users hit non-functional surfaces |
| No URL routing | [`App.tsx`](../apps/web/src/App.tsx#L32) | No deep links or reviewable Compare URLs |
| Unpinned Python deps | [`requirements.txt`](../apps/api/requirements.txt) | Solver drift and non-reproducible builds |

---

## 3. Strategy

1. **Platform before features.** Freeze engine breadth except for the gaps customers pay for, until the platform is trustworthy.
2. **Buy commodity, build differentiation.** WorkOS for identity, Stripe for billing, a compliance-automation platform, managed Postgres/Redis, Protomaps for tiles. Build the model, explainability, and workflow.
3. **Evidence over claims.** No "SOC 2" language before the report. No scale claim without a benchmark. No "enterprise-ready" without SSO, audit, and DR.
4. **One deployment shape first.** US region, managed cloud, single production stack. Add EU residency and multi-region only after GA economics justify it.
5. **Narrow the paid promise.** The first commercial offer is network design + explainability + handoff, not APS, not full DES, not a connector marketplace.

---

## 4. Commercial gates

Dates assume an 8–10 person team and a start on **9 Nov 2026**. They are planning targets, not commitments.

| Gate | Window | Theme | Exit criteria |
|---|---|---|---|
| **G1 — Safe to invite** | Weeks 1–4 · Nov 9 – Dec 4, 2026 | Harden the spine | Hardening pass committed; CI required; TS strict; error boundary; run reaper; auth completion; snapshot caps; observability baseline; Playwright smoke; no open P1 |
| **G2 — Safe to charge** | Weeks 5–14 · Dec 7, 2026 – Feb 12, 2027 | Sellable product | Server-authoritative projects; real share links; Stripe billing/trials/metering; 5 design partners; TTFI < 30 min; first revenue; solve success ≥ 99.5% |
| **G3 — Enterprise-ready** | Weeks 15–26 · Feb 15 – May 7, 2027 | Trust & scale | SOC 2 Type I; pen-test highs closed; SSO/SCIM self-serve; 5k/50k benchmarks; DR; connectors; handoff v2 |
| **G4 — GA** | Weeks 27–38 · May 10 – Jul 30, 2027 | Harden for launch | 99.9% for 30 days; WCAG 2.1 AA; zero Sev-1/2; 98% workbook; support SLAs; canary/release train |
| **G5 — 9.5 evidence** | Weeks 39–48 · Aug 2 – Oct 8, 2027 | Prove it | SOC 2 Type II; 90-day SLO evidence; four consecutive KPI weeks; referenceable customers; scorecard ≥ 9.5 |

**SOC 2 critical path:** controls must exist before the observation window. Start the readiness programme in G1, engage the auditor in G2, issue Type I in G3, and start the Type II window no later than Feb 2027. The report lands in G5.

---

## 5. Workstreams and backlog

Sizes: **S** ≤ 3 eng-days · **M** ≤ 1.5 eng-weeks · **L** ≤ 3 eng-weeks · **XL** > 3 eng-weeks. Status values: `Todo`, `In progress`, `Done`, `Already in place`.

### A. Platform reliability and security

| ID | Item | Gate | Size | Status | Acceptance |
|---|---|---|---|---|---|
| CR-001 | Commit the hardening pass and protect `master` with required checks | G1 | S | In progress | CI runs API+Postgres, web data tests, lint, typecheck, build, stress smoke; branch protection on. *Committed; the five checks still have to be marked required on `master` (a repo setting, not a file change).* |
| CR-002 | Enable TypeScript `strict` and typecheck test files | G1 | S | Done | `tsc -b` strict clean; test files covered by `tsconfig.test.json` |
| CR-003 | Top-level error boundary and client error reporting | G1 | S | Done | Recovery UI plus one reporting seam: ErrorBoundary, `window.error` and `unhandledrejection` all report through `data/reporting.ts`; optional Sentry sink behind `VITE_SENTRY_DSN`, off by default with a lazy chunk, payload scrubbed and de-duplicated; 8 test groups |
| CR-004 | Stale-run reaper and idempotent enqueue | G1 | M | Done | Atomic claim + heartbeat + attempt-fenced finish; reaper requeues once then fails with an "interrupted" message; lost queue messages re-dispatched; 10 tests cover duplicate delivery, concurrent delivery, crash, retry limit, fencing, cancel, and sweep idempotence |
| CR-005 | Snapshot body cap, tenant quotas, and version retention | G1 | M | Done | Body → 413 (5 MiB); project quota, version retention (newest 50) and tenant storage cap enforced inside the write transaction → 403 with `X-Quota-Limit`; retention policy documented; 12 tests |
| CR-006 | Observability baseline: OTel, Sentry, request IDs, DB/Redis health | G1 | M | Done | Request IDs on every response + log line; `/livez` vs `/readyz` (DB/queue, deployment-aware, bounded and cached); Sentry with credential scrubbing; OTLP traces incl. a `run.execute` span; run lifecycle logs; `/metrics` with HTTP/run/queue/reaper/readiness series and no customer labels; 10 SLO alert rules unit-tested with promtool (firing and quiet cases) and run in CI. Dashboards still have to be imported per environment from the documented expressions |
| CR-007 | Rate limits and per-tenant solve quotas | G2 | M | Todo | 429 with Retry-After; quotas by plan; solve slots per worker and per tenant |
| CR-008 | Backup/PITR and restore drill | G3 | M | Todo | Restore proven; RPO/RTO recorded; runbook linked |
| CR-009 | DR and chaos exercises | G4 | M | Todo | Region/AZ failure drill; documented gaps closed |

### B. Identity, tenancy, and data

| ID | Item | Gate | Size | Status | Acceptance |
|---|---|---|---|---|---|
| CR-010 | Sign-in/logout/refresh, org picker, role surface | G1 | L | Done | Account menu with sign-in, sign-out, refresh, role badge and organisation switcher; `/auth/callback` route; `/v1/auth/me` wired; access token in memory, refresh token in `sessionStorage` (never `localStorage`); viewers cannot start runs |
| CR-011 | WorkOS hardening: audience/azp, state nonce, redirect allowlist | G1 | M | Done | Signed 10-min state bound to an allowlisted redirect; invalid/expired/forged state and unlisted or open-redirect targets rejected before WorkOS; `client_id`/`azp` must match; tokens `no-store`; 14 API tests + 11 web session checks |
| CR-012 | Remove dev auth from any shared deployment | G1 | S | Done | Dev headers accepted only from loopback peers with no proxy header (`DEV_AUTH_ALLOW_REMOTE=1` for the loopback-bound Compose stack); startup `DEV AUTH`/`DEV AUTH EXPOSED` warning; `/v1/auth/config` exposes the warning and the account menu shows it; 2 tests |
| CR-013 | Server-authoritative projects + localStorage migration | G2 | L | Todo | Server is source of truth; offline cache; one-click migration; conflict UI |
| CR-014 | `If-Match` on client writes and 409 conflict handling | G2 | M | Todo | Concurrent edit yields 409 + reload/merge path; no silent overwrite |
| CR-015 | Real read-only share links and viewer | G2 | L | Todo | `flowform://` stub replaced; scoped token; revoke; audit |
| CR-016 | SSO/SAML/SCIM, RBAC v2, project ACLs, audit export | G3 | L | Todo | Admin configures IdP from docs only; audit export; role matrix tests |
| CR-017 | Data export/delete and retention controls | G3 | M | Todo | Tenant export; delete within SLA; retention documented |

### C. Commercial operations

| ID | Item | Gate | Size | Status | Acceptance |
|---|---|---|---|---|---|
| CR-018 | Stripe billing, trials, entitlements, usage metering, tax | G2 | L | Todo | Self-checkout to unlocked entitlements < 2 min; invoices; dunning; solver-minute meter |
| CR-019 | Legal pack: ToS, privacy, DPA, subprocessors, SLA | G2 | M | Todo | Published and linked in-app; security contact |
| CR-020 | Pricing page and onboarding funnel analytics | G2 | M | Todo | TTFI/activation dashboards; consent; event taxonomy |
| CR-021 | Support desk, status page, incident comms | G2 | M | Todo | Async support SLA; public status; incident template |
| CR-022 | Trust center and security questionnaire | G3 | M | Todo | SOC 2 status, architecture, data flow, subprocessors, pen-test summary |

### D. Product completeness

| ID | Item | Gate | Size | Status | Acceptance |
|---|---|---|---|---|---|
| CR-023 | URL router, deep links, reviewer mode | G2 | M | Todo | Every room has a URL; refresh preserves room; Compare/Brief shareable |
| CR-024 | MIP-backed Greenfield and supplier-lane mode choice | G2 | L | Todo | G-GF matches exhaustive search; supplier flows carry `laneId`/`mode` |
| CR-025 | Tariffs/landed cost, inventory in MIP, seasonality, Pareto | G2–G3 | XL | Todo | Each has a golden; inventory pooling and duty hand-checks pass |
| CR-026 | Remove or clearly label remaining stubs | G2 | S | Todo | No stub in a paid path; beta labels where needed |
| CR-027 | Server comments, approvals, notifications | G3 | M | Todo | Reviewer sign-off recorded; handoff only from approved scenario |

### E. Scale and integrations

| ID | Item | Gate | Size | Status | Acceptance |
|---|---|---|---|---|---|
| CR-028 | 1k/5k benchmarks, queue backpressure, quotas | G2 | M | Todo | Published runtimes; queue p95 targets; no unbounded growth |
| CR-029 | 50k batch, decomposition, commercial solver adapters | G3 | XL | Todo | XXL benchmark within target; cross-solver agreement |
| CR-030 | Connectors: Snowflake, Databricks, Excel; ERP extracts later | G3 | L | Todo | Two connectors in production; mapping templates |
| CR-031 | Handoff v2: schema registry, API, webhooks | G3 | L | Todo | Contract tests; v1 consumers unaffected |

### F. Quality, accessibility, and compliance

| ID | Item | Gate | Size | Status | Acceptance |
|---|---|---|---|---|---|
| CR-032 | Playwright critical-path smoke | G1 | M | Done | Auth → project → run → compare → brief → share; light/dark; CI |
| CR-033 | axe/WCAG 2.1 AA audit and fixes | G2 | M | Todo | axe clean on main rooms; keyboard completion of a playbook |
| CR-034 | Python type checking and dependency lockfiles | G1 | M | Done | mypy clean on the API (25 modules); hash-checked app and dev locks; solver pins enforced by tests |
| CR-035 | OpenAPI/JSON Schema contract tests | G2 | M | Todo | Enterprise pack and handoff schemas validated in CI |
| CR-036 | Load/soak/performance budgets | G3 | M | Todo | API p95, queue wait, LCP, 50k map rendering |
| CR-037 | Pen test, SAST/DAST, dependency/vuln management | G3 | L | Todo | Highs closed; scans on every PR; disclosure policy |
| CR-038 | SOC 2 Type I then Type II | G3–G5 | XL | Todo | Type I issued; Type II window complete; report |
| CR-039 | Docs drift, runbooks, generated reference numbers | G1 | S | Done | Stale stress-120/200 values corrected; machine-specific paths removed |

---

## 6. First 30 days

### Week 1 — protect the work and stop blank screens

- ~~Commit CR-001~~ **Committed** — the hardening pass is in seven reviewable commits; turn on the required CI checks to close it.
- CR-002: strict TS (the codebase currently passes full `--strict`; make it permanent).
- CR-003: error boundary and a reporting seam.
- ~~CR-005: snapshot body cap, quotas, retention.~~ **Done** — see §11.
- CR-039: fix captured-number drift and machine-specific runbook paths.

### Week 2 — make runs and tenancy durable

- CR-004: startup reaper + idempotent enqueue. *(Done — see §11.)*
- ~~CR-012: dev-mode guard.~~ **Done** — see §11. CR-010/CR-011 also landed early.
- ~~CR-034: Python type-check and lockfile.~~ **Done** — see §11.

### Week 3 — make it observable and testable

- ~~CR-006: OTel/Sentry/request IDs, metrics, readiness checks, alert rules.~~ **Done** — see §11 (dashboards remain environment-side).
- ~~CR-032: Playwright smoke for the core path.~~ **Done** — see §11 (WorkOS sign-in itself stays a manual/staging check).
- Security baseline: secret/dependency/container/SAST scanning, threat model, IR runbook.

### Week 4 — prove Gate 1

- Close remaining P1 findings.
- Run the manual smoke and the automated path against a staging deploy.
- Invite the first 2–3 design partners under NDA.
- Gate review: G1 exit criteria met or explicitly waived.

---

## 7. Schedule

| Phase | Weeks | Calendar | Main outcome |
|---|---:|---|---|
| G1 | 1–4 | Nov 9 – Dec 4, 2026 | Safe to invite |
| G2 | 5–14 | Dec 7, 2026 – Feb 12, 2027 | Safe to charge |
| G3 | 15–26 | Feb 15 – May 7, 2027 | Enterprise-ready |
| G4 | 27–38 | May 10 – Jul 30, 2027 | GA |
| G5 | 39–48 | Aug 2 – Oct 8, 2027 | 9.5 evidence |

**Critical path:** SOC 2 controls → Type I → Type II window; pen test; billing/legal; 5k/50k scale proof; 90-day SLO evidence. Engineering can finish earlier; the evidence window sets the date.

---

## 8. Team and cost

| Role | FTE | Notes |
|---|---:|---|
| Product owner | 1 | Not counted in engineering effort |
| Tech lead / architect | 1 | Platform + engine boundary |
| Backend / platform | 2 | Auth, tenancy, jobs, billing, integrations |
| Frontend | 2 | Router, auth UI, sharing, accessibility |
| OR / optimization | 1 | Greenfield, tariffs, inventory, scale |
| SRE / DevOps | 1 | Cloud, observability, DR, security operations |
| QA / SDET | 1 | E2E, goldens, workbook automation |
| Product design | 0.5 | Reviewer mode, onboarding, accessibility |
| Security / compliance | 0.5 | SOC 2, pen test, policies |

- **Remaining effort:** roughly 300–380 engineer-weeks.
- **Engineering cost:** roughly **$0.7M–$1.3M** at a blended nearshore/offshore mix.
- **Non-engineering:** roughly **$100k–$250k** for cloud, compliance automation, SOC 2 audits, pen testing, identity, and legal.
- These are planning ranges, not quotes. The 18 Oct plan's §11 remains the detailed cost basis.

**Faster path:** 6 months is possible only by narrowing to US-only, Pro/Team self-serve, no ERP connectors, no EU residency, no 50k scale, and no real-time collaboration. That reaches roughly **9.0**, not 9.5. Choose the promise deliberately.

---

## 9. Risks

| Risk | Likelihood / impact | Mitigation |
|---|---|---|
| SOC 2 Type II timing slips past GA | Medium / High | Start controls in G1; auditor in G2; Type I in G3; window starts Feb 2027 |
| Auth/data migration breaks existing projects | Medium / High | Adapter layer, localStorage fallback, migration test on samples, workbook regression |
| Billing/legal delays first revenue | Medium / Medium | Start Stripe + legal in G2 week 1; use standard DPA/SLA templates |
| Scale promises outrun benchmarks | Medium / High | Publish only measured limits; gate sales on benchmark evidence |
| Engine scope creep delays platform | High / Medium | Freeze engine except CR-024/CR-025; product owner approves exceptions |
| Key-person risk in solver/explain code | Medium / High | Pair ownership, ADRs, recorded walkthroughs, golden harness |
| Security incident before controls mature | Low / Very high | Least privilege, RLS, secret scanning, IR runbook, pen test early |
| Stubs erode trust with paying users | Medium / Medium | CR-026: label or remove before charging |

---

## 10. Definition of done (near-10)

- [ ] Scorecard ≥ 9.5 with evidence.
- [ ] SOC 2 Type II report issued; pen-test highs closed.
- [ ] 99.9% availability over 90 days; DR drill passed.
- [ ] SSO/SAML/SCIM self-serve; RBAC/audit export; tenant isolation proven.
- [ ] 5k interactive and 50k batch benchmarks met.
- [ ] No stubs in paid paths; WCAG 2.1 AA; E2E critical path green.
- [ ] Billing, tax, DPA, SLA, support, status page live.
- [ ] Four consecutive weeks at KPI targets; zero open Sev-1/Sev-2.
- [ ] Referenceable paying customers and renewals.

---

## 11. Change log

| Date | Change |
|---|---|
| 2026-11-06 | Plan created; scorecard and gates baselined against the 6 Nov review. |
| 2026-11-06 | CR-002 strict TS + test typechecking enabled; CR-003 error boundary added; CR-005 snapshot cap added (6 tests); CR-039 docs drift and machine paths fixed. |
| 2026-11-06 | CR-004 run leases and recovery: migration 0003 (`attempts`, `started_at`, `heartbeat_at`, `dispatched_at`), atomic claim, heartbeat thread, attempt-fenced finish, periodic/CLI reaper, attempt-scoped Arq job ids, and 10 Postgres tests. Full API suite with Postgres: 174 passed, 1 skipped. |
| 2026-11-06 | CR-012 dev-mode guard: loopback/proxy-header check on the dev bypass, `DEV_AUTH_ALLOW_REMOTE` for the Compose stack, startup warning + config/UI warning, Compose ports bound to `127.0.0.1`. 2 tests. |
| 2026-11-06 | CR-006 metrics + alerting: `/metrics` (HTTP by route template/status, latency, run outcomes/duration/queue wait, reaper outcomes, readyz status/failures, stuck-runs gauge refreshed by the reaper), optional bearer token, 14 metric tests, and 10 Prometheus rules with promtool unit tests wired into CI. CR-006 marked Done; only per-environment dashboards remain. |
| 2026-11-06 | CR-006 observability baseline: `X-Request-ID` on every response with a sanitised inbound value, request-id log field, access log, `/livez` vs `/readyz` (deployment-aware DB/queue checks, 2 s bound and cache, no DSN leakage), optional Sentry with PII/credential scrubbing, optional OTLP tracing with `run.execute` spans for inline and Arq jobs, and run.create/start/finish lifecycle logs. 9 tests; traced a real request to a local OTLP receiver. Metrics and a deployed SLO dashboard remain. |
| 2026-11-07 | CR-005 quotas and retention: `apps/api/app/quotas.py` adds per-tenant limits read per request (`MAX_PROJECTS_PER_TENANT` 100, `MAX_VERSIONS_PER_PROJECT` 50, `MAX_TENANT_STORAGE_BYTES` 512 MiB; invalid values fall back rather than becoming unlimited). Saves prune versions older than the newest N in the writing transaction, then check the tenant's stored bytes, so compaction and the cap cooperate and the whole write — version bump, version row, audit event — rolls back on refusal. Refusals are `403` with `X-Quota-Limit: projects|storage` and an actionable detail, distinct from `413` (one body too large) and `409` (stale base version). The web banner now treats that `403` as "workspace limit reached" instead of "not signed in" and keeps the unsaved project local. 12 API tests (project quota, retention window, storage cap rollback, retention-before-cap ordering, settings parsing) plus a sync test for the banner. Full API suite: 235 passed, 1 skipped. |
| 2026-11-07 | CR-003 client error reporting: `apps/web/src/data/reporting.ts` is the single seam for render errors, uncaught errors and unhandled rejections, with an optional Sentry browser sink behind `VITE_SENTRY_DSN` (no DSN = no network, and the 424 kB SDK chunk is never fetched — verified in the built output). Reports carry a message, origin+path only, a source tag and scalar extras; bearer tokens, JWTs, OAuth `code`/`state` and `flowform://share` payloads are redacted, Sentry's PII/header/cookie/body collection is off and its own global handlers are disabled so each error is captured once. Duplicate reports are dropped for 5 s, up to 12 buffer while the chunk loads, a throwing sink cannot break the app, and `console` keeps the stack in local development. 8 test groups (`npm run test:reporting`), typecheck, lint, build and the Playwright smoke still green. |
| 2026-11-07 | CR-034 type gate and dependency locks: mypy over all 25 API modules (`apps/api/pyproject.toml`, `check_untyped_defs`), fixing 16 real type errors rather than silencing them (`Result.rowcount` casts, an `Options` TypedDict for PyJWT, a `list` return annotated as `dict` in the org endpoint, a `str | None` Redis URL, pydantic union fields); `requirements.in` → `requirements.txt` lock, 64 packages pinned with SHA-256 hashes, plus a hashed dev-tools lock; `scripts/lock-requirements.sh` resolves on `python:3.12-slim` so the lock matches CI and the image; PuLP 2.9.0 / HiGHS 1.15.1 pinned exactly in both the engine and the API and enforced by 9 tests. CI now installs from the lock, installs the engine with `--no-deps`, and runs mypy before pytest. Verified: the lock installs and imports the app on `python:3.12-slim`, and pip rejects a tampered hash. The engine itself is not type-checked yet (~113 existing errors). One finding for the golden harness: on linux/**arm64** the G-EXP-M200 counterfactual for `dc-7` re-solves to a delta of $6.6415M instead of $6.6312M (a tie-break in a degenerate re-solve; decision and headline are unchanged), while macOS and linux/x86_64 — what GitHub's runners are — match the golden. Worth a per-field tolerance or an arm64-specific note before anyone develops on an Apple-silicon container. |
| 2026-11-07 | CR-032 E2E smoke: Playwright boots the real API (`AUTH_MODE=dev`, inline queue) and web server and drives auth surface → project → async run → compare → brief export → share download, asserting tenant isolation, the 202 job path, and both themes; added to CI as its own job with traces on failure. 2 specs. |
| 2026-11-07 | CR-001 history: the hardening pass is committed in reviewable chunks — engine limits and pack parity, strict TS/typecheck, WorkOS auth core, run leases and the reaper, observability (request IDs, probes, metrics, alert rules, client reporting), snapshot caps/quotas/retention, the web sign-in surfaces, the Playwright smoke, the CI gates and this documentation set. `mypy` clean, web typecheck and data tests green, API suite 156 passed / 9 skipped without a database. CR-001 stays `In progress` until `master` requires the five CI checks in GitHub. |
| 2026-11-06 | CR-010/CR-011 auth surfaces and hardening: signed state + redirect allowlist + `client_id`/`azp` check on the API; refresh, WorkOS session logout and organisation listing endpoints; web session layer with transparent refresh on 401, `/auth/callback` route, account/org/role menu and viewer action gating. 14 API tests, 11 web session checks. |
