/**
 * CR-010: web session lifecycle — state check, token exchange, one-shot refresh
 * on 401, sign-out, organization switching, and restore-after-reload.
 */
import assert from 'node:assert/strict'

// --- browser seams ---------------------------------------------------------
const mem = new Map<string, string>()
;(globalThis as { sessionStorage?: unknown }).sessionStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
}
const navigations: string[] = []
;(globalThis as { location?: unknown }).location = {
  origin: 'http://app.test',
  pathname: '/network',
  search: '?room=2',
  assign: (url: string) => void navigations.push(url),
}

function jwt(claims: Record<string, unknown>, ttl = 300): string {
  const enc = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  return `${enc({ alg: 'RS256', typ: 'JWT', kid: 'k1' })}.${enc({ iat: now, exp: now + ttl, ...claims })}.sig`
}

// --- fake API --------------------------------------------------------------
type Call = { method: string; path: string; search: string; body: unknown; auth: string | null }
const calls: Call[] = []
let stateSeq = 0
let refreshCalls = 0
let callbackCalls = 0
let rejectRefresh = false
let rejectSwitchOrg: string | null = null
let meRole = 'editor'
let rejectToken: string | null = null

;(globalThis as { fetch?: unknown }).fetch = async (url: string, init: RequestInit = {}) => {
  const u = new URL(url)
  const method = init.method ?? 'GET'
  const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null
  const headers = (init.headers ?? {}) as Record<string, string>
  calls.push({ method, path: u.pathname, search: u.search, body, auth: headers.Authorization ?? null })
  const json = (status: number, payload: unknown) =>
    new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })

  if (u.pathname === '/v1/auth/config') {
    return json(200, {
      mode: 'workos', workosEnabled: true, redirectUri: null,
      allowLoopbackRedirect: true, roles: ['viewer', 'editor', 'admin', 'owner'],
    })
  }
  if (u.pathname === '/v1/auth/login') {
    stateSeq++
    return json(200, { url: `https://api.workos.com/authorize?state=st-${stateSeq}`, state: `st-${stateSeq}`, expiresIn: 600 })
  }
  if (u.pathname === '/v1/auth/callback') {
    callbackCalls++
    if (!body?.state) return json(400, { detail: 'state required' })
    return json(200, {
      access_token: jwt({ sub: 'user_1', org_id: 'org_A', sid: 'sess_1', client_id: 'client_123' }),
      refresh_token: 'rt_1',
      user: { id: 'user_1', email: 'ana@acme.test' },
      organization_id: 'org_A',
      expires_in: 300,
    })
  }
  if (u.pathname === '/v1/auth/me') {
    if (!headers.Authorization) return json(401, { detail: 'bearer token required' })
    return json(200, { tenantId: 'tenant_1', userId: 'user_1', role: meRole, email: 'ana@acme.test', sessionId: 'sess_1' })
  }
  if (u.pathname === '/v1/auth/refresh') {
    refreshCalls++
    if (rejectRefresh || body?.refreshToken === 'expired') return json(401, { detail: 'sign-in could not be completed' })
    if (rejectSwitchOrg && body?.organizationId === rejectSwitchOrg) {
      return json(401, { detail: 'organization switch refused: no active membership' })
    }
    const org = (body?.organizationId as string) ?? 'org_A'
    return json(200, {
      access_token: jwt({ sub: 'user_1', org_id: org, sid: `sess_${refreshCalls + 1}`, client_id: 'client_123' }),
      refresh_token: 'rt_2',
      organization_id: org,
      expires_in: 300,
    })
  }
  if (u.pathname === '/v1/auth/logout') {
    return json(200, { url: 'https://api.workos.com/user_management/sessions/logout?session_id=sess_1' })
  }
  if (u.pathname === '/v1/auth/organizations') {
    return json(200, {
      organizations: [
        { id: 'org_A', name: 'Acme', role: 'editor', active: true, current: body?.organizationId !== 'org_B' },
        { id: 'org_B', name: 'Beta', role: 'viewer', active: true, current: false },
      ],
      degraded: false,
    })
  }
  if (u.pathname === '/v1/projects') {
    if (!headers.Authorization) return json(401, { detail: 'bearer token required' })
    if (rejectToken && headers.Authorization === `Bearer ${rejectToken}`) return json(401, { detail: 'token expired' })
    return json(200, { projects: [] })
  }
  return json(404, {})
}

const S = await import('./session')
const A = await import('./apiAuth')
S.configureSession({ base: 'http://api.test' })
A.setAuthTokenProvider(() => S.currentToken())

const reset = () => {
  S.resetSessionForTests()
  mem.clear()
  calls.length = 0
  refreshCalls = 0
  callbackCalls = 0
  rejectRefresh = false
  rejectSwitchOrg = null
  rejectToken = null
  navigations.length = 0
}

// 1. Sign-in: server-issued state is remembered, redirect URI + return path travel with it.
await S.startSignIn({ navigate: (url) => navigations.push(url) })
assert.equal(navigations[0], 'https://api.workos.com/authorize?state=st-1')
const login = calls.find((c) => c.path === '/v1/auth/login')!
assert.equal(new URLSearchParams(login.search).get('redirect_uri'), 'http://app.test/auth/callback')
assert.equal(new URLSearchParams(login.search).get('returnTo'), '/network?room=2')
const pending = S.readPendingSignIn()
assert.deepEqual(pending, { state: 'st-1', returnTo: '/network?room=2', redirectUri: 'http://app.test/auth/callback' })

// 2. A state that does not match is refused before any code is exchanged.
await assert.rejects(
  () => S.completeSignIn({ code: 'code_1', state: 'st-other' }),
  (e: unknown) => e instanceof S.AuthError && e.code === 'state_mismatch',
)
assert.equal(callbackCalls, 0, 'mismatched state must not reach the API')

// 3. The real callback stores the session, reads the role, and persists no bearer.
const session = await S.completeSignIn({ code: 'code_1', state: 'st-1' })
assert.equal(session.organizationId, 'org_A')
assert.equal(session.role, 'editor')
assert.equal(session.email, 'ana@acme.test')
assert.equal(session.sessionId, 'sess_1')
const stored = JSON.parse(mem.get(S.SESSION_KEY)!)
assert.equal(stored.accessToken, '', 'the access token must not be persisted')
assert.equal(stored.refreshToken, 'rt_1')
assert.equal(S.currentToken(), session.accessToken)
assert.equal(A.authHeaders().Authorization, `Bearer ${session.accessToken}`)
assert.equal(S.readPendingSignIn(), null)

// 4. authFetch refreshes once on 401 and replays the request with the new token.
const before = refreshCalls
rejectToken = session.accessToken
const res = await A.authFetch('http://api.test/v1/projects')
assert.equal(res.status, 200)
assert.equal(refreshCalls, before + 1)
assert.equal(S.getSession()?.refreshToken, 'rt_2')
const replay = calls.at(-1)!
assert.match(replay.auth!, /^Bearer ey/)

// 5. Parallel refreshes share a single request.
const n = refreshCalls
const [a, b] = await Promise.all([S.refreshSession(), S.refreshSession()])
assert.equal(refreshCalls, n + 1, 'refresh must be single-flight')
assert.equal(a?.refreshToken, b?.refreshToken)

// 6. Switching organization refreshes for that org and re-reads the role.
await S.switchOrganization('org_B')
const switchCall = calls.filter((c) => c.path === '/v1/auth/refresh').at(-1)!
assert.equal((switchCall.body as { organizationId?: string }).organizationId, 'org_B')
assert.equal(S.getSession()?.organizationId, 'org_B')
const orgs = await S.listOrganizations()
assert.deepEqual(orgs.organizations.map((o) => o.id), ['org_A', 'org_B'])

// 6b. A switch the server refuses keeps the session: the visitor stays in the
// workspace they were in, with the token they already hold, and the error
// reaches the caller. Signing them out would lose a working session.
rejectSwitchOrg = 'org_phantom'
const held = S.getSession()
await assert.rejects(
  () => S.switchOrganization('org_phantom'),
  (e: unknown) => e instanceof S.AuthError && e.message.includes('no active membership'),
)
assert.equal(S.getSession()?.organizationId, held?.organizationId, 'a refused switch must not move the workspace')
assert.equal(S.getSession()?.refreshToken, held?.refreshToken, 'the refresh token is kept')
assert.equal(S.currentToken()?.startsWith('ey'), true, 'the session stays usable')
assert.equal(mem.has(S.SESSION_KEY), true, 'the session stays persisted')
rejectSwitchOrg = null

// 7. Role ranking mirrors the server matrix.
assert.equal(S.can('viewer', 'admin'), false)
assert.equal(S.can('editor', 'viewer'), true)
assert.equal(S.can('member', 'editor'), true)
assert.equal(S.can('owner', 'admin'), true)

// 8. A rejected refresh ends the session instead of looping.
rejectRefresh = true
await assert.rejects(() => S.refreshSession())
assert.equal(S.getSession(), null)

// 9. Restore after reload: the blank-token copy is exchanged for a usable one.
S.resetSessionForTests()
mem.set(S.SESSION_KEY, JSON.stringify({
  ...session, accessToken: '', refreshToken: 'rt_restore', expiresAt: Date.now() - 1000,
}))
rejectRefresh = false
const restored = await S.restoreSession()
assert.equal(restored?.accessToken.startsWith('ey'), true)
assert.equal(restored?.organizationId, 'org_A')

// 10. Sign-out clears local state and follows the WorkOS session logout URL.
await S.signOut({ navigate: (url) => navigations.push(url) })
assert.equal(S.getSession(), null)
assert.equal(mem.has(S.SESSION_KEY), false)
assert.ok(navigations.at(-1)!.includes('/user_management/sessions/logout'))

// 11. Without WorkOS the module reports local mode and never pretends to sign in.
reset()
;(globalThis as { fetch?: unknown }).fetch = async (url: string) => {
  if (new URL(url).pathname === '/v1/auth/config') {
    return new Response(JSON.stringify({ mode: 'off', workosEnabled: false, redirectUri: null, allowLoopbackRedirect: true, roles: [] }), { status: 200 })
  }
  return new Response('{}', { status: 404 })
}
await assert.rejects(() => S.startSignIn({}), (e: unknown) => e instanceof S.AuthError && e.code === 'not_configured')

reset()
await S.loadAuthConfig()
assert.equal(S.sessionPhase(S.getAuthConfig()), 'local')

console.log('session: ok')
