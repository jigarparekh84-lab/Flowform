/**
 * Workspace sync (FF-107). localStorage stays the working copy (instant, works
 * offline); every local save is mirrored to the server /v1/projects API.
 * When the API is unreachable or unauthorised the app keeps working locally,
 * shows a banner, and queues the project for the next sync.
 *
 * VITE_PROJECT_STORE=local disables server sync entirely.
 */

import { authHeaders } from './apiAuth'
import { DEFAULT_API_BASE } from './optimizeApi'
import {
  exportProjectJson,
  getActiveProjectId,
  setActiveProjectId,
  importProjectFromJson,
  listProjectMeta,
  setProjectStorageListener,
  withoutStorageListener,
} from './projects'

export const LINKS_KEY = 'flowform-server-links'
export const PENDING_KEY = 'flowform-sync-pending'

export type SyncStatus = 'disabled' | 'unknown' | 'online' | 'offline' | 'unauthorized'

type Env = { VITE_PROJECT_STORE?: string }
const env: Env =
  (typeof import.meta !== 'undefined' && (import.meta as ImportMeta & { env?: Env }).env) || {}

let base = DEFAULT_API_BASE
let enabled = (env.VITE_PROJECT_STORE ?? 'api') !== 'local'
let status: SyncStatus = enabled ? 'unknown' : 'disabled'
let debounceMs = 1500
const timers = new Map<string, ReturnType<typeof setTimeout>>()
const subs = new Set<(s: SyncStatus) => void>()

/** Test/config hook. */
export function configureWorkspaceSync(opts: { base?: string; enabled?: boolean; debounceMs?: number }) {
  if (opts.base) base = opts.base
  if (opts.enabled !== undefined) {
    enabled = opts.enabled
    setStatus(enabled ? 'unknown' : 'disabled')
  }
  if (opts.debounceMs !== undefined) debounceMs = opts.debounceMs
}

export function getSyncStatus(): SyncStatus {
  return status
}

export function subscribeSyncStatus(fn: (s: SyncStatus) => void): () => void {
  subs.add(fn)
  return () => subs.delete(fn)
}

function setStatus(s: SyncStatus) {
  if (s === status) return
  status = s
  subs.forEach((fn) => fn(s))
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

export function serverLinks(): Record<string, string> {
  return readJson<Record<string, string>>(LINKS_KEY, {})
}

function setLink(localId: string, serverId: string | null) {
  const links = serverLinks()
  if (serverId) links[localId] = serverId
  else delete links[localId]
  localStorage.setItem(LINKS_KEY, JSON.stringify(links))
}

function pending(): string[] {
  return readJson<string[]>(PENDING_KEY, [])
}

function setPending(localId: string, on: boolean) {
  const set = new Set(pending())
  if (on) set.add(localId)
  else set.delete(localId)
  localStorage.setItem(PENDING_KEY, JSON.stringify([...set]))
}

/** Local projects not yet stored on the server (never linked, or with unsynced edits). */
export function localOnlyProjects(): string[] {
  const links = serverLinks()
  const p = new Set(pending())
  return listProjectMeta()
    .map((m) => m.id)
    .filter((id) => !links[id] || p.has(id))
}

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  let res: Response
  try {
    res = await fetch(`${base}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(init.headers ?? {}) },
    })
  } catch (e) {
    setStatus('offline')
    throw e
  }
  if (res.status === 401 || res.status === 403) {
    setStatus('unauthorized')
    throw new Error(`unauthorized (${res.status})`)
  }
  setStatus('online')
  return res
}

/** Push one local project (create or new version). Returns false when it stays local-only. */
export async function pushProject(localId: string): Promise<boolean> {
  if (!enabled) return false
  const file = exportProjectJson(localId)
  if (!file) return false
  const body = JSON.stringify(file)
  const serverId = serverLinks()[localId]
  try {
    let res = serverId
      ? await api(`/v1/projects/${serverId}`, { method: 'PUT', body })
      : await api('/v1/projects', { method: 'POST', body })
    if (res.status === 404 && serverId) {
      res = await api('/v1/projects', { method: 'POST', body })
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const out = (await res.json()) as { id: string }
    setLink(localId, out.id)
    setPending(localId, false)
    return true
  } catch {
    setPending(localId, true)
    return false
  }
}

export async function deleteRemoteProject(localId: string): Promise<void> {
  const serverId = serverLinks()[localId]
  setPending(localId, false)
  if (!enabled || !serverId) return
  try {
    await api(`/v1/projects/${serverId}`, { method: 'DELETE' })
  } catch {
    /* offline: server copy remains; harmless */
  }
  setLink(localId, null)
}

export function schedulePush(localId: string) {
  if (!enabled) return
  setPending(localId, true)
  clearTimeout(timers.get(localId))
  timers.set(
    localId,
    setTimeout(() => {
      timers.delete(localId)
      void pushProject(localId)
    }, debounceMs),
  )
}

/** Import workspace projects that this browser doesn't have yet. */
export async function pullWorkspaceProjects(): Promise<number> {
  if (!enabled) return 0
  const res = await api('/v1/projects')
  if (!res.ok) return 0
  const { projects } = (await res.json()) as { projects: { id: string }[] }
  const known = new Set(Object.values(serverLinks()))
  const active = getActiveProjectId()
  let n = 0
  for (const p of projects) {
    if (known.has(p.id)) continue
    const snap = await api(`/v1/projects/${p.id}/snapshot`)
    if (!snap.ok) continue
    const raw = JSON.parse(await snap.text()) as unknown
    const meta = withoutStorageListener(() => importProjectFromJson(raw))
    if (!meta) continue
    setLink(meta.id, p.id)
    n++
  }
  if (active) setActiveProjectId(active) // importing must not switch the open project
  return n
}

export type MigrationResult = { pushed: number; failed: number; pulled: number; status: SyncStatus }

/** One click: move every local-only project to the workspace, then pull the rest. */
export async function migrateLocalProjects(): Promise<MigrationResult> {
  let pushed = 0
  let failed = 0
  for (const id of localOnlyProjects()) {
    clearTimeout(timers.get(id)) // flush now instead of the debounced push
    timers.delete(id)
    if (await pushProject(id)) pushed++
    else failed++
  }
  let pulled = 0
  try {
    pulled = await pullWorkspaceProjects()
  } catch {
    /* offline */
  }
  return { pushed, failed, pulled, status }
}

/** Probe the API once; sets status for the banner. */
export async function probeWorkspace(): Promise<SyncStatus> {
  if (!enabled) return status
  try {
    await api('/v1/projects')
  } catch {
    /* status already set */
  }
  return status
}

export function installWorkspaceSync() {
  if (!enabled) return
  setProjectStorageListener({
    saved: schedulePush,
    renamed: schedulePush,
    deleted: (id) => void deleteRemoteProject(id),
  })
  void probeWorkspace().then((s) => {
    if (s === 'online' && pending().length) void migrateLocalProjects()
  })
}
