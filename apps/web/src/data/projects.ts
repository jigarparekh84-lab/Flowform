/**
 * Projects room — design studies persisted in localStorage.
 * Full Flowform state keyed by project id; index lists meta.
 */

import type { ScenarioComment } from './collaboration'
import type { DecisionLogEntry } from './decisionLog'
import type { UploadedNetwork } from './csvParsers'
import type { EmissionFactor } from './emissions'
import type { InventoryPolicyState } from './inventoryPolicy'
import type { BomState } from './bom'
import type { CapexRoadmapState } from './capexRoadmap'
import type { LaneRatesState } from './laneRates'
import type { ProductMixState } from './productGroups'
import type {
  BriefState,
  CandidateSite,
  DeltaItem,
  NetworkConstraints,
  Scenario,
} from './sampleNetwork'
import type { ThemeMode } from '../state/theme'
import { SAMPLE_LANE_PATCHES } from './sampleNetwork'

export const PROJECTS_INDEX_KEY = 'flowform-projects-index'
export const ACTIVE_PROJECT_KEY = 'flowform-active-project-id'
export const PROJECT_STATE_PREFIX = 'flowform-project-'

export const DEFAULT_PROJECT_NAME = 'NA Footprint 2027'

/** Storage hooks (FF-107): the workspace sync layer mirrors local writes to the API. */
export type ProjectStorageListener = {
  saved?: (id: string) => void
  renamed?: (id: string) => void
  deleted?: (id: string) => void
}
let storageListener: ProjectStorageListener | null = null
let listenerMuted = 0

export function setProjectStorageListener(l: ProjectStorageListener | null) {
  storageListener = l
}

/** Run fn without notifying the listener (e.g. when importing from the server). */
export function withoutStorageListener<T>(fn: () => T): T {
  listenerMuted++
  try {
    return fn()
  } finally {
    listenerMuted--
  }
}

function notify(kind: keyof ProjectStorageListener, id: string) {
  if (listenerMuted) return
  try {
    storageListener?.[kind]?.(id)
  } catch {
    /* sync must never break local saves */
  }
}

export type ProjectMeta = {
  id: string
  name: string
  createdAt: string
  updatedAt: string
}

/** Serializable snapshot of Flowform workspace state. */
export type ProjectSnapshot = {
  version: 1
  horizon: 'FY26' | 'FY27' | 'FY28'
  scenarios: Scenario[]
  activeScenarioId: string
  deltas: DeltaItem[]
  network: UploadedNetwork
  constraints: NetworkConstraints
  brief: BriefState
  handoffPayload: BriefState | null
  emissionFactors: EmissionFactor[]
  lastCandidates: CandidateSite[]
  /** Optional — applied on import when present. */
  theme?: ThemeMode
  /** Optional inventory policy state (multi-echelon lite). */
  inventoryPolicies?: InventoryPolicyState
  /** Per-scenario collaboration comments (stub). */
  comments?: ScenarioComment[]
  /** Multi-commodity / product groups on the network. */
  productMix?: ProductMixState
  /** Lane rate tables + carrier bids. */
  laneRates?: LaneRatesState
  /** Bill-of-materials / multi-echelon FG←RM. */
  bom?: BomState
  /** CapEx phasing / multi-year roadmap. */
  capexRoadmap?: CapexRoadmapState
  /** Append-only decision / audit log. */
  decisionLog?: DecisionLogEntry[]
}

export type ProjectExportFile = {
  format: 'flowform-project'
  version: 1
  meta: ProjectMeta
  state: ProjectSnapshot
}

function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

function safeParse<T>(raw: string | null): T | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

export function listProjectMeta(): ProjectMeta[] {
  const list = safeParse<ProjectMeta[]>(localStorage.getItem(PROJECTS_INDEX_KEY))
  return Array.isArray(list) ? list : []
}

function writeIndex(list: ProjectMeta[]) {
  localStorage.setItem(PROJECTS_INDEX_KEY, JSON.stringify(list))
}

export function getActiveProjectId(): string | null {
  return localStorage.getItem(ACTIVE_PROJECT_KEY)
}

export function setActiveProjectId(id: string) {
  localStorage.setItem(ACTIVE_PROJECT_KEY, id)
}

/**
 * Saved copies of the built-in sample predate lane l9 (Columbus → NYC hazmat
 * carrier); without it NYC hazmat demand has no capable server and Run solves
 * Infeasible. Patch it in (and tag it for every product group) on load.
 */
export function migrateSampleSnapshot(state: ProjectSnapshot): ProjectSnapshot {
  const net = state?.network
  if (!net || net.source !== 'sample' || !Array.isArray(net.lanes)) return state
  const nodeIds = new Set(net.nodes.map((n) => n.id))
  const missing = SAMPLE_LANE_PATCHES.filter(
    (p) =>
      nodeIds.has(p.from) &&
      nodeIds.has(p.to) &&
      !net.lanes.some((l) => l.id === p.id || (l.from === p.from && l.to === p.to)),
  )
  if (!missing.length) return state
  const pm = state.productMix
  return {
    ...state,
    network: { ...net, lanes: [...net.lanes, ...missing] },
    ...(pm?.laneTags
      ? {
          productMix: {
            ...pm,
            laneTags: [
              ...pm.laneTags,
              ...missing.map((l) => ({
                laneId: l.id,
                groupIds: pm.groups.map((g) => g.id),
              })),
            ],
          },
        }
      : {}),
  }
}

export function loadProjectState(id: string): ProjectSnapshot | null {
  const snap = safeParse<ProjectSnapshot>(
    localStorage.getItem(`${PROJECT_STATE_PREFIX}${id}`),
  )
  return snap ? migrateSampleSnapshot(snap) : null
}

export function saveProjectState(id: string, state: ProjectSnapshot) {
  localStorage.setItem(`${PROJECT_STATE_PREFIX}${id}`, JSON.stringify(state))
  const list = listProjectMeta()
  const now = new Date().toISOString()
  const next = list.map((p) =>
    p.id === id ? { ...p, updatedAt: now } : p,
  )
  writeIndex(next)
  notify('saved', id)
}

export function createProject(
  name: string,
  state: ProjectSnapshot,
): ProjectMeta {
  const now = new Date().toISOString()
  const meta: ProjectMeta = {
    id: uid('proj'),
    name: name.trim() || DEFAULT_PROJECT_NAME,
    createdAt: now,
    updatedAt: now,
  }
  const list = listProjectMeta()
  list.unshift(meta)
  writeIndex(list)
  saveProjectState(meta.id, state)
  setActiveProjectId(meta.id)
  return meta
}

export function renameProject(id: string, name: string): ProjectMeta | null {
  const trimmed = name.trim()
  if (!trimmed) return null
  const list = listProjectMeta()
  const ix = list.findIndex((p) => p.id === id)
  if (ix < 0) return null
  const updated: ProjectMeta = {
    ...list[ix],
    name: trimmed,
    updatedAt: new Date().toISOString(),
  }
  list[ix] = updated
  writeIndex(list)
  notify('renamed', id)
  return updated
}

export function duplicateProject(id: string): ProjectMeta | null {
  const src = listProjectMeta().find((p) => p.id === id)
  const state = loadProjectState(id)
  if (!src || !state) return null
  return createProject(`${src.name} (copy)`, structuredClone(state))
}

export function deleteProject(id: string): boolean {
  const list = listProjectMeta().filter((p) => p.id !== id)
  writeIndex(list)
  localStorage.removeItem(`${PROJECT_STATE_PREFIX}${id}`)
  if (getActiveProjectId() === id) {
    if (list[0]) setActiveProjectId(list[0].id)
    else localStorage.removeItem(ACTIVE_PROJECT_KEY)
  }
  notify('deleted', id)
  return true
}

export function exportProjectJson(id: string): ProjectExportFile | null {
  const meta = listProjectMeta().find((p) => p.id === id)
  const state = loadProjectState(id)
  if (!meta || !state) return null
  return { format: 'flowform-project', version: 1, meta, state }
}

export function downloadProjectFile(id: string): boolean {
  const payload = exportProjectJson(id)
  if (!payload) return false
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json',
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${payload.meta.name.replace(/[^\w.-]+/g, '_') || 'flowform'}.flowform.json`
  a.click()
  URL.revokeObjectURL(url)
  return true
}

export function importProjectFromJson(raw: unknown): ProjectMeta | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Partial<ProjectExportFile> & Partial<ProjectSnapshot>
  let state: ProjectSnapshot | null = null
  let name = DEFAULT_PROJECT_NAME

  if (obj.format === 'flowform-project' && obj.state && obj.meta) {
    state = obj.state as ProjectSnapshot
    name = obj.meta.name || name
  } else if ((obj as ProjectSnapshot).version === 1 && (obj as ProjectSnapshot).network) {
    state = obj as ProjectSnapshot
  }
  if (!state || state.version !== 1 || !state.network || !state.scenarios) {
    return null
  }
  return createProject(name, state)
}

/** Ensure at least one project exists; returns active meta. */
export function ensureDefaultProject(
  buildInitialState: () => ProjectSnapshot,
): ProjectMeta {
  let list = listProjectMeta()
  let activeId = getActiveProjectId()
  if (list.length === 0) {
    const meta = createProject(DEFAULT_PROJECT_NAME, buildInitialState())
    return meta
  }
  if (!activeId || !list.some((p) => p.id === activeId)) {
    activeId = list[0].id
    setActiveProjectId(activeId)
  }
  if (!loadProjectState(activeId)) {
    saveProjectState(activeId, buildInitialState())
  }
  return list.find((p) => p.id === activeId) ?? list[0]
}
