# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the Oxlint configuration

If you are developing a production application, we recommend enabling type-aware lint rules by installing `oxlint-tsgolint` and editing `.oxlintrc.json`:

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["react", "typescript", "oxc"],
  "options": {
    "typeAware": true
  },
  "rules": {
    "react/rules-of-hooks": "error",
    "react/only-export-components": ["warn", { "allowConstantExport": true }]
  }
}
```

See the [Oxlint rules documentation](https://oxc.rs/docs/guide/usage/linter/rules) for the full list of rules and categories.

## Workspace projects (FF-107)

Projects stay in localStorage as the working copy and are mirrored to the API
(`/v1/projects`) on every save. Run the API with `AUTH_MODE=dev` (plus
`DATABASE_URL`, see `apps/api/README.md`) to enable it — dev auth is accepted
from loopback clients only. For WorkOS, sign in from the top-chrome account menu. If the API is down or
returns 401, the Projects room shows a banner and edits queue locally;
"Move my N local projects to my workspace" pushes them and pulls workspace
projects this browser doesn't have. `VITE_PROJECT_STORE=local` turns sync off.
Auth seam: `src/data/apiAuth.ts` (`setAuthTokenProvider` for WorkOS, FF-106).

## Error reporting (CR-003)

The `ErrorBoundary` and the global `error` / `unhandledrejection` handlers all
report through `src/data/reporting.ts`. It is inert until `VITE_SENTRY_DSN` is
set: no DSN means no network call and no Sentry chunk in the loaded bundle.
Payloads are scrubbed (URL query/hash, bearer tokens, JWTs, share links) and
deduplicated for 5 s; `npm run test:reporting` covers the rules. See
[OBSERVABILITY.md §3](../../docs/OBSERVABILITY.md#3-sentry-errors).

## End-to-end smoke (CR-032)

`npm run test:e2e` runs Playwright against the real API and the real dev server:
identity → project → async run → compare → brief export → share, plus light/dark.
It starts both servers itself, so only the database is a precondition:

```bash
docker compose up -d db                       # from the repo root
export DATABASE_URL=postgresql+psycopg://flowform:flowform@127.0.0.1:5433/flowform
cd apps/api && source .venv/bin/activate && alembic upgrade head
cd ../../apps/web && npx playwright install chromium && npm run test:e2e
```

The suite uses `AUTH_MODE=dev` because a real WorkOS tenant cannot be signed into
unattended; every step after identity uses the same tenant-scoped API a real
session does. Points and identity can be overridden with `E2E_WEB_PORT`,
`E2E_API_PORT`, `E2E_TENANT`, and `E2E_USER`. Traces and screenshots land in
`test-results/`. An existing dev server on 5180/5182 is reused outside CI.

### Sign-in round trip (CR-032)

`npm run test:e2e:auth` covers the leg the dev bypass skips: the signed state from
`/v1/auth/login`, the browser leaving for the authorization endpoint, the return
through `/auth/callback`, the server-side code exchange, and RS256/JWKS
verification of the token against its `client_id` claim. It then asserts the
stored session holds no access token, a replayed code is refused, a forged state
is refused without spending a code, a reload refreshes rather than re-signs in,
and sign-out ends the WorkOS session. It also switches the active organization
from the account menu: the refresh grant names the new org, the new token carries
that org's `org_id` and role (`member` → editor), the workspace scope moves to the
new tenant, and an owner-only route refuses the downgraded token. Two failure
paths are covered as well. A stale listing entry — advertised by the provider but
not a real membership — never becomes a button, because the API confirms every
candidate with a single-membership lookup before offering it. And a switch
refused *after* the list was read (the membership is revoked in between) shows
the reason in the account menu, keeps the visitor in the workspace they were in
with their session intact, and the next refresh still succeeds.

Only the identity provider is local: `playwright.auth.config.ts` boots
`apps/api/scripts/stub_workos.py` on 5184 and gives the API `WORKOS_API_BASE`
pointing at it. No API or web code is mocked, and no real tenant is needed. The
suite runs its own API (5183, `AUTH_MODE=workos`) and web (5181 — an origin
already on the API's CORS allowlist) so it can run alongside `test:e2e`.
