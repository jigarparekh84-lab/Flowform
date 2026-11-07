# Observability baseline (CR-006)

> Code: [`observability.py`](../apps/api/app/observability.py) · health: [`health.py`](../apps/api/app/health.py) · metrics: [`metrics.py`](../apps/api/app/metrics.py) · alert rules: [`ops/prometheus/`](../ops/prometheus) · tests: [`test_observability.py`](../apps/api/tests/test_observability.py), [`test_metrics.py`](../apps/api/tests/test_metrics.py)

Flowform emits the signals an on-call engineer needs before this can be sold: a
**support id on every request**, a **health signal that means something**,
**error/trace export that is off unless configured**, and **metrics plus alert
rules** so the SLOs page someone instead of sitting in a document.

Everything is optional. With no `SENTRY_DSN` and no OTLP endpoint the API logs
structured lines to stdout, serves `/metrics` on localhost and behaves exactly as
before — no collector, no DSN, no outbound network.

---

## 1. What is emitted

| Signal | Always on? | Where |
|---|---|---|
| `X-Request-ID` response header | yes | every HTTP response, including 401/403/500 and CORS preflight |
| `request_id=` log field | yes | all `flowform*` loggers (API, jobs, health, observability) |
| Prometheus metrics | yes (404 with `METRICS_ENABLED=0`) | `GET /metrics` |
| Sentry events | only with `SENTRY_DSN` | exceptions, unhandled 500s, optional performance traces |
| OTLP spans | only with `OTEL_EXPORTER_OTLP_ENDPOINT` | HTTP/ASGI spans + `run.execute` for solves |
| Readiness detail | yes | `GET /readyz` |

### Request ids

- Inbound `X-Request-ID` is reused **only** when it matches `^[A-Za-z0-9._:-]{8,128}$`.
  Anything else (spaces, non-ASCII, over-long, too short) is replaced with a
  fresh 32-hex id, so a caller cannot forge or inject into log output.
- The id is bound with a `contextvar` (not threaded through every function), so
  any log line written while handling the request carries it.
- Sentry events are tagged `request_id`. `/readyz` returns it in the body too.
- The web client can read the header (`CORSMiddleware: expose_headers`), so an
  error toast can show "quote this id to support".

**Support workflow:** ask for the `X-Request-ID` (or the Sentry event tag), then

```bash
# API logs
grep 'request_id=<id>' /var/log/flowform-api.log

# Sentry: search "request_id:<id>"

# Traces (Tempo/Jaeger): search tag request_id? traces are joined by time +
# HTTP route; logs are the primary id lookup.
```

### Logs

```
2026-11-06 20:46:44,302 INFO flowform.api request_id=28fe3f9e… GET /v1/projects → 200 12ms
```

| Setting | Default | Meaning |
|---|---|---|
| `LOG_LEVEL` | `INFO` | level of the `flowform` logger |
| `HTTP_REQUEST_LOG` | `1` | one line per request; `/health`, `/livez`, `/readyz`, `/metrics` are excluded |

No request/response bodies are logged, and auth headers are never logged. The
logger writes to stderr; ship stdout/stderr with your platform's log agent.

A run is traceable from one id even without a collector:

```
INFO flowform.api   request_id=… run.create run=<id> kind=optimize scenario=None
INFO flowform.jobs  request_id=- run.start run=<id> attempt=1 kind=optimize
INFO flowform.jobs  request_id=- run.finish run=<id> attempt=1 status=succeeded in 842ms
WARN flowform.jobs  request_id=- run <id> lost its lease before the result was stored; discarding
```

Job lines carry `request_id=-` because they run outside a request; the run id
is the join key there.

---

## 2. Liveness vs readiness

| Endpoint | Question | Dependencies | Status codes |
|---|---|---|---|
| `/livez` | Is the process alive? | none | always `200` |
| `/readyz` | Can this deployment do its job? | DB and/or queue (see below) | `200` ready · `503` not ready |
| `/health` | legacy liveness alias (web probe, Docker healthcheck) | none | always `200` |

`/health` is intentionally unchanged so existing checks keep working. New
deployments should use `/livez` for liveness and `/readyz` for readiness.

### Deployment-aware readiness

A solve-only API does not need Postgres. Requiring it would make a perfectly
healthy optimizer look unready, so the database check follows the deployment:

| Deployment | Database check | Queue check |
|---|---|---|
| `AUTH_MODE=off`, `QUEUE_BACKEND=inline` | `not_required` | `ok (inline)` |
| `AUTH_MODE=dev\|jwt\|workos` | required (`SELECT 1`) | `ok (inline)` |
| `QUEUE_BACKEND=arq` | required | `PING` to `REDIS_URL` |
| `QUEUE_BACKEND=manual` (tests) | per `AUTH_MODE` | `ok (manual)` |

Override the DB requirement with `READYZ_REQUIRE_DB=1` (force) or `0` (never).

### Bounds and failure output

- `READYZ_TIMEOUT_S` (default `2`) bounds each check; DB connections use
  `connect_timeout`, Redis uses socket timeouts.
- `READYZ_CACHE_S` (default `2`) caches the answer so a 1-second probe cadence
  cannot exhaust connections. Cached answers are **not** re-counted in the
  failure metric, so one outage is one event, not one per scrape.
- Responses contain only `ok` / `not_required` / `timeout after Ns` /
  `error: ExceptionClass` — never a DSN, password or stack trace. The full error
  is logged at `WARNING` with the request id.

Example response:

```json
{
  "status": "not_ready",
  "service": "flowform-api",
  "checks": {"database": "error: OperationalError", "queue": "ok (inline)"},
  "requestId": "28fe3f9e274e4a488dbfaca6d75a1fad"
}
```

Kubernetes probes:

```yaml
startupProbe:
  httpGet: { path: /livez, port: 5182 }
  failureThreshold: 30
  periodSeconds: 2
livenessProbe:
  httpGet: { path: /livez, port: 5182 }
  periodSeconds: 10
  failureThreshold: 3
readinessProbe:
  httpGet: { path: /readyz, port: 5182 }
  periodSeconds: 10
  timeoutSeconds: 3
  failureThreshold: 3
```

---

## 3. Sentry (errors)

Set `SENTRY_DSN` on the API (server-side secret — never in web assets):

| Setting | Default | Meaning |
|---|---|---|
| `SENTRY_DSN` | — | enables reporting; unset = off |
| `SENTRY_ENVIRONMENT` / `APP_ENV` | — | environment tag |
| `SENTRY_RELEASE` / `APP_RELEASE` | — | release tag |
| `SENTRY_TRACES_SAMPLE_RATE` | `0` | Sentry performance traces |

Privacy defaults are deliberate:

- `data_collection={"user_info": False, "cookies": off, "url_query_params": off,
  "http_headers": off, "http_bodies": [], "stack_frame_variables": False}` and
  `max_request_body_size="never"` — a project snapshot is a customer's whole
  supply-chain plan and must never leave the server. On sentry-sdk versions
  without `data_collection` (< 2.7x) the code falls back to
  `send_default_pii=False`, so both branches collect nothing by default.
- `before_send` / `before_send_transaction` scrub:
  - request **headers**: `Authorization`, `Cookie`, `Set-Cookie`, `X-API-Key`,
    `Proxy-Authorization`, every `X-Dev-*`;
  - request **data**, **cookies** and **query string** (auth codes and refresh
    tokens live there);
  - adds `request_id` as a tag.
- A bad DSN logs an error and continues; error reporting never blocks startup.

### Browser errors (web)

The studio reports render errors, uncaught errors and unhandled rejections
through one seam in [`apps/web/src/data/reporting.ts`](../apps/web/src/data/reporting.ts).
It is **off by default** — without a DSN nothing leaves the browser and the SDK
chunk is never fetched:

| Setting | Default | Meaning |
|---|---|---|
| `VITE_SENTRY_DSN` | — | enables browser reporting; unset = console only |
| `VITE_SENTRY_ENVIRONMENT` | — | environment tag |
| `VITE_SENTRY_RELEASE` (`VITE_APP_RELEASE` fallback) | — | release tag |

Use a **separate Sentry project (or DSN) from the API**: a browser DSN is public
by construction, while the API DSN is a server secret. Restrictions that make a
browser DSN safe to ship belong on it (allowed origins, rate limits).

Privacy defaults:

- A report is a message, a scrubbed URL, a source tag (`error-boundary`,
  `window.error`, `unhandledrejection`), scalar extras and React's component
  stack. Project snapshots, storage and form values are never included.
- The URL keeps origin + path and drops query and hash (OAuth `code`/`state`,
  share payloads). Free text is scrubbed of `Bearer` tokens, JWTs and
  `access_token`/`refresh_token`/`token`/`code`/`state`/`key`/`secret`/`password`
  query values; `beforeSend` applies the same redaction again.
- `sendDefaultPii: false`, no performance traces, and Sentry's own
  `GlobalHandlers`/`BrowserApiErrors` integrations are disabled so the seam owns
  capture (one scrubbed report, not two).
- Identical reports de-duplicate for 5 s; up to 12 are buffered while the SDK
  chunk loads, then flushed. A failing sink is logged once and contained.

Not covered yet: RUM/performance data and session replay, a web `request_id`
tag linking a browser error to its API log line, and log-to-error linking beyond
the server-side `request_id` tag.

---

## 4. OpenTelemetry (traces)

Set an OTLP/HTTP endpoint to turn tracing on:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 \
OTEL_TRACES_SAMPLE_RATE=0.1 \
uvicorn app.main:app --port 5182
```

| Setting | Default | Meaning |
|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | — | enables tracing (or set `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`) |
| `OTEL_SERVICE_NAME` | `flowform-api` | resource `service.name` |
| `OTEL_TRACES_SAMPLE_RATE` | `0.1` | head sampling ratio |
| `OTEL_SDK_DISABLED` | — | `1` forces tracing off even with an endpoint |
| `APP_ENV` / `APP_RELEASE` | — | `deployment.environment` / `service.version` |

- FastAPI is instrumented with the standard ASGI/HTTP spans; `/health`,
  `/livez`, `/readyz`, `/metrics` are excluded.
- Solves get a `run.execute` span (inline jobs and the Arq worker) with
  `flowform.run_id`, so a slow run can be found in the trace view.
- Spans are batched and flushed on API shutdown (lifespan exit).

Minimal collector:

```yaml
receivers:
  otlp:
    protocols: { http: { endpoint: 0.0.0.0:4318 } }
exporters:
  otlp:
    endpoint: tempo:4317
    tls: { insecure: true }
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [otlp]
```

Verified locally with a stand-in OTLP receiver: a `/v1/projects` request emitted
spans containing `service.name=flowform-api` and the route path.

---

## 5. Prometheus metrics, SLOs and alerts

### 5.1 The scrape endpoint

`GET /metrics` returns the standard Prometheus text format. It is aggregate
only: **no tenant, user, project or run id is ever a label**, so the metric store
holds no customer data and cardinality cannot grow with the customer base.
Routes come from the route template (`/v1/projects/{project_id}/runs/{run_id}`),
not the request path, and unmatched requests collapse to
`route="unmatched"`.

```yaml
# prometheus.yml
scrape_configs:
  - job_name: flowform-api
    scrape_interval: 15s
    metrics_path: /metrics
    static_configs:
      - targets: ["api:5182"]
    # If METRICS_TOKEN is set:
    # authorization: { type: Bearer, credentials_file: /etc/prometheus/ff-token }

rule_files:
  - /etc/prometheus/flowform.rules.yml
```

| Setting | Default | Meaning |
|---|---|---|
| `METRICS_ENABLED` | `1` | `0` makes `/metrics` return 404 |
| `METRICS_TOKEN` | — | when set, scrapes need `Authorization: Bearer <token>` |
| `RUN_STUCK_ALERT_AFTER_S` | `600` | age after which a non-terminal run counts as stuck |

Exported series:

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `flowform_http_requests_total` | counter | `method`, `route`, `status` | API traffic by route template and status |
| `flowform_http_request_duration_seconds` | histogram | `method`, `route` | request latency |
| `flowform_readyz_status` | gauge | — | `1` ready, `0` not ready. Starts at `0` until the first probe, which is why the alert also requires a real failure |
| `flowform_readyz_failures_total` | counter | — | readiness checks that returned 503 |
| `flowform_runs_total` | counter | `kind`, `status` | terminal run outcomes (`cancelled` excluded from ratios) |
| `flowform_run_duration_seconds` | histogram | `kind` | claim → terminal state |
| `flowform_run_queue_wait_seconds` | histogram | `kind` | created → claimed |
| `flowform_runs_reaped_total` | counter | `outcome` | reaper actions: `requeued`, `failed`, `redispatched` |
| `flowform_stuck_runs` | gauge | — | non-terminal runs with no heartbeat/dispatch for 10 min, refreshed every sweep |

`/health`, `/livez`, `/readyz` and `/metrics` are neither counted nor timed, so a
15 s scrape cannot dominate the latency histogram.

A run the reaper gives up on is terminal for the customer but is counted in
`flowform_runs_reaped_total{outcome="failed"}`, not in `flowform_runs_total`:
the success ratio measures solves that a worker actually attempted, and
interrupted runs have their own alert.

Metrics are **per process**: with several API replicas or uvicorn workers each
one exposes its own counters, and Prometheus should `sum()` across them. The
readiness gauge is the exception — it is meant to be read per instance so an
alert names the replica that is failing.

### 5.2 Alert playbook

Rules: [`ops/prometheus/flowform.rules.yml`](../ops/prometheus/flowform.rules.yml),
unit-tested with `promtool test rules` against
[`flowform.rules.test.yml`](../ops/prometheus/flowform.rules.test.yml). Page on
the first three critical alerts; the warnings are tickets during business hours.

| Alert | Severity | Threshold | First checks |
|---|---|---|---|
| `FlowformApiDown` | critical | `up == 0` for 2 min | container/host state, then `/livez` and the startup log line (`observability ready: …`) for a bad DSN, missing env or failed migration |
| `FlowformNotReady` | critical | `flowform_readyz_status == 0` **and** a failed check in the last 5 min, for 1 min | the `/readyz` body names the failing check; do **not** restart the API for a Postgres/Redis outage |
| `FlowformReadyzProbeFailing` | warning | any failure in 5 min | intermittent dependency latency; compare with `READYZ_TIMEOUT_S` and DB connection counts |
| `FlowformStuckRuns` | critical | `flowform_stuck_runs > 0` for 15 min | is the reaper running (`RUN_REAPER_ENABLED`, `reaper:` log lines), can it reach Redis, is `enqueue_run` failing |
| `FlowformHighErrorRate` | warning | > 0.5 % of `/v1` responses are 5xx for 5 min (error budget is 0.1 %) | Sentry for the exception, `X-Request-ID` from a failing response to find its log line |
| `FlowformLatencyP95High` | warning | `/v1` p95 > 300 ms for 10 min | Postgres connections, snapshot size, then solver CPU |
| `FlowformSolveSuccessLow` | warning | > 1 % of terminal runs failed over 1 h (min 10 runs) | failed run messages, engine version change, solver OOM |
| `FlowformQueueWaitHigh` | warning | queue-wait p95 > 5 min for 15 min | workers alive, `WORKER_MAX_JOBS`, run duration |
| `FlowformRunRecoverySpike` | warning | any reaper `requeued` in 1 h | a worker died mid-solve: memory/CPU limits, deploy timing |
| `FlowformRunInterrupted` | warning | any reaper `failed` in 1 h | worker health; the customer sees an "interrupted" message on the run |

Validate and test the rules without a server:

```bash
promtool check rules ops/prometheus/flowform.rules.yml
promtool test rules ops/prometheus/flowform.rules.test.yml
```

### 5.3 SLO targets

| SLO | Target (30 days) | Prometheus expression / source |
|---|---|---|
| `/v1` availability | ≥ 99.9 % | `sum(rate(flowform_http_requests_total{route=~"/v1.*",status!~"5.."}[5m])) / sum(rate(flowform_http_requests_total{route=~"/v1.*"}[5m]))` |
| API latency p95 (`/v1` reads) | < 300 ms | `histogram_quantile(0.95, sum by (le) (rate(flowform_http_request_duration_seconds_bucket{route=~"/v1.*"}[5m])))` |
| Readiness | 3 consecutive probe failures → page | `flowform_readyz_status` |
| Solve success rate | ≥ 99 % of terminal runs (cancelled excluded) | `flowform_runs_total` |
| Queue wait p95 | < 60 s interactive, page at 5 min | `flowform_run_queue_wait_seconds` |
| Stuck runs | 0 for more than 15 min | `flowform_stuck_runs` |
| Recovery rate (`attempts > 1`) | < 1 % of runs | `flowform_runs_reaped_total` + SQL below |
| 5xx error budget | 0.1 % of requests | `flowform_http_requests_total` |

### 5.4 Independent SQL checks

The database is still the source of truth for run history; these queries answer
questions Prometheus cannot (per-tenant detail, retry distribution) and are what
to run when a metric looks wrong.

```sql
-- Run outcomes, last 24 h
SELECT status, count(*) FROM runs
WHERE created_at > now() - interval '24 hours'
GROUP BY status ORDER BY count(*) DESC;

-- Queue wait p95 in seconds (created → claimed)
SELECT percentile_cont(0.95) WITHIN GROUP (
         ORDER BY extract(epoch FROM (started_at - created_at))
       ) AS p95_queue_wait_s
FROM runs
WHERE started_at IS NOT NULL AND created_at > now() - interval '24 hours';

-- Anything that should have been picked up by now
SELECT count(*) FROM runs
WHERE status IN ('queued', 'running')
  AND coalesce(heartbeat_at, dispatched_at, created_at) < now() - interval '10 minutes';

-- Retry and recovery behaviour
SELECT count(*) FILTER (WHERE attempts > 1) AS retried, count(*) AS total
FROM runs WHERE created_at > now() - interval '7 days';

-- Recovery actions (from the reaper)
SELECT action, count(*) FROM audit_events
WHERE created_at > now() - interval '24 hours' AND action LIKE 'run.%'
GROUP BY action;
```

---

## 6. Known gaps

1. **No deployed dashboards.** The metrics and alert rules ship in-repo; a
   Grafana board (or equivalent) still has to be imported per environment from
   the expressions in §5.3. Review the p95/error-rate panels after the first
   week of real traffic to confirm the thresholds fit the actual load.
2. **No browser RUM.** Front-end errors reach Sentry when `VITE_SENTRY_DSN` is
   set (see §3), but there is no performance/RUM data, no session replay, and a
   web build without a DSN is still invisible to the server.
3. **Logs are stdout only.** Retention, search and alerting depend on the
   platform's log stack.
4. **Trace sampling is head-based** (`OTEL_TRACES_SAMPLE_RATE`); a rare 500 can
   be unsampled. Sentry captures the exception itself regardless.
5. **No per-run trace id in the result payload.** Correlate runs by
   `flowform.run_id` on the span and the run id in the API/DB.
6. **Sentry performance traces are off by default** (`SENTRY_TRACES_SAMPLE_RATE=0`)
   to avoid double-billing against OTel.
7. **Queue depth is not exported.** Queue wait is measured at claim time, so a
   run that never gets a worker shows up as stuck rather than as a growing
   backlog; add `flowform_runs_queued` if backpressure becomes a concern.
8. **`/metrics` is unauthenticated by default.** Restrict it at the ingress, or
   set `METRICS_TOKEN` when the API port is reachable beyond the scrape network.
