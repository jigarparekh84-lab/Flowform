/**
 * Client error reporting (CR-003): scrubbing, buffering, de-duplication and the
 * global handlers. Runs under tsx like the other data tests — no browser.
 */
import assert from 'node:assert/strict'
import type { ErrorPayload } from './reporting'

const logs: string[] = []
console.error = (...args: unknown[]) => void logs.push(args.map(String).join(' '))
console.warn = (...args: unknown[]) => void logs.push(args.map(String).join(' '))

const R = await import('./reporting')

let now = 1_000
const sent: ErrorPayload[] = []

function reset() {
  R.resetErrorReporting()
  sent.length = 0
  logs.length = 0
  now = 1_000
  R.configureErrorReporting({ now: () => now })
}

// 1. URLs keep the route and drop everything that can carry a credential.
assert.equal(
  R.scrubUrl('https://app.test/auth/callback?code=abc123&state=xyz#frag'),
  'https://app.test/auth/callback',
)
assert.equal(R.scrubUrl('http://127.0.0.1:5180/?project=secret'), 'http://127.0.0.1:5180/')
// A share deep link is not http(s): redact the payload, keep the scheme.
assert.equal(R.scrubUrl('flowform://share?d=eyJwcm9qZWN0IjoiYSJ9'), 'flowform://share?[redacted]')
assert.equal(R.scrubUrl('not a url ?access_token=abc'), 'not a url ?access_token=[redacted]')
assert.equal(R.scrubUrl(''), '')

// 2. Free text: bearer tokens, JWTs and query secrets never reach a sink.
const dirty =
  'GET /v1/projects?access_token=tok_123 failed with Authorization: Bearer abcdefghijklmnop ' +
  'and cookie eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N'
const clean = R.scrubText(dirty)
assert.ok(clean.includes('access_token=[redacted]'), clean)
assert.ok(clean.includes('Bearer [redacted]'), clean)
assert.ok(clean.includes('[redacted-jwt]'), clean)
assert.ok(!clean.includes('tok_123') && !clean.includes('abcdefghijklmnop'), clean)
const long = R.scrubText('x'.repeat(1_500))
assert.ok(long.length <= 1_001 && long.endsWith('…'), `not truncated: ${long.length}`)

// 3. Nothing leaves the browser until a sink is attached; early reports buffer.
reset()
const early = R.reportError(new Error('before init'))
assert.equal(early?.message, 'before init')
assert.equal(early?.source, 'app')
assert.equal(sent.length, 0)
assert.ok(logs.some((l) => l.includes('before init')), 'console fallback logs locally')
R.configureErrorReporting({ sink: (p) => sent.push(p) })
assert.equal(sent.length, 1, 'buffered report flushes on configure')
assert.equal(sent[0].message, 'before init')

// 4. Identical reports de-duplicate for the window, then report again.
reset()
R.configureErrorReporting({ sink: (p) => sent.push(p) })
R.reportError(new Error('same'), { source: 'error-boundary' })
R.reportError(new Error('same'), { source: 'error-boundary' })
assert.equal(sent.length, 1, 'duplicate inside the window is dropped')
R.reportError(new Error('same'), { source: 'window.error' })
assert.equal(sent.length, 2, 'a different source is a different report')
now += 5_000
R.reportError(new Error('same'), { source: 'error-boundary' })
assert.equal(sent.length, 3, 'reports again once the window has passed')

// 5. Extras stay scalar and small; a component stack rides along untruncated.
reset()
const payload = R.toPayload(new TypeError('render failed'), {
  source: 'error-boundary',
  requestId: 'req-42',
  componentStack: `at ${'Component '.repeat(60)}`,
  extra: {
    room: 'Compare',
    count: 3,
    flag: true,
    nested: { secret: 'should not ship' },
    list: [1, 2, 3],
    a: 1,
    b: 2,
    c: 3,
    d: 4,
    e: 5,
    f: 6,
  },
})
assert.equal(payload.requestId, 'req-42')
assert.equal(payload.extra?.room, 'Compare')
assert.equal(payload.extra?.count, 3)
assert.equal(payload.extra?.flag, true)
assert.equal(payload.extra?.nested, undefined)
assert.equal(payload.extra?.list, undefined)
const componentStack = payload.extra?.componentStack
assert.ok(typeof componentStack === 'string' && componentStack.length > 300, 'component stack is kept in full')
assert.ok(Object.keys(payload.extra ?? {}).length <= 9, 'extra keys are capped')
assert.equal(payload.environment, undefined)
R.configureErrorReporting({ environment: 'staging', release: 'rel-7' })
const tagged = R.toPayload(new Error('tagged'))
assert.equal(tagged.environment, 'staging')
assert.equal(tagged.release, 'rel-7')

// 6. Uncaught errors and rejections reach the seam through one handler set.
reset()
R.configureErrorReporting({ sink: (p) => sent.push(p) })
const listeners = new Map<string, Array<(e: unknown) => void>>()
const target = {
  addEventListener(type: string, cb: (e: unknown) => void) {
    listeners.set(type, [...(listeners.get(type) ?? []), cb])
  },
  removeEventListener(type: string, cb: (e: unknown) => void) {
    listeners.set(type, (listeners.get(type) ?? []).filter((l) => l !== cb))
  },
}
const emit = (type: string, event: unknown) => {
  for (const cb of listeners.get(type) ?? []) cb(event)
}
const uninstall = R.installGlobalErrorHandlers(target)
emit('error', { error: new Error('uncaught render') })
emit('unhandledrejection', { reason: new TypeError('fetch failed') })
assert.deepEqual(
  sent.map((p) => `${p.source}:${p.message}`),
  ['window.error:uncaught render', 'unhandledrejection:fetch failed'],
)
uninstall()
assert.equal(listeners.get('error')?.length, 0, 'handler removed')
assert.equal(listeners.get('unhandledrejection')?.length, 0, 'handler removed')
emit('error', { error: new Error('after uninstall') })
assert.equal(sent.length, 2, 'no reports after uninstall')

// 7. A sink that throws is contained: reporting never breaks the app.
reset()
R.configureErrorReporting({
  sink: () => {
    throw new Error('sink exploded')
  },
})
assert.doesNotThrow(() => R.reportError(new Error('still reported')))
assert.ok(logs.some((l) => l.includes('sink failed')), 'the failure is logged once')

// 8. Without a DSN, init is silent and installs nothing.
reset()
assert.equal(await R.initErrorReporting({}), false)

console.log('reporting.test.ts — all assertions passed')
