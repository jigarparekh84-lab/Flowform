/**
 * Shared E2E coordinates: the ports the smoke boots on and the dev identity the
 * browser and the test's API calls both present. One source of truth so the
 * config and the spec cannot drift apart.
 */
export const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 5180)
export const API_PORT = Number(process.env.E2E_API_PORT ?? 5182)

export const WEB_URL = `http://127.0.0.1:${WEB_PORT}`
export const API_URL = `http://127.0.0.1:${API_PORT}`

/**
 * The identity suite (`playwright.auth.config.ts`) runs its own API + web pair so
 * it can boot in `AUTH_MODE=workos` without disturbing the dev-bypass smoke, and
 * a loopback stand-in for the WorkOS API (apps/api/scripts/stub_workos.py).
 *
 * The web port is 5181 rather than a fresh one because that origin is already on
 * the API's CORS allowlist (main.py) — a test suite must not widen production
 * CORS. It is free while the dev-bypass smoke occupies 5180.
 */
export const AUTH_WEB_PORT = Number(process.env.E2E_AUTH_WEB_PORT ?? 5181)
export const AUTH_API_PORT = Number(process.env.E2E_AUTH_API_PORT ?? 5183)
export const AUTH_IDP_PORT = Number(process.env.E2E_AUTH_IDP_PORT ?? 5184)

export const AUTH_WEB_URL = `http://127.0.0.1:${AUTH_WEB_PORT}`
export const AUTH_API_URL = `http://127.0.0.1:${AUTH_API_PORT}`
export const AUTH_IDP_URL = `http://127.0.0.1:${AUTH_IDP_PORT}`

/** What the stub IdP and the API agree on (`WORKOS_CLIENT_ID` etc.). */
export const STUB_CLIENT_ID = 'client_e2e'
export const STUB_API_KEY = 'sk_test_e2e'
export const AUTH_REDIRECT_URI = `${AUTH_WEB_URL}/auth/callback`
export const AUTH_EMAIL = 'owner@acme.test'
export const AUTH_ORG = 'Acme Distribution'
/** The second membership: lower role, other tenant — what the switch test moves to. */
export const AUTH_ORG_BETA = 'Beta Logistics'
export const AUTH_ORG_BETA_ID = 'org_e2e_beta'
/** The org you land in after sign-in. */
export const AUTH_ORG_ID = 'org_e2e_acme'
/** A membership the stub advertises but refuses to mint a token for. */
export const AUTH_ORG_PHANTOM = 'Phantom Holdings'
export const AUTH_ORG_PHANTOM_ID = 'org_e2e_phantom'
/**
 * The tenant the API derives from a WorkOS organization: uuid5(DEV_NS, "ext:<org_id>").
 * Deterministic (apps/api/app/v1/auth.py), so the switch test can prove the
 * workspace scope actually moved and not just the label in the menu.
 */
export const AUTH_TENANT_BETA = 'cac29cb6-94fe-5b21-a52e-cb79062a8903'

/** The seeded dev workspace (`DEV_TENANT` in apps/api/app/v1/auth.py). */
export const DEV_TENANT = process.env.E2E_TENANT ?? '00000000-0000-0000-0000-00000000d001'
export const DEV_USER = process.env.E2E_USER ?? 'e2e@flowform.local'

/** Headers the web app sends from VITE_DEV_*; the test uses them to inspect the same tenant. */
export const DEV_HEADERS = {
  'X-Dev-Tenant': DEV_TENANT,
  'X-Dev-User': DEV_USER,
  'X-Dev-Role': 'owner',
}
