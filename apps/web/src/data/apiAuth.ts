/**
 * Auth seam for /v1 calls. Today: API dev bypass (AUTH_MODE=dev) identified by
 * optional VITE_DEV_TENANT / VITE_DEV_USER. FF-106 (WorkOS) registers a token
 * provider with setAuthTokenProvider() and every caller picks up the bearer token.
 */

type Env = { VITE_DEV_TENANT?: string; VITE_DEV_USER?: string }

const env: Env =
  (typeof import.meta !== 'undefined' && (import.meta as ImportMeta & { env?: Env }).env) || {}

let tokenProvider: (() => string | null) | null = null

export function setAuthTokenProvider(fn: (() => string | null) | null) {
  tokenProvider = fn
}

export function authHeaders(): Record<string, string> {
  const token = tokenProvider?.()
  if (token) return { Authorization: `Bearer ${token}` }
  const h: Record<string, string> = {}
  if (env.VITE_DEV_TENANT) h['X-Dev-Tenant'] = env.VITE_DEV_TENANT
  if (env.VITE_DEV_USER) h['X-Dev-User'] = env.VITE_DEV_USER
  return h
}
