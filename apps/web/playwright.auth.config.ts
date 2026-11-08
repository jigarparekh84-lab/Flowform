import { defineConfig, devices } from '@playwright/test'
import {
  AUTH_API_PORT,
  AUTH_API_URL,
  AUTH_EMAIL,
  AUTH_IDP_PORT,
  AUTH_IDP_URL,
  AUTH_REDIRECT_URI,
  AUTH_WEB_PORT,
  AUTH_WEB_URL,
  STUB_API_KEY,
  STUB_CLIENT_ID,
} from './e2e/env'

/**
 * CR-032: the identity round trip, on its own servers.
 *
 * `playwright.config.ts` runs the commercial critical path under `AUTH_MODE=dev`
 * because a real WorkOS tenant cannot be signed into unattended. This config
 * covers the part that bypass skips: a real `/v1/auth/login` state, the browser
 * leaving for the authorization endpoint, the return through `/auth/callback`,
 * the server-side code exchange, and RS256/JWKS token verification.
 *
 * Only the identity *provider* is local (`apps/api/scripts/stub_workos.py`,
 * reached through `WORKOS_API_BASE`). Nothing in the API or the web session
 * layer is stubbed or mocked — every hop is the production code path.
 *
 * Separate ports and a separate `npm run test:e2e:auth` keep the two suites
 * independent: they boot incompatible `AUTH_MODE`s and can run concurrently.
 * The web port is 5181 because that origin is already on the API's CORS
 * allowlist; adding a new test origin there would widen production CORS.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: /workos-auth\.spec\.ts$/,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  // One worker: the tests share one API tenant and one stub IdP's state.
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: AUTH_WEB_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [{ name: 'chromium-auth', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      // The IdP double must be up before the API answers its first /auth/login.
      command:
        `python scripts/stub_workos.py --port ${AUTH_IDP_PORT} --public-url ${AUTH_IDP_URL}` +
        ` --app-url ${AUTH_WEB_URL} --client-id ${STUB_CLIENT_ID} --email ${AUTH_EMAIL}`,
      cwd: '../api',
      url: `${AUTH_IDP_URL}/_stub/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: `python -m uvicorn app.main:app --host 127.0.0.1 --port ${AUTH_API_PORT}`,
      cwd: '../api',
      url: `${AUTH_API_URL}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: {
        AUTH_MODE: 'workos',
        WORKOS_API_KEY: STUB_API_KEY,
        WORKOS_CLIENT_ID: STUB_CLIENT_ID,
        // Redirects the adapter's authorize/JWKS/logout calls at the local double.
        WORKOS_API_BASE: AUTH_IDP_URL,
        WORKOS_REDIRECT_URI: AUTH_REDIRECT_URI,
        WORKOS_STATE_SECRET: 'e2e-state-secret',
        // Keep the audience check on: the token must carry this app's client id.
        WORKOS_ENFORCE_CLIENT_CLAIM: '1',
        QUEUE_BACKEND: 'inline',
        METRICS_ENABLED: '0',
        DATABASE_URL:
          process.env.DATABASE_URL ??
          'postgresql+psycopg://flowform:flowform@127.0.0.1:5433/flowform',
      },
    },
    {
      command: `npm run dev -- --host 127.0.0.1 --port ${AUTH_WEB_PORT}`,
      url: AUTH_WEB_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: {
        // No VITE_DEV_* here: this suite must authenticate, not bypass.
        VITE_API_URL: AUTH_API_URL,
      },
    },
  ],
})
