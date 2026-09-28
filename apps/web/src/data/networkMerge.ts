/**
 * M&A merge studio — merge a second (acquired) network into the baseline
 * with duplicate-id conflict listing and a draft merged scenario.
 */

import {
  buildValidation,
  type UploadedNetwork,
} from './csvParsers'
import type {
  NetworkLane,
  NetworkNode,
  Scenario,
} from './sampleNetwork'
import { BASELINE_KPIS } from './sampleNetwork'

export type MergeConflictKind = 'node' | 'lane'

export type MergeConflict = {
  id: string
  kind: MergeConflictKind
  primaryLabel: string
  acquiredLabel: string
  /** Resolution applied when building merge. */
  resolution: 'keep-primary' | 'keep-acquired' | 'rename-acquired'
}

export type MergePreview = {
  conflicts: MergeConflict[]
  primaryNodeCount: number
  acquiredNodeCount: number
  primaryLaneCount: number
  acquiredLaneCount: number
  mergedNodeCount: number
  mergedLaneCount: number
}

export type MergeResult = {
  network: UploadedNetwork
  conflicts: MergeConflict[]
  /** Draft baseline-style scenario describing the merge. */
  draftScenario: Scenario
  summary: string
}

/** Sample “acquired” footprint — overlaps n2 / l4 to demo conflicts. */
export function sampleAcquiredNetwork(): UploadedNetwork {
  const nodes: NetworkNode[] = [
    {
      id: 'acq-p1',
      name: 'Querétaro Plant',
      kind: 'plant',
      region: 'MX',
      capacity: '28k u/wk',
      x: 24,
      y: 68,
      lat: 20.59,
      lng: -100.39,
    },
    {
      // Intentional conflict with primary Columbus DC
      id: 'n2',
      name: 'Columbus Hub (Acquired)',
      kind: 'dc',
      region: 'Midwest',
      capacity: '22k pallet',
      x: 54,
      y: 36,
      lat: 39.96,
      lng: -82.99,
    },
    {
      id: 'acq-dc1',
      name: 'Charlotte DC',
      kind: 'dc',
      region: 'Southeast',
      capacity: '11k pallet',
      x: 70,
      y: 52,
      lat: 35.23,
      lng: -80.84,
    },
    {
      id: 'acq-d1',
      name: 'Miami Metro',
      kind: 'demand',
      region: 'Southeast',
      capacity: '6.4k u/wk',
      x: 78,
      y: 78,
      lat: 25.76,
      lng: -80.19,
    },
    {
      id: 'acq-d2',
      name: 'Detroit Metro',
      kind: 'demand',
      region: 'Midwest',
      capacity: '5.1k u/wk',
      x: 58,
      y: 24,
      lat: 42.33,
      lng: -83.05,
    },
    {
      id: 'acq-s1',
      name: 'Veracruz Port',
      kind: 'supplier',
      region: 'MX',
      capacity: '30k u/wk',
      x: 30,
      y: 80,
      lat: 19.17,
      lng: -96.13,
    },
  ]

  const lanes: NetworkLane[] = [
    {
      id: 'acq-l1',
      from: 'acq-s1',
      to: 'acq-p1',
      mode: 'Ocean',
      costPerUnit: 0.48,
      leadDays: 8,
      co2Kg: 4,
    },
    {
      id: 'acq-l2',
      from: 'acq-p1',
      to: 'acq-dc1',
      mode: 'Rail',
      costPerUnit: 0.71,
      leadDays: 5,
      co2Kg: 7,
    },
    {
      id: 'acq-l3',
      from: 'acq-dc1',
      to: 'acq-d1',
      mode: 'Truck',
      costPerUnit: 0.92,
      leadDays: 2,
      co2Kg: 13,
    },
    {
      // Intentional lane id conflict with primary l4
      id: 'l4',
      from: 'n2',
      to: 'acq-d2',
      mode: 'Truck',
      costPerUnit: 0.55,
      leadDays: 1,
      co2Kg: 7,
    },
    {
      id: 'acq-l5',
      from: 'acq-dc1',
      to: 'acq-d2',
      mode: 'Intermodal',
      costPerUnit: 0.84,
      leadDays: 3,
      co2Kg: 9,
    },
  ]

  const demandVolume: Record<string, number> = {
    'acq-d1': 6400,
    'acq-d2': 5100,
  }

  const validation = buildValidation(
    nodes,
    lanes,
    demandVolume,
    [{ level: 'info', message: 'Sample acquired network (M&A stub).' }],
    nodes.length,
    nodes.length,
  )

  return {
    nodes,
    lanes,
    demandVolume,
    source: 'upload',
    fileNames: { sites: 'acquired-sample.json' },
    validation,
  }
}

function labelNode(n: NetworkNode): string {
  return `${n.name} (${n.kind})`
}

function labelLane(l: NetworkLane): string {
  return `${l.from}→${l.to} · ${l.mode}`
}

export function detectMergeConflicts(
  primary: UploadedNetwork,
  acquired: UploadedNetwork,
): MergeConflict[] {
  const primaryNodeIds = new Set(primary.nodes.map((n) => n.id))
  const primaryLaneIds = new Set(primary.lanes.map((l) => l.id))
  const primaryNodes = new Map(primary.nodes.map((n) => [n.id, n]))
  const primaryLanes = new Map(primary.lanes.map((l) => [l.id, l]))
  const conflicts: MergeConflict[] = []

  for (const n of acquired.nodes) {
    if (primaryNodeIds.has(n.id)) {
      const p = primaryNodes.get(n.id)!
      conflicts.push({
        id: n.id,
        kind: 'node',
        primaryLabel: labelNode(p),
        acquiredLabel: labelNode(n),
        resolution: 'rename-acquired',
      })
    }
  }
  for (const l of acquired.lanes) {
    if (primaryLaneIds.has(l.id)) {
      const p = primaryLanes.get(l.id)!
      conflicts.push({
        id: l.id,
        kind: 'lane',
        primaryLabel: labelLane(p),
        acquiredLabel: labelLane(l),
        resolution: 'rename-acquired',
      })
    }
  }
  return conflicts
}

function renameId(id: string, used: Set<string>): string {
  let next = `acq-${id}`
  let i = 2
  while (used.has(next)) {
    next = `acq-${id}-${i}`
    i += 1
  }
  return next
}

/**
 * Merge acquired into primary. Default: keep primary rows on conflict,
 * rename acquired duplicates so both networks are represented.
 */
export function mergeNetworks(
  primary: UploadedNetwork,
  acquired: UploadedNetwork,
  conflictResolutions?: Record<string, MergeConflict['resolution']>,
): MergeResult {
  const detected = detectMergeConflicts(primary, acquired)
  const conflicts = detected.map((c) => ({
    ...c,
    resolution: conflictResolutions?.[`${c.kind}:${c.id}`] ?? c.resolution,
  }))

  const usedNodeIds = new Set(primary.nodes.map((n) => n.id))
  const usedLaneIds = new Set(primary.lanes.map((l) => l.id))
  const idMap = new Map<string, string>() // acquired id → final id

  const mergedNodes: NetworkNode[] = primary.nodes.map((n) => ({ ...n }))
  const demandVolume: Record<string, number> = {
    ...primary.demandVolume,
  }

  for (const n of acquired.nodes) {
    const key = `node:${n.id}`
    const res =
      conflictResolutions?.[key] ??
      conflicts.find((c) => c.kind === 'node' && c.id === n.id)?.resolution ??
      'rename-acquired'

    if (!usedNodeIds.has(n.id)) {
      idMap.set(n.id, n.id)
      usedNodeIds.add(n.id)
      mergedNodes.push({ ...n })
      if (acquired.demandVolume[n.id] != null) {
        demandVolume[n.id] = acquired.demandVolume[n.id]
      }
      continue
    }

    if (res === 'keep-primary') {
      // drop acquired node; map its id to primary so lanes can retarget
      idMap.set(n.id, n.id)
      continue
    }
    if (res === 'keep-acquired') {
      const ix = mergedNodes.findIndex((x) => x.id === n.id)
      if (ix >= 0) mergedNodes[ix] = { ...n }
      idMap.set(n.id, n.id)
      if (acquired.demandVolume[n.id] != null) {
        demandVolume[n.id] = acquired.demandVolume[n.id]
      }
      continue
    }
    // rename-acquired
    const newId = renameId(n.id, usedNodeIds)
    idMap.set(n.id, newId)
    usedNodeIds.add(newId)
    mergedNodes.push({ ...n, id: newId })
    if (acquired.demandVolume[n.id] != null) {
      demandVolume[newId] = acquired.demandVolume[n.id]
    }
  }

  const mergedLanes: NetworkLane[] = primary.lanes.map((l) => ({ ...l }))

  for (const l of acquired.lanes) {
    const key = `lane:${l.id}`
    const res =
      conflictResolutions?.[key] ??
      conflicts.find((c) => c.kind === 'lane' && c.id === l.id)?.resolution ??
      'rename-acquired'

    const from = idMap.get(l.from) ?? l.from
    const to = idMap.get(l.to) ?? l.to
    // Skip lane if endpoints were dropped (shouldn't happen with rename default)
    if (!usedNodeIds.has(from) || !usedNodeIds.has(to)) continue

    const laneBody: NetworkLane = { ...l, from, to }

    if (!usedLaneIds.has(l.id)) {
      usedLaneIds.add(l.id)
      mergedLanes.push(laneBody)
      continue
    }

    if (res === 'keep-primary') {
      continue
    }
    if (res === 'keep-acquired') {
      const ix = mergedLanes.findIndex((x) => x.id === l.id)
      if (ix >= 0) mergedLanes[ix] = laneBody
      continue
    }
    const newId = renameId(l.id, usedLaneIds)
    usedLaneIds.add(newId)
    mergedLanes.push({ ...laneBody, id: newId })
  }

  const issues = [
    {
      level: 'info' as const,
      message: `Merged acquired network · ${conflicts.length} conflict(s) resolved.`,
    },
  ]
  const validation = buildValidation(
    mergedNodes,
    mergedLanes,
    demandVolume,
    issues,
    mergedNodes.filter((n) => n.lat != null && n.lng != null).length,
    mergedNodes.length,
  )

  const network: UploadedNetwork = {
    nodes: mergedNodes,
    lanes: mergedLanes,
    demandVolume,
    source: 'upload',
    fileNames: {
      ...primary.fileNames,
      sites: primary.fileNames.sites
        ? `${primary.fileNames.sites}+acquired`
        : 'merged-ma.json',
    },
    validation,
  }

  const addedNodes = mergedNodes.length - primary.nodes.length
  const addedLanes = mergedLanes.length - primary.lanes.length
  const draftScenario: Scenario = {
    id: `merged-${Date.now().toString(36)}`,
    name: 'Merged baseline (M&A draft)',
    tag: 'Draft',
    baseId: 'baseline',
    kpis: {
      ...BASELINE_KPIS,
      cost: {
        value: `$${(48.2 + addedNodes * 1.4).toFixed(1)}M`,
        delta: `+${(addedNodes * 2.8).toFixed(1)}%`,
        better: false,
      },
      service: {
        value: `${(94.1 + Math.min(3, addedNodes * 0.4)).toFixed(1)}%`,
        delta: `+${Math.min(3, addedNodes * 0.4).toFixed(1)}pp`,
        better: true,
      },
      capex: {
        value: `$${Math.max(0, addedNodes * 5)}M`,
        delta: `+$${addedNodes * 5}M`,
        better: false,
      },
      co2: {
        value: `${(12.4 + addedLanes * 0.3).toFixed(1)} kt`,
        delta: `+${Math.round(addedLanes * 2)}%`,
        better: false,
      },
      risk: {
        value: conflicts.length > 2 ? 'Med' : 'Low',
        delta: `${conflicts.length} conflicts`,
        better: conflicts.length <= 2,
      },
    },
  }

  const summary = `Merged ${acquired.nodes.length} acquired nodes + ${acquired.lanes.length} lanes → ${mergedNodes.length} nodes / ${mergedLanes.length} lanes (${conflicts.length} conflicts).`

  return { network, conflicts, draftScenario, summary }
}

export function previewMerge(
  primary: UploadedNetwork,
  acquired: UploadedNetwork,
  conflictResolutions?: Record<string, MergeConflict['resolution']>,
): MergePreview {
  const result = mergeNetworks(primary, acquired, conflictResolutions)
  return {
    conflicts: result.conflicts,
    primaryNodeCount: primary.nodes.length,
    acquiredNodeCount: acquired.nodes.length,
    primaryLaneCount: primary.lanes.length,
    acquiredLaneCount: acquired.lanes.length,
    mergedNodeCount: result.network.nodes.length,
    mergedLaneCount: result.network.lanes.length,
  }
}

/** Parse a Flowform project JSON or bare UploadedNetwork-ish object. */
export function parseAcquiredNetworkJson(raw: unknown): UploadedNetwork | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>

  // Share pack
  if (obj.format === 'flowform-share' && obj.project) {
    const proj = obj.project as { state?: { network?: UploadedNetwork } }
    if (proj.state?.network?.nodes && proj.state.network.lanes) {
      return proj.state.network
    }
  }
  // Project export
  if (obj.format === 'flowform-project' && obj.state) {
    const state = obj.state as { network?: UploadedNetwork }
    if (state.network?.nodes && state.network.lanes) return state.network
  }
  // Snapshot
  if ((obj as { network?: UploadedNetwork }).network?.nodes) {
    return (obj as { network: UploadedNetwork }).network
  }
  // Bare uploaded network
  if (Array.isArray(obj.nodes) && Array.isArray(obj.lanes)) {
    return obj as unknown as UploadedNetwork
  }
  return null
}
