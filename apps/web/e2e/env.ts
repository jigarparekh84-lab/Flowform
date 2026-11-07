/**
 * Shared E2E coordinates: the ports the smoke boots on and the dev identity the
 * browser and the test's API calls both present. One source of truth so the
 * config and the spec cannot drift apart.
 */
export const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 5180)
export const API_PORT = Number(process.env.E2E_API_PORT ?? 5182)

export const WEB_URL = `http://127.0.0.1:${WEB_PORT}`
export const API_URL = `http://127.0.0.1:${API_PORT}`

/** The seeded dev workspace (`DEV_TENANT` in apps/api/app/v1/auth.py). */
export const DEV_TENANT = process.env.E2E_TENANT ?? '00000000-0000-0000-0000-00000000d001'
export const DEV_USER = process.env.E2E_USER ?? 'e2e@flowform.local'

/** Headers the web app sends from VITE_DEV_*; the test uses them to inspect the same tenant. */
export const DEV_HEADERS = {
  'X-Dev-Tenant': DEV_TENANT,
  'X-Dev-User': DEV_USER,
  'X-Dev-Role': 'owner',
}
