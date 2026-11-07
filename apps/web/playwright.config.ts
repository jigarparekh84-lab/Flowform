import { defineConfig, devices } from '@playwright/test'
import { API_PORT, API_URL, DEV_TENANT, DEV_USER, WEB_PORT, WEB_URL } from './e2e/env'

/**
 * CR-032: end-to-end smoke for the commercial critical path
 * (auth → project → run → compare → brief → share).
 *
 * The suite starts the real API and the real web dev server, so it needs the
 * same preconditions as a local run: Postgres is up and `alembic upgrade head`
 * has been applied. Identity uses `AUTH_MODE=dev` (loopback-only header auth),
 * the one auth mode that can run unattended — WorkOS itself cannot be signed
 * into from CI.
 */
export default defineConfig({
  testDir: './e2e',
  // A MIP solve plus a cold Vite boot is slower than a unit test.
  timeout: 120_000,
  expect: { timeout: 20_000 },
  // One worker: the tests share one API tenant and one database.
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: WEB_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      // `python -m` follows the active interpreter (apps/api/.venv locally, the
      // CI runner's pip environment) instead of whatever `uvicorn` is on PATH.
      command: `python -m uvicorn app.main:app --host 127.0.0.1 --port ${API_PORT}`,
      cwd: '../api',
      url: `${API_URL}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: {
        AUTH_MODE: 'dev',
        // In-process worker pool: no Redis needed for the smoke.
        QUEUE_BACKEND: 'inline',
        METRICS_ENABLED: '0',
        // CI supplies its own (service container) URL; this default is the repo's dev DB.
        DATABASE_URL:
          process.env.DATABASE_URL ??
          'postgresql+psycopg://flowform:flowform@127.0.0.1:5433/flowform',
      },
    },
    {
      command: `npm run dev -- --host 127.0.0.1 --port ${WEB_PORT}`,
      url: WEB_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: {
        VITE_API_URL: API_URL,
        VITE_DEV_TENANT: DEV_TENANT,
        VITE_DEV_USER: DEV_USER,
        // Assert the async job path (POST /v1/projects/{id}/runs), not the sync fallback.
        VITE_RUN_MODE: 'jobs',
      },
    },
  ],
})
