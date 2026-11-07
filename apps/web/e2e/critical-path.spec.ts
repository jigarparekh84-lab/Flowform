import { expect, test, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { API_URL, DEV_HEADERS, WEB_URL } from './env'

/**
 * CR-032 — the commercial critical path, driven through the real UI against the
 * real API: auth → project → run → compare → brief → share, plus both themes.
 *
 * Identity is `AUTH_MODE=dev` because WorkOS cannot be signed into from an
 * unattended runner; everything after the identity hand-off (tenant isolation
 * included) is the same code path a WorkOS session uses.
 */

function nav(page: Page, name: string) {
  return page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('button', { name, exact: true })
}

function chrome(page: Page, name: string) {
  return page.locator('.chrome-right').getByRole('button', { name, exact: true })
}

test('theme toggle applies light and dark', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto('/')

  const html = page.locator('html')
  const background = () =>
    page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--ff-bg').trim(),
    )

  await expect(html).toHaveAttribute('data-theme', 'dark')
  const dark = await background()

  await page.getByRole('button', { name: 'Switch to light mode' }).click()
  await expect(html).toHaveAttribute('data-theme', 'light')
  const light = await background()

  // The attribute flips *and* the palette actually changes.
  expect(light).not.toBe(dark)
  expect(light).toMatch(/^#/)
  expect(dark).toMatch(/^#/)

  await page.getByRole('button', { name: 'Switch to dark mode' }).click()
  await expect(html).toHaveAttribute('data-theme', 'dark')
  expect(await background()).toBe(dark)

  // The choice survives a reload (theme is stored, not just React state).
  await page.reload()
  await expect(html).toHaveAttribute('data-theme', 'dark')
})

test('critical path: auth → project → run → compare → brief → share', async ({
  page,
  context,
  request,
}) => {
  const dialogs: string[] = []
  page.on('dialog', async (d) => {
    dialogs.push(d.message())
    await d.accept()
  })
  // Share writes the read-only deep link to the clipboard; grant it so the
  // success path is what is tested, not a permissions prompt.
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: WEB_URL })

  await page.goto('/')

  // ---------------------------------------------------------------- auth
  const account = page.getByTestId('account-trigger')
  await expect(account).toContainText('Dev auth')
  await account.click()
  const menu = page.getByRole('dialog', { name: 'Account and workspace' })
  await expect(menu).toBeVisible()
  // CR-012: a header bypass must announce itself, not hide behind a green chip.
  await expect(menu).toContainText('AUTH_MODE=dev')
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()

  // ---------------------------------------------------------------- project
  await nav(page, 'Projects').click()
  await expect(page.getByRole('heading', { name: 'Design studies' })).toBeVisible()
  await expect(
    page.getByRole('status').filter({ hasText: 'Saved to your workspace.' }),
  ).toBeVisible()

  await page.getByRole('button', { name: 'New project' }).click()
  await expect(page.locator('.projects-status')).toContainText('Created')
  const projectName = (await page.locator('.project-name').innerText()).trim()
  expect(projectName).not.toHaveLength(0)

  // ---------------------------------------------------------------- run
  // Assert the asynchronous job path (POST /v1/projects/{id}/runs), because
  // that is what production uses; the sync fallback must not be what passes.
  const runCreated = page.waitForResponse(
    (r) =>
      r.request().method() === 'POST' &&
      /\/v1\/projects\/[0-9a-f-]{36}\/runs$/.test(r.url()),
    { timeout: 60_000 },
  )
  await chrome(page, 'Run').click()

  const created = await runCreated
  expect(
    created.status(),
    'the run should be accepted by the job API (202), not silently fall back to a sync solve',
  ).toBe(202)
  const { id: runId } = (await created.json()) as { id: string }
  expect(runId).toMatch(/^[0-9a-f-]{36}$/)
  const projectId = created.url().match(/\/v1\/projects\/([0-9a-f-]{36})\/runs$/)?.[1]
  expect(projectId, 'the run should be filed under a server-side project').toBeTruthy()
  // `created.url()` is the collection the POST targeted; the run lives beneath it.
  const runUrl = `${created.url()}/${runId}`

  // Identity really is wired to tenancy: the same request under a different
  // workspace sees none of this tenant's projects and cannot open one by id.
  const otherTenant = { ...DEV_HEADERS, 'X-Dev-Tenant': '00000000-0000-0000-0000-00000000e2e1' }
  const otherList = await request.get(`${API_URL}/v1/projects`, { headers: otherTenant })
  expect(otherList.ok()).toBe(true)
  expect(((await otherList.json()) as { projects: unknown[] }).projects).toHaveLength(0)
  const crossTenant = await request.get(`${API_URL}/v1/projects/${projectId}`, {
    headers: otherTenant,
  })
  expect(crossTenant.status()).toBe(404)

  await expect
    .poll(
      async () => {
        const res = await request.get(runUrl, { headers: DEV_HEADERS })
        if (!res.ok()) return `HTTP ${res.status()}`
        return ((await res.json()) as { status: string }).status
      },
      { timeout: 90_000, message: `run ${runId} never reached a terminal state` },
    )
    .toBe('succeeded')

  const runStatus = page.locator('.run-status.run-done')
  await expect(runStatus).toBeVisible()
  await expect(runStatus).toContainText('Optimal')
  await expect(runStatus).toContainText('API')

  // ---------------------------------------------------------------- compare
  await chrome(page, 'Compare').click()
  await expect(page.getByRole('heading', { name: 'Results' })).toBeVisible()
  await expect(page.getByText(/What this Run says/)).toBeVisible()
  // The KPI matrix (the other compare tables reuse .compare-matrix for styling).
  const matrix = page.locator('table.compare-matrix:not(.modes-table)')
  await expect(matrix).toHaveCount(1)
  await expect(matrix.getByRole('columnheader', { name: 'KPI' })).toBeVisible()

  // ---------------------------------------------------------------- brief
  await nav(page, 'Brief').click()
  await expect(page.getByRole('heading', { name: 'Decision Brief' })).toBeVisible()
  await expect(page.locator('.brief-banner h2')).not.toHaveText('—')

  const [briefDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download Markdown' }).click(),
  ])
  expect(briefDownload.suggestedFilename()).toMatch(/^flowform-brief-.+\.md$/)
  const briefPath = await briefDownload.path()
  const briefText = await readFile(briefPath, 'utf8')
  expect(briefText.length).toBeGreaterThan(200)
  expect(briefText).toContain(projectName)

  // ---------------------------------------------------------------- share
  const [shareDownload] = await Promise.all([
    page.waitForEvent('download'),
    chrome(page, 'Share').click(),
  ])
  expect(shareDownload.suggestedFilename()).toMatch(/\.share\.json$/)

  await expect.poll(() => dialogs.join('\n')).toContain('Deep-link copied')
  const shareMessage = dialogs.join('\n')
  expect(shareMessage).toContain('Share pack downloaded')
  expect(shareMessage).toContain('flowform://share?')
  expect(shareMessage).toContain('readonly=1')

  const packPath = await shareDownload.path()
  const pack = JSON.parse(await readFile(packPath, 'utf8')) as {
    format: string
    readonly: boolean
    meta: { name: string }
  }
  expect(pack.format).toBe('flowform-share')
  expect(pack.readonly).toBe(true)
  expect(pack.meta.name).toBe(projectName)
})
