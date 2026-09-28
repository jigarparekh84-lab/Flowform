/**
 * Capacity utilization heat — assign demand to nearest open facility
 * and color by load vs capacity (for Network map layer).
 */

import type { UploadedNetwork } from './csvParsers'
import { haversineMiles, nodeLatLng } from './geo'
import type { NetworkConstraints, NetworkNode } from './sampleNetwork'

export type NodeUtilization = {
  nodeId: string
  kind: NetworkNode['kind']
  capacity: number
  load: number
  /** 0–1+ (can exceed 1 when overloaded). */
  util: number
  /** CSS / map color. */
  color: string
  label: string
}

function parseCapacity(capacity: string): number {
  const m = capacity.replace(/,/g, '').match(/([\d.]+)/)
  if (!m) return 10000
  let v = parseFloat(m[1])
  if (/k/i.test(capacity)) v *= 1000
  return Math.round(v)
}

function demandVol(
  node: NetworkNode,
  demandVolume: Record<string, number>,
): number {
  if (demandVolume[node.id] != null) return demandVolume[node.id]
  return parseCapacity(node.capacity)
}

/** Green → amber → red by utilization ratio. */
export function utilColor(util: number): string {
  if (!Number.isFinite(util) || util < 0) return '#94a3b8'
  if (util < 0.55) return '#34d399' // green — spare
  if (util < 0.75) return '#a3e635' // lime
  if (util < 0.9) return '#fbbf24' // amber
  if (util < 1.05) return '#fb923c' // orange
  return '#f87171' // red — over
}

/**
 * For facilities (plant/dc/candidate): load = sum of demand assigned
 * via inbound lanes if present, else nearest-facility assignment.
 * Demand/supplier nodes get util 0 (no capacity heat).
 */
export function computeCapacityUtilization(
  network: UploadedNetwork,
  constraints?: NetworkConstraints,
): Map<string, NodeUtilization> {
  const { nodes, lanes, demandVolume } = network
  const statusById = new Map(
    (constraints?.facilities ?? []).map((f) => [f.nodeId, f.status]),
  )
  const capMaxById = new Map(
    (constraints?.facilities ?? []).map((f) => [f.nodeId, f.capacityMax]),
  )

  const facilities = nodes.filter((n) => {
    if (n.kind !== 'dc' && n.kind !== 'plant' && n.kind !== 'candidate') {
      return false
    }
    const st = statusById.get(n.id)
    return st !== 'closed'
  })
  const demands = nodes.filter((n) => n.kind === 'demand')

  const load = new Map<string, number>(facilities.map((f) => [f.id, 0]))

  // Prefer explicit inbound lanes to demand
  const demandIds = new Set(demands.map((d) => d.id))
  const served = new Set<string>()
  for (const lane of lanes) {
    if (!demandIds.has(lane.to)) continue
    const from = facilities.find((f) => f.id === lane.from)
    if (!from) continue
    const dNode = demands.find((d) => d.id === lane.to)
    if (!dNode) continue
    const vol = demandVol(dNode, demandVolume)
    load.set(from.id, (load.get(from.id) ?? 0) + vol)
    served.add(lane.to)
  }

  // Nearest facility for unserved demand
  for (const d of demands) {
    if (served.has(d.id) || facilities.length === 0) continue
    const dLl = nodeLatLng(d)
    let best: NetworkNode | null = null
    let bestMiles = Infinity
    for (const f of facilities) {
      const m = haversineMiles(dLl, nodeLatLng(f))
      if (m < bestMiles) {
        bestMiles = m
        best = f
      }
    }
    if (best) {
      load.set(best.id, (load.get(best.id) ?? 0) + demandVol(d, demandVolume))
    }
  }

  const out = new Map<string, NodeUtilization>()
  for (const n of nodes) {
    if (n.kind === 'demand' || n.kind === 'supplier') {
      out.set(n.id, {
        nodeId: n.id,
        kind: n.kind,
        capacity: 0,
        load: demandVol(n, demandVolume),
        util: 0,
        color: n.kind === 'demand' ? '#fbbf24' : '#a78bfa',
        label: n.kind === 'demand' ? 'Demand' : 'Supplier',
      })
      continue
    }
    const capacity =
      capMaxById.get(n.id) ?? parseCapacity(n.capacity)
    const ld = load.get(n.id) ?? 0
    const util = capacity > 0 ? ld / capacity : 0
    const pct = Math.round(util * 1000) / 10
    out.set(n.id, {
      nodeId: n.id,
      kind: n.kind,
      capacity,
      load: ld,
      util,
      color: utilColor(util),
      label: `${pct}% util · ${Math.round(ld).toLocaleString()} / ${Math.round(capacity).toLocaleString()}`,
    })
  }
  return out
}
