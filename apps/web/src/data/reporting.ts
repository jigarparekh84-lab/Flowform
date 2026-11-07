/**
 * Client error reporting (CR-003).
 *
 * One seam for everything the browser observes — render errors caught by the
 * ErrorBoundary, and uncaught errors or rejections from event handlers and
 * async work — so choosing a sink is configuration, not a code change.
 *
 * Deliberate limits:
 *
 * * **Off by default.** Without `VITE_SENTRY_DSN` nothing leaves the browser:
 *   the SDK is never fetched and reports go to the console instead.
 * * **No customer data.** A report is a message, a scrubbed URL, a source tag
 *   and scalar extras. Query strings (share links, OAuth codes and state),
 *   bearer tokens and JWTs are redacted before the sink sees them, and the
 *   token storage is never read.
 * * **Bounded.** Identical reports de-duplicate for 5 s, at most 12 are held
 *   while the lazily loaded SDK starts, and long strings are truncated.
 *
 * Sentry's own global handlers are switched off in `init`: the seam owns the
 * capture path so a report cannot arrive twice, once scrubbed and once raw.
 */

// Sentry's error event (aliased: the DOM also has an `ErrorEvent`).
import type { ErrorEvent as SentryErrorEvent } from '@sentry/browser'

const DEDUPE_WINDOW_MS = 5_000
const MAX_PENDING = 12
const MAX_MESSAGE = 1_000
const MAX_STACK = 4_000
const MAX_SECONDARY = 300
const MAX_EXTRA_KEYS = 8
const MAX_REMEMBERED = 200

export type ErrorPayload = {
  message: string
  stack?: string
  /** Where it was caught: `error-boundary`, `window.error`, `unhandledrejection`. */
  source: string
  /** Origin + path only; query and hash are dropped before this is set. */
  url: string
  environment?: string
  release?: string
  requestId?: string
  extra?: Record<string, string | number | boolean>
}

export type ErrorContext = {
  source?: string
  requestId?: string
  /** React's component stack for render errors; kept longer than other text. */
  componentStack?: string
  /** Scalar extras only; objects, arrays and functions are dropped. */
  extra?: Record<string, unknown>
}

export type ErrorSink = (payload: ErrorPayload) => void

type ReportingEnv = {
  VITE_SENTRY_DSN?: string
  VITE_SENTRY_ENVIRONMENT?: string
  VITE_SENTRY_RELEASE?: string
  VITE_APP_RELEASE?: string
}

/** The subset of `window` the global handlers need (and tests can fake). */
export type ErrorTarget = {
  addEventListener(type: string, listener: (event: unknown) => void): void
  removeEventListener(type: string, listener: (event: unknown) => void): void
}

// ---------------------------------------------------------------- scrubbing

const SHARE_LINK = /(flowform:\/\/share\?)[^\s"']*/gi
const JWT = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]*/g
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi
const SECRET_QUERY =
  /([?&](?:access_token|refresh_token|id_token|token|code|state|key|secret|password)=)[^&\s"']*/gi

/** Redact credentials in free text (messages, stacks, breadcrumbs). */
export function scrubText(text: string, limit = MAX_MESSAGE): string {
  const scrubbed = text
    .replace(SHARE_LINK, '$1[redacted]')
    .replace(JWT, '[redacted-jwt]')
    .replace(BEARER, 'Bearer [redacted]')
    .replace(SECRET_QUERY, '$1[redacted]')
  return scrubbed.length > limit ? `${scrubbed.slice(0, limit)}…` : scrubbed
}

/** Keep the route, drop everything that carries a credential or a payload. */
export function scrubUrl(url: string): string {
  if (!url) return ''
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return scrubText(url, MAX_SECONDARY)
    }
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return scrubText(url, MAX_SECONDARY)
  }
}

// ------------------------------------------------------------------ payload

function describe(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return { message: error.message || error.name, stack: error.stack }
  }
  if (typeof error === 'string') return { message: error }
  if (error === null || error === undefined) return { message: 'Unknown error' }
  try {
    return { message: JSON.stringify(error) ?? String(error) }
  } catch {
    return { message: String(error) }
  }
}

function scalars(extra: Record<string, unknown> | undefined) {
  if (!extra) return undefined
  const out: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(extra)) {
    if (Object.keys(out).length >= MAX_EXTRA_KEYS) break
    if (typeof value === 'string') out[key] = scrubText(value, MAX_SECONDARY)
    else if (typeof value === 'number') out[key] = Number.isFinite(value) ? value : 0
    else if (typeof value === 'boolean') out[key] = value
  }
  return Object.keys(out).length ? out : undefined
}

let environment: string | undefined
let release: string | undefined

function currentUrl(): string {
  if (typeof window === 'undefined') return ''
  return scrubUrl(window.location.href)
}

export function toPayload(error: unknown, context: ErrorContext = {}): ErrorPayload {
  const { message, stack } = describe(error)
  const payload: ErrorPayload = {
    message: scrubText(message),
    source: context.source ?? 'app',
    url: currentUrl(),
  }
  if (stack) payload.stack = scrubText(stack, MAX_STACK)
  if (context.requestId) payload.requestId = scrubText(context.requestId, MAX_SECONDARY)
  const extra = scalars(context.extra) ?? {}
  if (context.componentStack) {
    extra.componentStack = scrubText(context.componentStack, MAX_STACK)
  }
  if (Object.keys(extra).length) payload.extra = extra
  if (environment) payload.environment = environment
  if (release) payload.release = release
  return payload
}

// ------------------------------------------------------------------ reporting

let sink: ErrorSink | null = null
let clock: () => number = () => Date.now()
let dedupeWindowMs = DEDUPE_WINDOW_MS
const recent = new Map<string, number>()
const pending: ErrorPayload[] = []

function deliver(payload: ErrorPayload): void {
  if (!sink) return
  try {
    sink(payload)
  } catch (e) {
    // A broken sink must never break the app it is observing.
    console.warn('[flowform:report] sink failed', e)
  }
}

function flush(): void {
  if (!sink) return
  while (pending.length) {
    const payload = pending.shift()
    if (payload) deliver(payload)
  }
}

function remember(key: string, now: number): boolean {
  const last = recent.get(key)
  if (last !== undefined && now - last < dedupeWindowMs) return false
  recent.set(key, now)
  if (recent.size > MAX_REMEMBERED) {
    for (const [k, t] of recent) {
      if (now - t >= dedupeWindowMs) recent.delete(k)
    }
  }
  return true
}

/**
 * Report one error. Returns the payload (useful in tests and for local
 * debugging), or `null` when the report was a duplicate of one just sent.
 *
 * Never throws: error reporting is not allowed to be the second failure.
 */
export function reportError(error: unknown, context?: ErrorContext): ErrorPayload | null {
  const payload = toPayload(error, context)
  const now = clock()
  if (!remember(`${payload.source}|${payload.message}`, now)) return null

  if (!sink) {
    if (pending.length >= MAX_PENDING) pending.shift()
    pending.push(payload)
    // Keep the stack visible in local development, where there is no sink.
    console.error(`[flowform:report] ${payload.message}`, payload.stack ?? '')
    return payload
  }
  deliver(payload)
  return payload
}

/** Point the seam at a sink (or `null` to buffer and log locally). */
export function configureErrorReporting(options: {
  sink?: ErrorSink | null
  now?: () => number
  environment?: string
  release?: string
  dedupeWindowMs?: number
} = {}): void {
  if ('sink' in options) sink = options.sink ?? null
  if (options.now) clock = options.now
  if (options.environment !== undefined) environment = options.environment || undefined
  if (options.release !== undefined) release = options.release || undefined
  if (options.dedupeWindowMs !== undefined) dedupeWindowMs = options.dedupeWindowMs
  flush()
}

/** Detach the sink and forget everything buffered (tests, sign-out). */
export function resetErrorReporting(): void {
  sink = null
  clock = () => Date.now()
  dedupeWindowMs = DEDUPE_WINDOW_MS
  environment = undefined
  release = undefined
  recent.clear()
  pending.length = 0
}

// ------------------------------------------------------------ global handlers

/**
 * Route uncaught errors and unhandled rejections through `reportError`.
 * Returns the uninstall function; installing twice adds duplicate listeners, so
 * call it once per page (init does this for you).
 */
export function installGlobalErrorHandlers(
  target: ErrorTarget = window as unknown as ErrorTarget,
): () => void {
  const onError = (event: unknown) => {
    const e = event as { error?: unknown; message?: unknown }
    reportError(e.error ?? e.message ?? 'Uncaught error', { source: 'window.error' })
  }
  const onRejection = (event: unknown) => {
    const e = event as { reason?: unknown }
    reportError(e.reason ?? 'Unhandled rejection', { source: 'unhandledrejection' })
  }
  target.addEventListener('error', onError)
  target.addEventListener('unhandledrejection', onRejection)
  return () => {
    target.removeEventListener('error', onError)
    target.removeEventListener('unhandledrejection', onRejection)
  }
}

// ------------------------------------------------------------------ Sentry

/** Last line of defence for events Sentry captures outside the seam. */
function redactEvent(event: SentryErrorEvent): SentryErrorEvent {
  if (event.message) event.message = scrubText(event.message)
  if (event.request?.url) event.request.url = scrubUrl(event.request.url)
  for (const value of event.exception?.values ?? []) {
    if (value.value) value.value = scrubText(value.value, MAX_STACK)
  }
  for (const crumb of event.breadcrumbs ?? []) {
    if (crumb.message) crumb.message = scrubText(crumb.message, MAX_SECONDARY)
  }
  return event
}

function readEnv(): ReportingEnv {
  const env = (import.meta as ImportMeta & { env?: ReportingEnv }).env
  return env ?? {}
}

/**
 * Start reporting if `VITE_SENTRY_DSN` is set; otherwise stay silent. Safe to
 * call once at boot — it installs the global handlers on success and leaves the
 * console fallback in place on failure.
 */
export async function initErrorReporting(env: ReportingEnv = readEnv()): Promise<boolean> {
  const dsn = (env.VITE_SENTRY_DSN ?? '').trim()
  const envName = (env.VITE_SENTRY_ENVIRONMENT ?? '').trim() || undefined
  const rel = (env.VITE_SENTRY_RELEASE ?? '').trim() || (env.VITE_APP_RELEASE ?? '').trim() || undefined
  configureErrorReporting({ environment: envName, release: rel })
  if (!dsn) return false

  try {
    const Sentry = await import('@sentry/browser')
    Sentry.init({
      dsn,
      environment: envName,
      release: rel,
      // SDK v11 replaced `sendDefaultPii` with per-category collection: collect
      // nothing beyond the payload this module already built and scrubbed.
      dataCollection: {
        userInfo: false,
        cookies: false,
        httpHeaders: false,
        httpBodies: [],
        urlQueryParams: false,
      },
      tracesSampleRate: 0,
      beforeSend: redactEvent,
      // The seam owns capture, so a report cannot arrive twice.
      integrations: (defaults) =>
        defaults.filter((i) => i.name !== 'GlobalHandlers' && i.name !== 'BrowserApiErrors'),
    })
    configureErrorReporting({
      sink: (payload) => {
        Sentry.withScope((scope) => {
          scope.setTag('source', payload.source)
          if (payload.requestId) scope.setTag('request_id', payload.requestId)
          scope.setContext('flowform', { url: payload.url, ...(payload.extra ?? {}) })
          const error = new Error(payload.message)
          if (payload.stack) error.stack = payload.stack
          Sentry.captureException(error)
        })
      },
    })
    installGlobalErrorHandlers()
    return true
  } catch (e) {
    console.warn('[flowform:report] Sentry did not start; reports stay local', e)
    return false
  }
}
