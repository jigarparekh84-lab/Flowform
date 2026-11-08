import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import {
  AUTH_API_URL,
  AUTH_EMAIL,
  AUTH_IDP_URL,
  AUTH_ORG,
  AUTH_ORG_BETA,
  AUTH_ORG_BETA_ID,
  AUTH_ORG_ID,
  AUTH_ORG_PHANTOM,
  AUTH_ORG_PHANTOM_ID,
  AUTH_REDIRECT_URI,
  AUTH_TENANT_BETA,
  AUTH_WEB_URL,
  STUB_CLIENT_ID,
} from './env'

/**
 * CR-032 — the WorkOS identity round trip, driven through the real UI.
 *
 * The dev-bypass smoke in `critical-path.spec.ts` starts at "already identified".
 * This suite starts before that: the signed state from `/v1/auth/login`, the
 * browser leaving for the authorization endpoint, the return to `/auth/callback`,
 * the server-side code exchange and RS256/JWKS verification of the resulting
 * token. `apps/api/scripts/stub_workos.py` stands in for the provider only —
 * no app code is mocked, so a broken allowlist, state check or client-claim check
 * fails here the way it would in production.
 */

type StubState = {
  authorizations: Array<{ client_id: string; redirect_uri: string; state: string }>
  exchanges: Array<{ code: string; state: string; session_id: string }>
  refreshes: Array<{ organization_id: string | null; granted: string }>
  refusals: Array<{ organization_id: string; reason: string }>
  lookups: string[]
  revocations: string[]
  logouts: Array<{ session_id: string; return_to: string }>
  codes_issued: number
}

async function stubState(request: APIRequestContext): Promise<StubState> {
  const res = await request.get(`${AUTH_IDP_URL}/_stub/state`)
  expect(res.ok(), 'the stub identity provider should be running').toBe(true)
  return (await res.json()) as StubState
}

function recordNavigations(page: Page): string[] {
  const seen: string[] = []
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) seen.push(frame.url())
  })
  return seen
}

/** Read a token's claims without verifying it — the API does the verifying. */
function decodeClaims(token: string): Record<string, unknown> {
  const body = (token.split('.')[1] ?? '').replace(/-/g, '+').replace(/_/g, '/')
  const padded = body + '='.repeat((4 - (body.length % 4)) % 4)
  return JSON.parse(atob(padded)) as Record<string, unknown>
}

/** Anonymous → click through sign-in → signed in as the stub's owner. */
async function signIn(page: Page): Promise<string> {
  await page.goto('/')
  const trigger = page.getByTestId('account-trigger')
  await expect(trigger).toContainText('Sign in')

  const authorize = page.waitForRequest((r) =>
    r.url().startsWith(`${AUTH_IDP_URL}/user_management/authorize`),
  )
  await trigger.click()
  await page
    .getByRole('dialog', { name: 'Account and workspace' })
    .getByRole('button', { name: 'Sign in', exact: true })
    .click()

  const state = new URL((await authorize).url()).searchParams.get('state') ?? ''
  await expect(trigger).toContainText('Owner', { timeout: 30_000 })
  return state
}

test.beforeEach(async ({ request }) => {
  // Counters are per-server; reset so each test asserts only its own traffic.
  expect((await request.post(`${AUTH_IDP_URL}/_stub/reset`)).ok()).toBe(true)
})

test('sign-in redirects to the provider and returns through /auth/callback', async ({
  page,
  request,
}) => {
  const navigations = recordNavigations(page)
  await page.goto('/')

  const trigger = page.getByTestId('account-trigger')
  await expect(trigger).toContainText('Sign in')

  const authorize = page.waitForRequest((r) =>
    r.url().startsWith(`${AUTH_IDP_URL}/user_management/authorize`),
  )
  await trigger.click()
  await page
    .getByRole('dialog', { name: 'Account and workspace' })
    .getByRole('button', { name: 'Sign in', exact: true })
    .click()

  // ---------------------------------------------------- the outbound redirect
  const authorizeUrl = new URL((await authorize).url())
  expect(authorizeUrl.searchParams.get('client_id')).toBe(STUB_CLIENT_ID)
  expect(authorizeUrl.searchParams.get('redirect_uri')).toBe(AUTH_REDIRECT_URI)
  expect(authorizeUrl.searchParams.get('response_type')).toBe('code')
  expect(authorizeUrl.searchParams.get('provider')).toBe('authkit')
  const state = authorizeUrl.searchParams.get('state') ?? ''
  // `payload.signature`: the nonce is the state the API signed, not a client one.
  expect(state, 'the API must mint a signed state for the redirect').toMatch(
    /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
  )

  // ---------------------------------------------------- the return leg
  await expect(trigger).toContainText('Owner', { timeout: 30_000 })
  await expect(page).toHaveURL(`${AUTH_WEB_URL}/`)

  const callbackPath = navigations.find((u) => u.startsWith(`${AUTH_WEB_URL}/auth/callback`))
  expect(callbackPath, 'the browser must land on /auth/callback before the app').toBeTruthy()
  const callback = new URL(callbackPath as string)
  expect(callback.searchParams.get('state')).toBe(state)
  const code = callback.searchParams.get('code') ?? ''
  expect(code).not.toHaveLength(0)

  // ---------------------------------------------------- the resulting session
  await trigger.click()
  const menu = page.getByRole('dialog', { name: 'Account and workspace' })
  await expect(menu).toContainText(AUTH_EMAIL)
  await expect(menu).toContainText('Owner · full control')
  // Organizations come from the provider, over a token the API had to verify.
  await expect(menu.locator('.auth-orgs')).toContainText(AUTH_ORG)
  await expect(menu.locator('.auth-orgs')).not.toContainText('Former Employer')

  const storage = await page.evaluate(() => {
    const session: Record<string, string> = {}
    for (let i = 0; i < sessionStorage.length; i += 1) {
      const key = sessionStorage.key(i) as string
      session[key] = sessionStorage.getItem(key) ?? ''
    }
    return { localKeys: Object.keys(localStorage), session }
  })
  expect(storage.localKeys.filter((k) => /token|session|auth/i.test(k))).toEqual([])
  expect(storage.session['flowform-auth-pending'], 'the pending state is cleared').toBeUndefined()
  const persisted = JSON.parse(storage.session['flowform-session'] ?? 'null') as {
    accessToken: string
    refreshToken: string
  }
  expect(persisted, 'the session must survive a reload').toBeTruthy()
  expect(persisted.accessToken, 'no bearer token rests in web storage').toBe('')
  expect(persisted.refreshToken).toMatch(/^rt_/)

  // ---------------------------------------------------- what the provider saw
  const idp = await stubState(request)
  expect(idp.authorizations).toHaveLength(1)
  expect(idp.authorizations[0].state).toBe(state)
  expect(idp.exchanges).toHaveLength(1)
  expect(idp.exchanges[0].state).toBe(state)
  expect(idp.exchanges[0].code).toBe(code)

  // The code is spent once: replaying the callback cannot mint a second session.
  const replay = await request.post(`${AUTH_API_URL}/v1/auth/callback`, {
    data: { code, state },
  })
  expect(replay.status(), 'a replayed code must not be exchanged again').toBe(401)
  expect((await stubState(request)).exchanges).toHaveLength(1)
})

test('switching the active organization rotates the token and the role it carries', async ({
  page,
  request,
}) => {
  await signIn(page)
  const trigger = page.getByTestId('account-trigger')
  const menu = page.getByRole('dialog', { name: 'Account and workspace' })

  await trigger.click()
  const rows = menu.locator('.auth-orgs li')
  // Inactive memberships are filtered out upstream, so Beta is the only alternative.
  await expect(rows).toHaveCount(2)
  const acme = rows.filter({ hasText: AUTH_ORG })
  const beta = rows.filter({ hasText: AUTH_ORG_BETA })
  await expect(acme).toContainText('Current')
  await expect(beta).not.toContainText('Current')
  // Each row shows the role the provider scoped to that organization (member → Editor).
  await expect(beta.locator('.auth-org-role')).toHaveText('Editor')

  // A switch is a refresh-token grant naming the org, not a second sign-in.
  const rotated = page.waitForResponse(
    (r) => r.url() === `${AUTH_API_URL}/v1/auth/refresh` && r.request().method() === 'POST',
  )
  await beta.getByRole('button', { name: 'Switch' }).click()
  const response = await rotated
  expect(response.status()).toBe(200)

  const sent = JSON.parse(response.request().postData() ?? '{}') as {
    refreshToken?: string
    organizationId?: string
  }
  expect(sent.organizationId, 'the switch must name the chosen organization').toBe(AUTH_ORG_BETA_ID)
  expect(sent.refreshToken).toMatch(/^rt_/)

  const token = (await response.json()) as { access_token: string; organization_id: string }
  expect(token.organization_id).toBe(AUTH_ORG_BETA_ID)
  const claims = decodeClaims(token.access_token)
  expect(claims.org_id, 'the new token is scoped to the new organization').toBe(AUTH_ORG_BETA_ID)
  expect(claims.role, 'the role travels on the new token').toBe('member')
  expect(claims.client_id).toBe(STUB_CLIENT_ID)
  expect(claims.email).toBe(AUTH_EMAIL)

  // ---------------------------------------------------- what the app now shows
  await expect(rows.filter({ hasText: AUTH_ORG_BETA })).toContainText('Current')
  await expect(rows.filter({ hasText: AUTH_ORG })).not.toContainText('Current')
  // `member` resolves to editor through /v1/auth/me, and the chrome follows it.
  await expect(trigger).toContainText('Editor')
  await expect(menu).toContainText('Editor · model and run')

  // ---------------------------------------------------- and what it now allows
  const headers = { authorization: `Bearer ${token.access_token}` }
  const me = await request.get(`${AUTH_API_URL}/v1/auth/me`, { headers })
  expect(me.status()).toBe(200)
  expect(await me.json()).toMatchObject({ tenantId: AUTH_TENANT_BETA, role: 'editor' })
  const portal = await request.post(`${AUTH_API_URL}/v1/auth/admin-portal`, {
    headers,
    data: { intent: 'sso' },
  })
  expect(portal.status(), 'an editor must not reach an owner-only surface').toBe(403)

  const idp = await stubState(request)
  expect(idp.refreshes.at(-1), 'the provider saw the switch for that org').toMatchObject({
    organization_id: AUTH_ORG_BETA_ID,
    granted: AUTH_ORG_BETA_ID,
  })
  expect(idp.exchanges, 'switching must not re-exchange an authorization code').toHaveLength(1)
})

test('a stale membership the provider lists is never offered as a switch', async ({
  page,
  request,
}) => {
  await signIn(page)
  const trigger = page.getByTestId('account-trigger')
  const menu = page.getByRole('dialog', { name: 'Account and workspace' })
  await trigger.click()
  const rows = menu.locator('.auth-orgs li')
  await expect(rows).toHaveCount(2)

  // The listing now advertises an organization the provider's own token grant
  // will refuse — a cached view the API cannot trust.
  expect((await request.post(`${AUTH_IDP_URL}/_stub/advertise-phantom`)).ok()).toBe(true)
  const refreshed = page.waitForResponse((r) => r.url() === `${AUTH_API_URL}/v1/auth/organizations`)
  await menu.getByRole('button', { name: 'Refresh', exact: true }).click()

  // The API confirms each candidate before offering it, so the phantom never
  // reaches the menu.
  const orgs = (await (await refreshed).json()) as {
    organizations: Array<{ id: string }>
    degraded: boolean
  }
  expect(orgs.organizations.map((o) => o.id)).toEqual([AUTH_ORG_ID, AUTH_ORG_BETA_ID])
  expect(orgs.degraded, 'the rest of the list is still trusted').toBe(false)
  await expect(rows).toHaveCount(2)
  await expect(menu.locator('.auth-orgs')).not.toContainText(AUTH_ORG_PHANTOM)
  await expect(rows.filter({ hasText: AUTH_ORG_BETA })).toContainText('Switch')
  // ...and it did not hide the listing wholesale: no degraded warning.
  await expect(menu).not.toContainText('could not confirm')

  const idp = await stubState(request)
  expect(idp.lookups, 'the advertised org was checked one membership at a time').toContain(
    AUTH_ORG_PHANTOM_ID,
  )
  expect(idp.lookups, 'the current org is proven by the token, not a lookup').not.toContain(
    AUTH_ORG_ID,
  )
})

test('a switch refused after the list was read keeps the visitor in their own workspace', async ({
  page,
  request,
}) => {
  await signIn(page)
  const trigger = page.getByTestId('account-trigger')
  const menu = page.getByRole('dialog', { name: 'Account and workspace' })
  await trigger.click()
  const rows = menu.locator('.auth-orgs li')
  const beta = rows.filter({ hasText: AUTH_ORG_BETA })
  await expect(beta).toContainText('Switch')

  // The race the API cannot close: the membership is dropped after the list was
  // read and rendered, so the button is still there but the grant will refuse.
  const revoked = await request.post(`${AUTH_IDP_URL}/_stub/revoke`, {
    data: { organization_id: AUTH_ORG_BETA_ID },
  })
  expect(revoked.ok()).toBe(true)

  const refused = page.waitForResponse(
    (r) => r.url() === `${AUTH_API_URL}/v1/auth/refresh` && r.request().method() === 'POST',
  )
  await beta.getByRole('button', { name: 'Switch' }).click()
  const response = await refused
  expect(response.status(), 'the provider refuses the grant rather than issuing a token').toBe(401)

  // The reason reaches the account menu; the failure is not swallowed.
  await expect(menu.getByRole('alert')).toContainText('organization switch refused')

  // And the visitor stays put: same workspace, same visible role.
  await expect(trigger).toContainText('Owner')
  await expect(rows.filter({ hasText: AUTH_ORG })).toContainText('Current')
  await expect(beta).not.toContainText('Current')
  const stored = await page.evaluate(
    () =>
      JSON.parse(sessionStorage.getItem('flowform-session') ?? 'null') as {
        organizationId: string | null
      } | null,
  )
  expect(stored?.organizationId, 'the stored session still names the org we were in').toBe(AUTH_ORG_ID)

  // The refused grant did not spend the refresh token: an ordinary refresh still
  // works, and still mints a token for the workspace we never left.
  const renewed = page.waitForResponse(
    (r) => r.url() === `${AUTH_API_URL}/v1/auth/refresh` && r.request().method() === 'POST',
  )
  await menu.getByRole('button', { name: 'Refresh session' }).click()
  const renewal = await renewed
  expect(renewal.status(), 'the session outlives the refused switch').toBe(200)
  const token = (await renewal.json()) as { access_token: string }
  expect(decodeClaims(token.access_token).org_id).toBe(AUTH_ORG_ID)
  await expect(trigger).toContainText('Owner')

  // ---------------------------------------------------- what the provider saw
  const idp = await stubState(request)
  expect(idp.revocations).toEqual([AUTH_ORG_BETA_ID])
  expect(idp.refusals, 'the revoked membership was refused').toEqual([
    { organization_id: AUTH_ORG_BETA_ID, reason: 'no active membership' },
  ])
  expect(
    idp.refreshes.filter((r) => r.granted === AUTH_ORG_BETA_ID),
    'no token was ever minted for the lost organization',
  ).toHaveLength(0)
})

test('a callback the server never authorized is refused and spends no code', async ({
  page,
  request,
}) => {
  await page.goto('/auth/callback?code=code_attacker&state=forged.signature')

  await expect(page.getByRole('heading', { name: 'Sign-in did not complete' })).toBeVisible()
  await expect(page.locator('.auth-callback-error')).toContainText('invalid state')
  await expect(page).toHaveURL(/\/auth\/callback\?/)
  expect(await page.evaluate(() => sessionStorage.getItem('flowform-session'))).toBeNull()

  const idp = await stubState(request)
  expect(idp.exchanges, 'a rejected state must not spend the authorization code').toHaveLength(0)

  // Back on the app, the visitor is still anonymous — nothing half-signed-in.
  await page.getByRole('link', { name: 'Back to Flowform' }).click()
  await expect(page.getByTestId('account-trigger')).toContainText('Sign in')
})

test('the session refreshes on reload and sign-out ends it at the provider', async ({
  page,
  request,
}) => {
  await signIn(page)
  const trigger = page.getByTestId('account-trigger')

  // The post-callback page load already refreshed once (the stored copy holds no
  // access token by design); a reload must exchange the refresh token, not
  // re-run sign-in.
  await page.reload()
  await expect(trigger).toContainText('Owner')
  const before = await stubState(request)
  expect(before.refreshes.length, 'reload refreshes the session').toBeGreaterThanOrEqual(2)
  expect(before.exchanges, 'reload must not re-exchange the code').toHaveLength(1)

  await trigger.click()
  const logout = page.waitForRequest((r) =>
    r.url().startsWith(`${AUTH_IDP_URL}/user_management/sessions/logout`),
  )
  await page.getByRole('button', { name: 'Sign out' }).click()

  const logoutUrl = new URL((await logout).url())
  const sessionId = logoutUrl.searchParams.get('session_id') ?? ''
  expect(logoutUrl.searchParams.get('return_to')).toBe('/')
  expect(sessionId, 'logout must name the WorkOS session from the token').toMatch(/^session_/)

  await expect(trigger).toContainText('Sign in', { timeout: 30_000 })
  const after = await stubState(request)
  expect(after.logouts).toHaveLength(1)
  expect(after.logouts[0].session_id).toBe(sessionId)
  expect(
    await page.evaluate(() => sessionStorage.getItem('flowform-session')),
    'sign-out clears the stored session',
  ).toBeNull()
})
