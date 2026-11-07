/**
 * Auth seam for /v1 calls.
 *
 * * `AUTH_MODE=off|dev` — API dev bypass (optional `VITE_DEV_TENANT` / `VITE_DEV_USER`).
 * * `AUTH_MODE=workos` — the session layer (`data/session.ts`) holds the access
 *   token and registers it here, so every caller sends a bearer and recovers
 *   from an expired token with one transparent refresh.
 */

import { authFetch as sessionAuthFetch, currentToken } from './session'

type Env = { VITE_DEV_TENANT?: string; VITE_DEV_USER?: string }

const env: Env =
  (typeof import.meta !== 'undefined' && (import.meta as ImportMeta & { env?: Env }).env) || {}

let tokenProvider: (() => string | null) | null = null

export function setAuthTokenProvider(fn: (() => string | null) | null) {
  tokenProvider = fn
}

export function authHeaders(): Record<string, string> {
  const token = tokenProvider?.() ?? currentToken()
  if (token) return { Authorization: `Bearer ${token}` }
  const h: Record<string, string> = {}
  if (env.VITE_DEV_TENANT) h['X-Dev-Tenant'] = env.VITE_DEV_TENANT
  if (env.VITE_DEV_USER) h['X-Dev-User'] = env.VITE_DEV_USER
  return h
}

/**
 * `fetch` for `/v1` with the session bearer, dev headers, and a single refresh
 * retry on 401. Callers still receive the 401 when the session cannot be saved.
 */
export async function authFetch(input: string, init: RequestInit = {}): Promise<Response> {
  return sessionAuthFetch(input, {
    ...init,
    headers: { ...authHeaders(), ...(init.headers ?? {}) },
  })
}
