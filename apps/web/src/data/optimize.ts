/**
 * Flowform heuristic optimizer v1 (MIP-lite / greedy).
 * NOT a full MIP — documents CapEx + service-radius greedy open/close.
 */

import type { UploadedNetwork } from './csvParsers'
import type {
  FacilityConstraint,
  KpiSnapshot,
  NetworkConstraints,
  NetworkNode,
  Scenario,
} from './sampleNetwork'
import { parseMoneyM, parsePercent } from './sampleNetwork'

/** Canvas units → approximate miles (CONUS-ish map). */
const MILES_PER_UNIT = 12

export type OptimizeResult = {
  scenario: Omit<Scenario, 'id'> & { id?: string }
  openedIds: string[]
  closedIds: string[]
  keptOpenIds: string[]
  servicePct: number
  capexUsedM: number
  uncoveredDemand: number
  log: string[]
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function milesBetween(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return dist(a, b) * MILES_PER_UNIT
}

function facilityNodes(nodes: NetworkNode[]): NetworkNode[] {
  return nodes.filter(
    (n) => n.kind === 'dc' || n.kind === 'plant' || n.kind === 'candidate',
  )
}

function demandNodes(
  nodes: NetworkNode[],
  volume: Record<string, number>,
): { node: NetworkNode; volume: number }[] {
  return nodes
    .filter((n) => n.kind === 'demand')
    .map((node) => ({
      node,
      volume: volume[node.id] ?? parseVolume(node.capacity),
    }))
}

function parseVolume(capacity: string): number {
  const m = capacity.replace(/,/g, '').match(/([\d.]+)/)
  if (!m) return 1000
  let v = parseFloat(m[1])
  if (/k/i.test(capacity)) v *= 1000
  return v
}

function constraintMap(
  constraints: NetworkConstraints,
): Map<string, FacilityConstraint> {
  return new Map(constraints.facilities.map((f) => [f.nodeId, f]))
}

/**
 * Greedy open/close under CapEx budget, max facilities, and service radius.
 * 1. Seed with currently open facilities (respecting forced-closed).
 * 2. Open highest-coverage candidates while CapEx / max allow.
 * 3. Soft-close open sites whose demand is still covered without them (optional savings).
 */
export function runHeuristicOptimize(args: {
  network: UploadedNetwork
  constraints: NetworkConstraints
  reference: Scenario
  name?: string
}): OptimizeResult {
  const { network, constraints, reference } = args
  const log: string[] = [
    'Heuristic v1 — greedy open/close (not a full MIP).',
  ]
  const cmap = constraintMap(constraints)
  const facilities = facilityNodes(network.nodes)
  const demand = demandNodes(network.nodes, network.demandVolume)
  const totalDemand = demand.reduce((s, d) => s + d.volume, 0) || 1
  const radius = constraints.serviceRadiusMiles

  const forcedClosed = new Set(
    constraints.facilities.filter((f) => f.status === 'closed').map((f) => f.nodeId),
  )
  const forcedOpen = new Set(
    constraints.facilities
      .filter((f) => f.status === 'open')
      .map((f) => f.nodeId),
  )

  // Seed open set
  const open = new Set<string>()
  for (const f of facilities) {
    const c = cmap.get(f.id)
    const status = c?.status ?? (f.kind === 'candidate' ? 'candidate' : 'open')
    if (status === 'open') open.add(f.id)
    if (status === 'closed') {
      // stay closed
    }
  }

  let capexUsed = 0
  const openedIds: string[] = []
  const closedIds: string[] = []

  function coverage(openIds: Set<string>): {
    covered: number
    pct: number
    byFacility: Map<string, number>
  } {
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
    return { covered, pct: (covered / totalDemand) * 100, byFacility }
  }

  let { pct } = coverage(open)
  log.push(
    `Seed: ${open.size} open facilities · service ${pct.toFixed(1)}% within ${radius} mi.`,
  )

  // Candidates ordered by marginal coverage / CapEx
  const candidates = facilities.filter((f) => {
    const c = cmap.get(f.id)
    const status = c?.status ?? (f.kind === 'candidate' ? 'candidate' : 'open')
    return status === 'candidate' || (status !== 'closed' && !open.has(f.id))
  })

  const maxFac = constraints.maxFacilities
  const budget = constraints.capexBudgetM
  const target = constraints.serviceTargetPct

  // Greedy opens
  let guard = 0
  while (guard++ < 24) {
    if (open.size >= maxFac) {
      log.push(`Hit max facilities (${maxFac}).`)
      break
    }
    if (pct >= target) {
      log.push(`Service target ${target}% met at ${pct.toFixed(1)}%.`)
      break
    }

    let bestId: string | null = null
    let bestGain = 0
    let bestCost = 0

    for (const cand of candidates) {
      if (open.has(cand.id) || forcedClosed.has(cand.id)) continue
      const c = cmap.get(cand.id)
      const cost = c?.fixedCapexM ?? (cand.kind === 'candidate' ? 6 : 4)
      if (capexUsed + cost > budget) continue

      const trial = new Set(open)
      trial.add(cand.id)
      if (trial.size > maxFac) continue
      const next = coverage(trial)
      const gain = next.pct - pct
      // Prefer gain per CapEx dollar; tiny epsilon for zero-cost
      const score = gain / Math.max(0.5, cost)
      if (score > bestGain || (score === bestGain && gain > 0 && cost < bestCost)) {
        // track by score
        if (gain > 0.05) {
          bestGain = score
          bestId = cand.id
          bestCost = cost
        }
      }
    }

    // Re-evaluate with raw gain if score loop was weird — pick max gain under budget
    if (!bestId) {
      let maxGain = 0
      for (const cand of candidates) {
        if (open.has(cand.id) || forcedClosed.has(cand.id)) continue
        const c = cmap.get(cand.id)
        const cost = c?.fixedCapexM ?? (cand.kind === 'candidate' ? 6 : 4)
        if (capexUsed + cost > budget) continue
        const trial = new Set(open)
        trial.add(cand.id)
        if (trial.size > maxFac) continue
        const next = coverage(trial)
        const gain = next.pct - pct
        if (gain > maxGain) {
          maxGain = gain
          bestId = cand.id
          bestCost = cost
        }
      }
      if (!bestId || maxGain <= 0.05) {
        log.push('No improving candidate under CapEx / max facilities.')
        break
      }
    }

    open.add(bestId)
    capexUsed += bestCost
    openedIds.push(bestId)
    pct = coverage(open).pct
    log.push(
      `Open ${bestId} (+$${bestCost}M CapEx) → service ${pct.toFixed(1)}%.`,
    )
  }

  // Soft-close: remove non-forced sites if service stays ≥ target
  const closable = [...open].filter((id) => !forcedOpen.has(id))
  for (const id of closable) {
    if (open.size <= 1) break
    const trial = new Set(open)
    trial.delete(id)
    const next = coverage(trial)
    if (next.pct + 0.05 >= Math.min(target, pct) && next.pct >= target - 0.5) {
      // Only close if we still meet target (or were already below and don't worsen much)
      if (next.pct >= target || next.pct >= pct - 0.3) {
        const c = cmap.get(id)
        // Closing an originally-open site doesn't refund CapEx in v1; candidates refund
        if (openedIds.includes(id)) {
          capexUsed = Math.max(0, capexUsed - (c?.fixedCapexM ?? 6))
          const ix = openedIds.indexOf(id)
          if (ix >= 0) openedIds.splice(ix, 1)
        }
        open.delete(id)
        closedIds.push(id)
        pct = next.pct
        log.push(`Close ${id} (redundant) → service ${pct.toFixed(1)}%.`)
      }
    }
  }

  const final = coverage(open)
  const uncovered = totalDemand - final.covered
  log.push(
    `Done: ${open.size} open · CapEx $${capexUsed.toFixed(1)}M / $${budget}M · service ${final.pct.toFixed(1)}% (target ${target}%).`,
  )

  const keptOpenIds = [...open].filter((id) => !openedIds.includes(id))
  const kpis = kpisFromOptimize({
    reference,
    servicePct: final.pct,
    capexUsedM: capexUsed,
    opened: openedIds.length,
    closed: closedIds.length,
    laneCount: network.lanes.length,
  })

  return {
    scenario: {
      name: args.name?.trim() || `Optimize ${new Date().toLocaleTimeString()}`,
      tag: 'Optimize',
      baseId: reference.id,
      kpis,
      optimizeMeta: {
        heuristic: 'v1-greedy',
        openedIds,
        closedIds,
        servicePct: Math.round(final.pct * 10) / 10,
        capexUsedM: Math.round(capexUsed * 10) / 10,
        marks: [
          ...openedIds.map((id) => {
            const n = facilities.find((f) => f.id === id)
            return {
              id: `opt-open-${id}`,
              kind: 'open' as const,
              label: `${n?.name ?? id} (open)`,
              x: n?.x ?? 50,
              y: n?.y ?? 50,
            }
          }),
          ...closedIds.map((id) => {
            const n = facilities.find((f) => f.id === id)
            return {
              id: `opt-close-${id}`,
              kind: 'close' as const,
              label: `${n?.name ?? id} (close)`,
              x: n?.x ?? 50,
              y: n?.y ?? 50,
            }
          }),
        ],
      },
    },
    openedIds,
    closedIds,
    keptOpenIds,
    servicePct: final.pct,
    capexUsedM: capexUsed,
    uncoveredDemand: uncovered,
    log,
  }
}

function kpisFromOptimize(args: {
  reference: Scenario
  servicePct: number
  capexUsedM: number
  opened: number
  closed: number
  laneCount: number
}): KpiSnapshot {
  const refCost = parseMoneyM(args.reference.kpis.cost.value) || 48.2
  const refService = parsePercent(args.reference.kpis.service.value) || 94.1
  const refCo2 = parseMoneyM(args.reference.kpis.co2.value) || 12.4

  // Transport proxy: better service + closes → lower cost; CapEx annualized lightly
  const serviceGain = args.servicePct - refService
  const transportSave = Math.min(6, Math.max(-3, serviceGain * 0.35 + args.closed * 0.4 - args.opened * 0.15))
  const capexCharge = args.capexUsedM * 0.12
  const newCost = Math.max(20, refCost - transportSave + capexCharge * 0.25)
  const costDeltaPct = ((newCost - refCost) / refCost) * 100
  const co2 = Math.max(4, refCo2 - args.opened * 0.35 - args.closed * 0.15)

  const serviceDelta = args.servicePct - refService

  return {
    cost: {
      value: `$${newCost.toFixed(1)}M`,
      delta: `${costDeltaPct >= 0 ? '+' : '−'}${Math.abs(costDeltaPct).toFixed(1)}%`,
      better: costDeltaPct <= 0,
    },
    service: {
      value: `${args.servicePct.toFixed(1)}%`,
      delta: `${serviceDelta >= 0 ? '+' : '−'}${Math.abs(serviceDelta).toFixed(1)}pp`,
      better: serviceDelta >= 0,
    },
    capex: {
      value: `$${args.capexUsedM.toFixed(0)}M`,
      delta: `+$${args.capexUsedM.toFixed(0)}M`,
      better: args.capexUsedM === 0,
    },
    co2: {
      value: `${co2.toFixed(1)} kt`,
      delta: `${co2 <= refCo2 ? '−' : '+'}${Math.abs(((co2 - refCo2) / refCo2) * 100).toFixed(0)}%`,
      better: co2 <= refCo2,
    },
    risk: {
      value: args.servicePct >= 96 ? 'Low' : args.servicePct >= 92 ? 'Med' : 'High',
      delta: args.servicePct >= refService ? '↓' : '↑',
      better: args.servicePct >= refService,
    },
  }
}

export function defaultConstraintsFromNetwork(
  network: UploadedNetwork,
): NetworkConstraints {
  const facilities: FacilityConstraint[] = facilityNodes(network.nodes).map(
    (n) => {
      const vol = parseVolume(n.capacity)
      const isCand = n.kind === 'candidate'
      return {
        nodeId: n.id,
        status: isCand ? 'candidate' : 'open',
        capacityMin: Math.round(vol * 0.6),
        capacityMax: Math.round(vol * 1.25),
        fixedCapexM: isCand ? 6 : n.kind === 'dc' ? 4 : 8,
      }
    },
  )
  return {
    serviceTargetPct: 95,
    serviceRadiusMiles: 250,
    capexBudgetM: 30,
    maxFacilities: Math.max(3, Math.min(8, facilities.length)),
    facilities,
  }
}

/** Merge constraints when network nodes change — preserve edits for known ids. */
export function mergeConstraints(
  prev: NetworkConstraints,
  network: UploadedNetwork,
): NetworkConstraints {
  const fresh = defaultConstraintsFromNetwork(network)
  const prevMap = new Map(prev.facilities.map((f) => [f.nodeId, f]))
  return {
    serviceTargetPct: prev.serviceTargetPct,
    serviceRadiusMiles: prev.serviceRadiusMiles,
    capexBudgetM: prev.capexBudgetM,
    maxFacilities: prev.maxFacilities,
    ...(prev.defaultUnitWeightKg != null
      ? { defaultUnitWeightKg: prev.defaultUnitWeightKg }
      : {}),
    ...(prev.carbonPricePerTonne != null
      ? { carbonPricePerTonne: prev.carbonPricePerTonne }
      : {}),
    facilities: fresh.facilities.map((f) => {
      const old = prevMap.get(f.nodeId)
      return old ? { ...f, ...old, nodeId: f.nodeId } : f
    }),
  }
}
