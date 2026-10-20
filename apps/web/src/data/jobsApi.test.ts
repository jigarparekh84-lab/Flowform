/** Web job client: job path, progress, cancel, and fallback to sync. */
import assert from 'node:assert/strict'

const mem = new Map<string, string>()
;(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k), clear: () => mem.clear(),
}
let jobsUp = true
let runStatus = 'running'
let cancelled = 0
let syncCalls = 0
const result = { ok: true, objectiveBreakdown: { totalM: 98.2706 } }
;(globalThis as { fetch?: unknown }).fetch = async (url: string, init: RequestInit = {}) => {
  const path = new URL(url).pathname
  const j = (status: number, b: unknown) => new Response(JSON.stringify(b), { status })
  if (path === '/optimize') { syncCalls++; return j(200, { ...result, via: 'sync' }) }
  if (!jobsUp) throw new TypeError('fetch failed')
  if (path === '/v1/projects' && init.method === 'POST') return j(201, { id: 'srv-1' })
  if (path === '/v1/projects/srv-1/runs') return j(202, { id: 'run-1', status: 'queued' })
  if (path === '/v1/projects/srv-1/runs/run-1/cancel') { cancelled++; runStatus = 'cancelled'; return j(200, {}) }
  if (path === '/v1/projects/srv-1/runs/run-1') {
    const s = runStatus
    if (runStatus === 'running') runStatus = 'succeeded'
    return j(200, { status: s, progress: s === 'succeeded' ? 1 : 0.1, message: s, result: s === 'succeeded' ? result : null })
  }
  return j(404, {})
}

const P = await import('./projects')
const W = await import('./workspaceSync')
const J = await import('./jobsApi')
W.configureWorkspaceSync({ base: 'http://api.test', enabled: true, debounceMs: 0 })
J.configureJobs({ pollMs: 1 })
P.createProject('Jobs', { version: 1, network: { nodes: [], lanes: [], demandVolume: {} }, scenarios: [] } as never)

const seen: string[] = []
J.subscribeActiveJob((a) => a && seen.push(`${a.status}`))

// 1. Job path: enqueues, reports progress, returns the result.
let r = await J.solveRequest('http://api.test', '/optimize', { network: {} })
assert.deepEqual(await r.json(), result)
assert.ok(seen.includes('queued') && seen.includes('succeeded'))
assert.equal(syncCalls, 0)
assert.equal(J.getActiveJob(), null)

// 2. Cancel: server cancel endpoint is called and the caller gets RunCancelledError.
runStatus = 'running'
const p = J.solveRequest('http://api.test', '/optimize/multi-period', {})
await new Promise((res) => setTimeout(res, 0))
void J.cancelActiveRun('http://api.test')
await assert.rejects(p, (e: unknown) => J.isRunCancelled(e))
assert.ok(cancelled >= 1)

// 3. Job API unreachable → transparent sync fallback.
jobsUp = false
r = await J.solveRequest('http://api.test', '/optimize', {})
assert.equal(((await r.json()) as { via: string }).via, 'sync')
assert.equal(syncCalls, 1)

// 4. Forced sync mode.
jobsUp = true
J.configureJobs({ mode: 'sync' })
await J.solveRequest('http://api.test', '/optimize', {})
assert.equal(syncCalls, 2)
console.log('jobsApi: ok')
