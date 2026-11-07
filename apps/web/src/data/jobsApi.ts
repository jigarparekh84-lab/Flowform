/**
 * Async solve jobs from the web (FF-105 client). Run / Roadmap / Robust call
 * solveRequest(); when the workspace is reachable it enqueues a server run
 * (POST /v1/projects/{id}/runs), polls progress, supports cancel, and returns
 * the same JSON the sync endpoint would. If the job API is unavailable (old
 * API, 401, no DB, network) it falls back to the sync endpoint transparently.
 *
 * VITE_RUN_MODE=sync forces the old path.
 */
import { authFetch } from './apiAuth'
import { getActiveProjectId } from './projects'
import { pushProject, serverLinks } from './workspaceSync'

export type JobKind = 'optimize' | 'multi-period' | 'stochastic'
export type ActiveJob = {
  kind: JobKind
  runId: string | null
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'sync'
  progress: number
  message: string
}

export class RunCancelledError extends Error {
  constructor() {
    super('Run cancelled')
    this.name = 'RunCancelledError'
  }
}
export const isRunCancelled = (e: unknown) => e instanceof RunCancelledError

const PATH_KIND: Record<string, JobKind> = {
  '/optimize': 'optimize',
  '/optimize/multi-period': 'multi-period',
  '/optimize/stochastic': 'stochastic',
}

type Env = { VITE_RUN_MODE?: string }
const env: Env =
  (typeof import.meta !== 'undefined' && (import.meta as ImportMeta & { env?: Env }).env) || {}

let mode: 'jobs' | 'sync' = env.VITE_RUN_MODE === 'sync' ? 'sync' : 'jobs'
let pollMs = 400
let active: ActiveJob | null = null
let cancelRequested = false
const subs = new Set<(j: ActiveJob | null) => void>()

export function configureJobs(o: { mode?: 'jobs' | 'sync'; pollMs?: number }) {
  if (o.mode) mode = o.mode
  if (o.pollMs !== undefined) pollMs = o.pollMs
}
export const getActiveJob = () => active
export function subscribeActiveJob(fn: (j: ActiveJob | null) => void): () => void {
  subs.add(fn)
  return () => subs.delete(fn)
}
function setActive(j: ActiveJob | null) {
  active = j
  subs.forEach((fn) => fn(j))
}

/** Cancel the in-flight run (job API cancel; sync runs are abandoned client-side). */
export async function cancelActiveRun(base: string): Promise<void> {
  cancelRequested = true
  const j = active
  const pid = serverProjectId()
  if (j?.runId && pid) {
    try {
      await authFetch(`${base}/v1/projects/${pid}/runs/${j.runId}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
    } catch {
      /* best effort */
    }
  }
}

function serverProjectId(): string | null {
  const local = getActiveProjectId()
  return local ? serverLinks()[local] ?? null : null
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

class FallbackToSync extends Error {}

async function viaJobs(base: string, kind: JobKind, body: unknown): Promise<Response> {
  const local = getActiveProjectId()
  if (!local) throw new FallbackToSync('no project')
  if (!serverLinks()[local] && !(await pushProject(local))) throw new FallbackToSync('project not on server')
  const pid = serverLinks()[local]
  const h = { 'Content-Type': 'application/json' }
  let res: Response
  try {
    res = await authFetch(`${base}/v1/projects/${pid}/runs`, { method: 'POST', headers: h, body: JSON.stringify({ kind, payload: body }) })
  } catch {
    throw new FallbackToSync('network')
  }
  if (res.status === 422) return res // invalid request: same answer the sync endpoint would give
  if (res.status !== 202) throw new FallbackToSync(`enqueue HTTP ${res.status}`)
  const run = (await res.json()) as { id: string }
  setActive({ kind, runId: run.id, status: 'queued', progress: 0, message: 'Queued' })
  // Past this point the run exists on the server: never silently re-run sync.
  for (;;) {
    if (cancelRequested) {
      await cancelActiveRun(base)
      throw new RunCancelledError()
    }
    await sleep(pollMs)
    let r: { status: ActiveJob['status']; progress: number; message: string | null; result?: unknown }
    try {
      const g = await authFetch(`${base}/v1/projects/${pid}/runs/${run.id}`, { headers: h })
      if (!g.ok) continue
      r = await g.json()
    } catch {
      continue // transient; keep polling
    }
    setActive({ kind, runId: run.id, status: r.status, progress: r.progress, message: r.message ?? r.status })
    if (r.status === 'succeeded') return new Response(JSON.stringify(r.result), { status: 200 })
    if (r.status === 'cancelled') throw new RunCancelledError()
    if (r.status === 'failed') return new Response(JSON.stringify({ detail: r.message ?? 'Run failed' }), { status: 500 })
  }
}

/** Drop-in for `fetch(base + path, {method:'POST', body})` on the solve endpoints. */
export async function solveRequest(base: string, path: string, body: unknown): Promise<Response> {
  const kind = PATH_KIND[path]
  cancelRequested = false
  try {
    if (kind && mode === 'jobs') {
      try {
        return await viaJobs(base, kind, body)
      } catch (e) {
        if (!(e instanceof FallbackToSync)) throw e
      }
    }
    setActive({ kind: kind ?? 'optimize', runId: null, status: 'sync', progress: 0.1, message: 'Solving (direct)' })
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (cancelRequested) throw new RunCancelledError()
    return res
  } finally {
    setActive(null)
  }
}
