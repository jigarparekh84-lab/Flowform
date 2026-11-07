/**
 * FF-107: workspace sync — migration, offline fallback, pull without switching
 * the open project. In-memory localStorage + fake /v1 API (no network).
 */
import assert from 'node:assert/strict'

const mem = new Map<string, string>()
;(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
}

type Row = { id: string; body: string; version: number }
const server = new Map<string, Row>()
let online = true
let quota = false
let seq = 0
;(globalThis as { fetch?: unknown }).fetch = async (url: string, init: RequestInit = {}) => {
  if (!online) throw new TypeError('fetch failed')
  const path = new URL(url).pathname
  const method = init.method ?? 'GET'
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  const m = path.match(/^\/v1\/projects(?:\/([^/]+))?(\/snapshot)?$/)
  if (!m) return json(404, {})
  const [, id, snap] = m
  if (!id && method === 'GET') return json(200, { projects: [...server.values()].map((r) => ({ id: r.id })) })
  if (!id && method === 'POST') {
    if (quota) {
      return new Response(
        JSON.stringify({ detail: 'at its 2-project limit (MAX_PROJECTS_PER_TENANT)' }),
        { status: 403, headers: { 'Content-Type': 'application/json', 'X-Quota-Limit': 'projects' } },
      )
    }
    const r = { id: `srv-${++seq}`, body: String(init.body), version: 1 }
    server.set(r.id, r)
    return json(201, { id: r.id, version: 1 })
  }
  const row = id ? server.get(id) : undefined
  if (!row) return json(404, {})
  if (snap) return new Response(row.body, { status: 200 })
  if (method === 'PUT') {
    row.body = String(init.body)
    row.version++
    return json(200, { id: row.id, version: row.version })
  }
  if (method === 'DELETE') {
    server.delete(row.id)
    return new Response(null, { status: 204 })
  }
  return json(200, { id: row.id, version: row.version })
}

const P = await import('./projects')
const S = await import('./workspaceSync')
S.configureWorkspaceSync({ base: 'http://api.test', enabled: true, debounceMs: 0 })

const snap = (name: string) =>
  ({ version: 1, network: { nodes: [], lanes: [], demandVolume: {} }, scenarios: [], name }) as never

// 1. Projects created before sync existed are local-only.
const a = P.createProject('Alpha', snap('a'))
const b = P.createProject('Beta', snap('b'))
assert.deepEqual(new Set(S.localOnlyProjects()), new Set([a.id, b.id]))

// 2. Offline: migration keeps them local, status flips, nothing lost.
online = false
let r = await S.migrateLocalProjects()
assert.equal(r.pushed, 0)
assert.equal(r.failed, 2)
assert.equal(S.getSyncStatus(), 'offline')
assert.equal(P.listProjectMeta().length, 2)

// 3. Back online: one click moves both.
online = true
r = await S.migrateLocalProjects()
assert.equal(r.pushed, 2)
assert.equal(server.size, 2)
assert.deepEqual(S.localOnlyProjects(), [])
assert.equal(S.getSyncStatus(), 'online')
const body = JSON.parse(server.get(S.serverLinks()[a.id])!.body)
assert.equal(body.format, 'flowform-project')
assert.equal(body.meta.name, 'Alpha')

// 4. Saves mirror to the server as new versions (listener + debounce).
S.installWorkspaceSync()
P.renameProject(a.id, 'Alpha 2')
await new Promise((res) => setTimeout(res, 20))
const ra = server.get(S.serverLinks()[a.id])!
assert.equal(ra.version, 2)
assert.equal(JSON.parse(ra.body).meta.name, 'Alpha 2')

// 5. Edits while offline are queued and flushed by the next migration.
online = false
P.renameProject(b.id, 'Beta offline')
await new Promise((res) => setTimeout(res, 20))
assert.ok(S.localOnlyProjects().includes(b.id))
online = true
await S.migrateLocalProjects()
assert.equal(JSON.parse(server.get(S.serverLinks()[b.id])!.body).meta.name, 'Beta offline')

// 6. Pull imports workspace projects from elsewhere without switching the open project.
server.set('srv-remote', {
  id: 'srv-remote',
  version: 1,
  body: JSON.stringify({ format: 'flowform-project', version: 1, meta: { id: 'x', name: 'Remote', createdAt: '', updatedAt: '' }, state: snap('r') }),
})
const activeBefore = P.getActiveProjectId()
const sizeBefore = server.size
assert.equal(await S.pullWorkspaceProjects(), 1)
assert.equal(P.getActiveProjectId(), activeBefore)
assert.ok(P.listProjectMeta().some((m) => m.name === 'Remote'))
assert.equal(server.size, sizeBefore, 'pull must not push a duplicate')
assert.equal(await S.pullWorkspaceProjects(), 0)

// 7. Delete removes the server copy.
P.deleteProject(a.id)
await new Promise((res) => setTimeout(res, 20))
assert.ok(![...server.values()].some((row) => JSON.parse(row.body).meta?.name === 'Alpha 2'))

// 8. A quota refusal (403 + X-Quota-Limit) is not reported as "not signed in".
quota = true
const g = P.createProject('Gamma', snap('g'))
await new Promise((res) => setTimeout(res, 20))
assert.equal(S.getSyncStatus(), 'quota')
assert.match(S.getQuotaMessage() ?? '', /MAX_PROJECTS_PER_TENANT/)
assert.ok(S.localOnlyProjects().includes(g.id), 'the project stays local, not lost')

quota = false
assert.equal(await S.pushProject(g.id), true)
assert.equal(S.getSyncStatus(), 'online')
assert.equal(S.getQuotaMessage(), null)
assert.ok(!S.localOnlyProjects().includes(g.id))

console.log('workspaceSync: ok')
