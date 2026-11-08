/**
 * WorkOS session lifecycle for the web (CR-010).
 *
 * Sign-in is a server-issued redirect: `/v1/auth/login` mints a signed state and
 * the AuthKit URL, the browser returns to `/auth/callback`, and `/v1/auth/callback`
 * exchanges the code only if that state comes back intact. Tokens are never put
 * in `localStorage`: the access token lives in memory, the refresh token in
 * `sessionStorage` (gone when the tab closes, so a reload survives but a shared
 * machine does not). Every `/v1` request goes through `authFetch`, which refreshes
 * once on a 401 before giving up.
 *
 * In `AUTH_MODE=off|dev` the workspace runs without a provider; the account menu
 * reports "local mode" and nothing here is required for the studio to work.
 */

import { DEFAULT_API_BASE } from './apiBase'

export const SESSION_KEY = 'flowform-session'
export const PENDING_KEY = 'flowform-auth-pending'

export type AuthUser = {
  id?: string
  email?: string
  firstName?: string | null
  lastName?: string | null
}

export type Organization = {
  id: string
  name: string
  role: string
  active: boolean
  current: boolean
}

export type AuthConfig = {
  mode: string
  workosEnabled: boolean
  redirectUri: string | null
  allowLoopbackRedirect: boolean
  roles: string[]
  /** CR-012: the API is running the header-based dev bypass. */
  devAuth?: boolean
  warning?: string | null
}

export type Session = {
  accessToken: string
  refreshToken: string | null
  /** ms since epoch */
  expiresAt: number
  user: AuthUser | null
  email: string | null
  organizationId: string | null
  tenantId: string | null
  sessionId: string | null
  role: string | null
}

export type SessionPhase = 'loading' | 'local' | 'anonymous' | 'signedIn'

type SessionStorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export const ROLES = ['viewer', 'editor', 'admin', 'owner'] as const
export type Role = (typeof ROLES)[number]

export class AuthError extends Error {
  code: 'state_mismatch' | 'exchange_failed' | 'provider_error' | 'not_signed_in' | 'not_configured'
  constructor(code: AuthError['code'], message: string) {
    super(message)
    this.name = 'AuthError'
    this.code = code
  }
}

// ---------------------------------------------------------------- module state

let base = DEFAULT_API_BASE
let config: AuthConfig | null = null
let session: Session | null = null
let refreshTimer: ReturnType<typeof setTimeout> | null = null
let inflightRefresh: Promise<Session | null> | null = null
let inflightRestore: Promise<Session | null> | null = null

const subs = new Set<(s: Session | null) => void>()

/** Test/config hook. */
export function configureSession(opts: { base?: string }) {
  if (opts.base) base = opts.base
}

export function getAuthConfig(): AuthConfig | null {
  return config
}

export function getSession(): Session | null {
  return session
}

export function currentToken(): string | null {
  return session?.accessToken ?? null
}

export function subscribeSession(fn: (s: Session | null) => void): () => void {
  subs.add(fn)
  return () => subs.delete(fn)
}

function setSession(next: Session | null, { persist = true } = {}) {
  session = next
  if (persist) {
    const store = storage()
    if (next) store?.setItem(SESSION_KEY, JSON.stringify({ ...next, accessToken: '', refreshToken: next.refreshToken }))
    else store?.removeItem(SESSION_KEY)
  }
  scheduleRefresh()
  subs.forEach((fn) => fn(next))
}

/**
 * The persisted copy deliberately blanks the access token: a reload re-fetches
 * one with the refresh token instead of resting a usable bearer in web storage.
 */
function storage(): SessionStorageLike | null {
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- JWT helpers

function decodeJwt(token: string): Record<string, unknown> | null {
  const part = token.split('.')[1]
  if (!part) return null
  try {
    const raw = atob(part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '='))
    const json = decodeURIComponent(
      raw
        .split('')
        .map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`)
        .join(''),
    )
    return JSON.parse(json) as Record<string, unknown>
  } catch {
    return null
  }
}

export function expiresAtFrom(token: string, expiresIn?: number | null): number {
  if (expiresIn && expiresIn > 0) return Date.now() + expiresIn * 1000
  const claims = decodeJwt(token)
  const exp = typeof claims?.exp === 'number' ? claims.exp : null
  return exp ? exp * 1000 : Date.now() + 300_000
}

export function isExpiring(s: Session | null, skewMs = 60_000): boolean {
  return Boolean(s && s.expiresAt - skewMs <= Date.now())
}

export function rank(role: string | null | undefined): number {
  const r = (role ?? '').toLowerCase()
  const ix = (ROLES as readonly string[]).indexOf(r === 'member' ? 'editor' : r === 'modeler' ? 'editor' : r)
  return ix < 0 ? -1 : ix
}

export function can(role: string | null | undefined, need: Role): boolean {
  return rank(role) >= rank(need)
}

// ---------------------------------------------------------------- HTTP

type TokenPayload = {
  access_token?: string
  refresh_token?: string | null
  user?: AuthUser | null
  organization_id?: string | null
  expires_in?: number | null
  return_to?: string | null
}

async function json<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new AuthError('exchange_failed', `${path} → ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`)
  }
  return (await res.json()) as T
}

export async function loadAuthConfig(force = false): Promise<AuthConfig> {
  if (config && !force) return config
  config = await json<AuthConfig>('/v1/auth/config')
  return config
}

function authHeaders(): Record<string, string> {
  return session ? { Authorization: `Bearer ${session.accessToken}` } : {}
}

/** `/v1` GET with the current bearer. */
async function getJson<T>(path: string): Promise<T> {
  return json<T>(path, { headers: authHeaders() })
}

// ---------------------------------------------------------------- sign-in

export type PendingSignIn = { state: string; returnTo: string | null; redirectUri: string }

function pendingStorage(): SessionStorageLike | null {
  return storage()
}

export function readPendingSignIn(): PendingSignIn | null {
  try {
    const raw = pendingStorage()?.getItem(PENDING_KEY)
    return raw ? (JSON.parse(raw) as PendingSignIn) : null
  } catch {
    return null
  }
}

function writePendingSignIn(p: PendingSignIn | null) {
  const store = pendingStorage()
  if (!store) return
  if (p) store.setItem(PENDING_KEY, JSON.stringify(p))
  else store.removeItem(PENDING_KEY)
}

/** Default callback URL, preferring the server-configured (allowlisted) one. */
export function callbackUrl(cfg: AuthConfig, origin: string): string {
  if (cfg.redirectUri) return cfg.redirectUri
  return `${origin.replace(/\/$/, '')}/auth/callback`
}

export type SignInOptions = {
  organizationId?: string
  returnTo?: string
  screenHint?: 'sign-in' | 'sign-up'
  /** Test seam: defaults to `window.location`. */
  origin?: string
  navigate?: (url: string) => void
}

/** Fetch the AuthKit URL from the API, remember the state, and leave the app. */
export async function startSignIn(opts: SignInOptions = {}): Promise<string> {
  const cfg = await loadAuthConfig(true)
  if (!cfg.workosEnabled) {
    throw new AuthError('not_configured', 'Sign-in is not configured on this server (AUTH_MODE / WorkOS keys).')
  }
  const origin = opts.origin ?? location.origin
  const redirectUri = callbackUrl(cfg, origin)
  const current = `${location.pathname}${location.search}`
  const returnTo = opts.returnTo ?? (location.pathname.startsWith('/auth/callback') ? '/' : current)
  const q = new URLSearchParams({ redirect_uri: redirectUri })
  if (returnTo) q.set('returnTo', returnTo)
  if (opts.organizationId) q.set('organizationId', opts.organizationId)
  if (opts.screenHint) q.set('screenHint', opts.screenHint)
  const out = await json<{ url: string; state: string; expiresIn: number }>(`/v1/auth/login?${q}`)
  writePendingSignIn({ state: out.state, returnTo, redirectUri })
  if (opts.navigate) opts.navigate(out.url)
  else location.assign(out.url)
  return out.url
}

export type CallbackParams = { code?: string | null; state?: string | null; error?: string | null }

function applyTokens(payload: TokenPayload, previous?: Session | null): Session {
  const token = payload.access_token
  if (!token) throw new AuthError('exchange_failed', 'The identity provider returned no access token.')
  const claims = decodeJwt(token) ?? {}
  return {
    accessToken: token,
    refreshToken: payload.refresh_token ?? previous?.refreshToken ?? null,
    expiresAt: expiresAtFrom(token, payload.expires_in),
    user: payload.user ?? previous?.user ?? null,
    email:
      payload.user?.email ??
      (typeof claims.email === 'string' ? claims.email : null) ??
      previous?.email ??
      null,
    organizationId: payload.organization_id ?? (typeof claims.org_id === 'string' ? claims.org_id : null),
    tenantId: previous?.tenantId ?? null,
    sessionId: typeof claims.sid === 'string' ? claims.sid : null,
    role: typeof claims.role === 'string' ? claims.role : (previous?.role ?? null),
  }
}

async function hydrateMe(): Promise<void> {
  if (!session) return
  try {
    const me = await getJson<{ tenantId?: string; userId?: string; role?: string; email?: string | null }>('/v1/auth/me')
    setSession({
      ...session,
      tenantId: me.tenantId ?? session.tenantId,
      role: me.role ?? session.role,
      email: me.email ?? session.email,
      user: { ...(session.user ?? {}), id: me.userId ?? session.user?.id },
    })
  } catch {
    /* signed in but not yet provisioned/organisation-less: the menu shows the warning */
  }
}

/**
 * Finish the redirect: prove the state the server issued came back, exchange the
 * code, then read `/v1/auth/me` for the effective role.
 */
export async function completeSignIn(params: CallbackParams): Promise<Session> {
  if (params.error) throw new AuthError('provider_error', params.error)
  if (!params.code) throw new AuthError('exchange_failed', 'Missing authorization code.')
  const pending = readPendingSignIn()
  if (pending && pending.state !== params.state) {
    throw new AuthError('state_mismatch', 'Sign-in state did not match; it may have expired. Try again.')
  }
  const payload = await json<TokenPayload>('/v1/auth/callback', {
    method: 'POST',
    body: JSON.stringify({ code: params.code, state: params.state ?? '' }),
  })
  const next = applyTokens(payload)
  setSession(next)
  writePendingSignIn(null)
  await hydrateMe()
  return session ?? next
}

// ---------------------------------------------------------------- refresh

/** Rotate the access token; one refresh at a time even with parallel callers. */
export async function refreshSession(opts: { organizationId?: string } = {}): Promise<Session | null> {
  if (inflightRefresh) return inflightRefresh
  const refreshToken = session?.refreshToken
  if (!refreshToken) {
    setSession(null)
    return null
  }
  const previous = session
  inflightRefresh = (async () => {
    try {
      const payload = await json<TokenPayload>('/v1/auth/refresh', {
        method: 'POST',
        body: JSON.stringify({ refreshToken, organizationId: opts.organizationId }),
      })
      const next = applyTokens(payload, previous)
      setSession(next)
      return next
    } catch (e) {
      // A rejected refresh token means the session is over — except when the
      // failure came from an organization switch, where a refusal only means that
      // grant was not allowed. Then the visitor stays in the workspace they were
      // in and the UI shows why the switch failed.
      if (!opts.organizationId) setSession(null)
      throw e instanceof AuthError ? e : new AuthError('exchange_failed', 'Session refresh failed.')
    } finally {
      inflightRefresh = null
    }
  })()
  return inflightRefresh
}

function scheduleRefresh() {
  if (refreshTimer !== null) {
    clearTimeout(refreshTimer)
    refreshTimer = null
  }
  if (!session?.refreshToken) return
  const at = Math.max(5_000, session.expiresAt - Date.now() - 60_000)
  refreshTimer = setTimeout(() => {
    refreshTimer = null
    void refreshSession().catch(() => {
      /* the next 401 or the account menu surfaces the expired session */
    })
  }, at)
  // Never hold a Node process (tests) or a closing tab open for this.
  if (typeof refreshTimer === 'object' && refreshTimer && 'unref' in refreshTimer) {
    ;(refreshTimer as unknown as { unref: () => void }).unref()
  }
}

/**
 * `/v1` fetch with the session bearer: one transparent refresh on 401, then the
 * caller sees the response (so it can still render its own 401/403 state).
 */
export async function authFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const withAuth = (): RequestInit => ({
    ...init,
    headers: { ...(init.headers ?? {}), ...authHeaders() },
  })
  let res = await fetch(input, withAuth())
  if (res.status === 401 && session?.refreshToken) {
    try {
      await refreshSession()
    } catch {
      return res
    }
    res = await fetch(input, withAuth())
  }
  return res
}

// ---------------------------------------------------------------- sign-out

/** Clear local state first, then end the WorkOS session when there is one. */
export async function signOut(opts: { returnTo?: string; navigate?: (url: string) => void } = {}): Promise<void> {
  const hadSession = session
  let url: string | null = null
  if (hadSession) {
    try {
      const out = await json<{ url: string | null }>('/v1/auth/logout', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ returnTo: opts.returnTo ?? '/' }),
      })
      url = out.url
    } catch {
      /* provider unreachable: local sign-out still must succeed */
    }
  }
  setSession(null, { persist: false })
  writePendingSignIn(null)
  storage()?.removeItem(SESSION_KEY)
  if (url) {
    if (opts.navigate) opts.navigate(url)
    else location.assign(url)
  }
}

// ---------------------------------------------------------------- organizations

export async function listOrganizations(): Promise<{ organizations: Organization[]; degraded: boolean }> {
  return getJson<{ organizations: Organization[]; degraded: boolean }>('/v1/auth/organizations')
}

/**
 * Switch the active organization by refreshing the session for that org — the
 * WorkOS-documented way to change `org_id` without a second full sign-in.
 */
export async function switchOrganization(organizationId: string): Promise<Session | null> {
  const next = await refreshSession({ organizationId })
  await hydrateMe()
  return next ?? session
}

// ---------------------------------------------------------------- bootstrap

export function sessionPhase(cfg: AuthConfig | null): SessionPhase {
  if (!cfg) return 'loading'
  if (!cfg.workosEnabled) return 'local'
  return session ? 'signedIn' : 'anonymous'
}

/**
 * Restore a session on page load. The stored copy has no usable access token,
 * so the refresh token is exchanged for a fresh one immediately. The promise is
 * shared so a double-mounted StrictMode provider cannot race itself.
 */
export function restoreSession(): Promise<Session | null> {
  inflightRestore ??= doRestoreSession()
  return inflightRestore
}

async function doRestoreSession(): Promise<Session | null> {
  let stored: Session | null = null
  try {
    const raw = storage()?.getItem(SESSION_KEY)
    stored = raw ? (JSON.parse(raw) as Session) : null
  } catch {
    stored = null
  }
  if (!stored?.refreshToken) return null
  session = { ...stored, accessToken: '' }
  try {
    return await refreshSession()
  } catch {
    return null
  }
}

/** Reset module state (tests). */
export function resetSessionForTests() {
  session = null
  config = null
  inflightRestore = null
  if (refreshTimer !== null) clearTimeout(refreshTimer)
  refreshTimer = null
  inflightRefresh = null
}
