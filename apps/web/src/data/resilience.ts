/**
 * Resilience scoring — single points of failure (SPOF).
 * A node is critical when removing it drops network service below a threshold.
 * Reuses the same coverage heuristic as optimize (service radius).
 */

import type { UploadedNetwork } from './csvParsers'
import type {
  NetworkConstraints,
  NetworkNode,
  Scenario,
} from './sampleNetwork'

const MILES_PER_UNIT = 12

export type CriticalNode = {
  nodeId: string
  name: string
  kind: string
  region: string
  /** Service % with this node removed. */
  serviceAfterPct: number
  /** Drop vs baseline open set (percentage points). */
  dropPp: number
  /** Demand volume uniquely / primarily covered by this node. */
  coveredVolume: number
}

export type ResilienceResult = {
  runAt: string
  thresholdPct: number
  baselineServicePct: number
  /** 0–100: higher = more resilient (fewer SPOFs). */
  score: number
  critical: CriticalNode[]
  /** All facilities evaluated (sorted by drop descending). */
  ranked: CriticalNode[]
  facilityCount: number
}

function milesBetween(
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  return Math.hypot(a.x - b.x, a.y - b.y) * MILES_PER_UNIT
}

function parseVolume(capacity: string): number {
  const m = capacity.replace(/,/g, '').match(/([\d.]+)/)
  if (!m) return 1000
  let v = parseFloat(m[1])
  if (/k/i.test(capacity)) v *= 1000
  return v
}

function facilityNodes(nodes: NetworkNode[]): NetworkNode[] {
  return nodes.filter(
    (n) => n.kind === 'dc' || n.kind === 'plant' || n.kind === 'candidate',
  )
}

function openFacilityIds(
  nodes: NetworkNode[],
  constraints: NetworkConstraints,
  scenario: Scenario,
): Set<string> {
  const open = new Set<string>()
  const facilities = facilityNodes(nodes)
  const cmap = new Map(constraints.facilities.map((f) => [f.nodeId, f]))

  for (const f of facilities) {
    const c = cmap.get(f.id)
    const status = c?.status ?? (f.kind === 'candidate' ? 'candidate' : 'open')
    if (status === 'open') open.add(f.id)
  }

  // Scenario optimize opens/closes override
  if (scenario.optimizeMeta) {
    for (const id of scenario.optimizeMeta.openedIds) open.add(id)
    for (const id of scenario.optimizeMeta.closedIds) open.delete(id)
  }

  // Soft-close marks from map-diff lean scenarios
  if (scenario.id === 'lean-lanes') {
    open.delete('n8')
  }

  if (open.size === 0) {
    for (const f of facilities) {
      if (f.kind !== 'candidate') open.add(f.id)
    }
  }
  return open
}

function coveragePct(
  openIds: Set<string>,
  facilities: NetworkNode[],
  demand: { node: NetworkNode; volume: number }[],
  radius: number,
): { pct: number; byFacility: Map<string, number> } {
  const total = demand.reduce((s, d) => s + d.volume, 0) || 1
  const byFacility = new Map<string, number>()
  let covered = 0
  for (const d of demand) {
    let best: string | null = null
    let bestDist = Infinity
    for (const id of openIds) {
      const site = facilities.find((f) => f.id === id)
      if (!site) continue
      const m = milesBetween(site, d.node)
      if (m <= radius && m < bestDist) {
        bestDist = m
        best = id
      }
    }
    if (best) {
      covered += d.volume
      byFacility.set(best, (byFacility.get(best) ?? 0) + d.volume)
    }
  }
  return { pct: (covered / total) * 100, byFacility }
}

/**
 * Score resilience for a scenario: enumerate facility outages, flag SPOFs.
 */
export function scoreResilience(args: {
  network: UploadedNetwork
  constraints: NetworkConstraints
  scenario: Scenario
  /** Service floor — drop below → critical. Default: constraint target. */
  thresholdPct?: number
}): ResilienceResult {
  const { network, constraints, scenario } = args
  const threshold =
    args.thresholdPct ?? constraints.serviceTargetPct ?? 95
  const facilities = facilityNodes(network.nodes)
  const demand = network.nodes
    .filter((n) => n.kind === 'demand')
    .map((node) => ({
      node,
      volume: network.demandVolume[node.id] ?? parseVolume(node.capacity),
    }))
  const radius = constraints.serviceRadiusMiles
  const open = openFacilityIds(network.nodes, constraints, scenario)
  const baseline = coveragePct(open, facilities, demand, radius)

  const ranked: CriticalNode[] = []
  for (const id of open) {
    const remaining = new Set(open)
    remaining.delete(id)
    const after = coveragePct(remaining, facilities, demand, radius)
    const site = facilities.find((f) => f.id === id)
    const dropPp = Math.round((baseline.pct - after.pct) * 10) / 10
    ranked.push({
      nodeId: id,
      name: site?.name ?? id,
      kind: site?.kind ?? 'dc',
      region: site?.region ?? '—',
      serviceAfterPct: Math.round(after.pct * 10) / 10,
      dropPp,
      coveredVolume: baseline.byFacility.get(id) ?? 0,
    })
  }

  ranked.sort((a, b) => b.dropPp - a.dropPp || a.serviceAfterPct - b.serviceAfterPct)

  const critical = ranked.filter((n) => n.serviceAfterPct < threshold)
  const facilityCount = open.size || 1
  // Score: 100 when no SPOFs; penalize by share of critical + severity of worst drop
  const sharePenalty = (critical.length / facilityCount) * 70
  const worstDrop = critical[0]?.dropPp ?? 0
  const severityPenalty = Math.min(30, worstDrop * 0.6)
  const score = Math.max(
    0,
    Math.min(100, Math.round(100 - sharePenalty - severityPenalty)),
  )

  return {
    runAt: new Date().toISOString(),
    thresholdPct: threshold,
    baselineServicePct: Math.round(baseline.pct * 10) / 10,
    score,
    critical,
    ranked,
    facilityCount: open.size,
  }
}

/** Map score to Low / Med / High risk label (inverse of resilience). */
export function resilienceRiskLabel(score: number): 'Low' | 'Med' | 'High' {
  if (score >= 75) return 'Low'
  if (score >= 45) return 'Med'
  return 'High'
}
