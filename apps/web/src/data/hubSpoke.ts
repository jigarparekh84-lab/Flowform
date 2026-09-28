/**
 * Hub-and-spoke design studio — designate hubs, assign spokes by
 * distance / volume / balanced score, generate hub↔spoke lanes,
 * draft a scenario with before/after KPIs.
 */

import { buildValidation, type UploadedNetwork } from './csvParsers'
import { haversineMiles, nodeLatLng } from './geo'
import type {
  KpiSnapshot,
  NetworkLane,
  NetworkNode,
  Scenario,
} from './sampleNetwork'
import { BASELINE_KPIS } from './sampleNetwork'

export type SpokeAssignMode = 'distance' | 'volume' | 'balanced'

export type HubSpokeParams = {
  hubIds: string[]
  /** How spokes pick a hub. */
  mode: SpokeAssignMode
  /** Prefer volume weight 0–1 when mode is balanced (default 0.45). */
  volumeWeight: number
  /** Replace existing lanes that terminate at demand nodes. */
  replaceDemandLanes: boolean
  /** Lane mode for new hub↔spoke links. */
  laneMode: string
  /** Optional draft scenario name. */
  scenarioName?: string
}

export type SpokeAssignment = {
  spokeId: string
  spokeName: string
  hubId: string
  hubName: string
  miles: number
  volume: number
}

export type HubLoad = {
  hubId: string
  hubName: string
  capacity: number
  assignedVolume: number
  utilPct: number
  spokeCount: number
}

export type HubSpokeKpiPair = {
  before: KpiSnapshot
  after: KpiSnapshot
}

export type HubSpokePreview = {
  assignments: SpokeAssignment[]
  hubLoads: HubLoad[]
  newLanes: NetworkLane[]
  /** Lanes kept from baseline (non-demand inbound when replace is on). */
  keptLanes: NetworkLane[]
  /** Full lane set after apply. */
  resultingLanes: NetworkLane[]
  kpis: HubSpokeKpiPair
  unassignedSpokeIds: string[]
  summary: string
}

export type HubSpokeResult = {
  network: UploadedNetwork
  draftScenario: Scenario
  preview: HubSpokePreview
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

/** Eligible hubs: DC / plant / candidate (open facilities). */
export function eligibleHubNodes(nodes: NetworkNode[]): NetworkNode[] {
  return nodes.filter(
    (n) => n.kind === 'dc' || n.kind === 'plant' || n.kind === 'candidate',
  )
}

/** Suggest hubs: top N by capacity among DCs (fallback plants). */
export function suggestHubIds(nodes: NetworkNode[], count = 2): string[] {
  const dcs = nodes.filter((n) => n.kind === 'dc')
  const pool = dcs.length > 0 ? dcs : eligibleHubNodes(nodes)
  return [...pool]
    .sort((a, b) => parseCapacity(b.capacity) - parseCapacity(a.capacity))
    .slice(0, Math.max(1, count))
    .map((n) => n.id)
}

function laneCostFromMiles(miles: number): {
  costPerUnit: number
  leadDays: number
  co2Kg: number
} {
  const m = Math.max(25, miles)
  return {
    costPerUnit: Math.round((0.22 + m / 900) * 100) / 100,
    leadDays: Math.max(1, Math.round(m / 350)),
    co2Kg: Math.round(m * 0.035),
  }
}

function assignSpokes(args: {
  hubs: NetworkNode[]
  spokes: NetworkNode[]
  demandVolume: Record<string, number>
  mode: SpokeAssignMode
  volumeWeight: number
}): { assignments: SpokeAssignment[]; unassigned: string[] } {
  const { hubs, spokes, demandVolume, mode, volumeWeight } = args
  if (hubs.length === 0) {
    return { assignments: [], unassigned: spokes.map((s) => s.id) }
  }

  const remaining = new Map(
    hubs.map((h) => [h.id, parseCapacity(h.capacity) * 1.25]),
  )
  const hubById = new Map(hubs.map((h) => [h.id, h]))

  // Largest volume first so capacity-aware modes pack better
  const ordered = [...spokes].sort(
    (a, b) => demandVol(b, demandVolume) - demandVol(a, demandVolume),
  )

  const assignments: SpokeAssignment[] = []
  const unassigned: string[] = []

  for (const spoke of ordered) {
    const vol = demandVol(spoke, demandVolume)
    const sLl = nodeLatLng(spoke)
    let best: { hub: NetworkNode; miles: number; score: number } | null = null

    for (const hub of hubs) {
      const miles = haversineMiles(sLl, nodeLatLng(hub))
      const rem = remaining.get(hub.id) ?? 0
      let score: number
      if (mode === 'distance') {
        score = miles
      } else if (mode === 'volume') {
        // Prefer hubs with headroom; soft distance penalty
        const headroomPenalty = rem >= vol ? 0 : (vol - rem) * 0.05
        score = miles * 0.35 + headroomPenalty * 10 + (rem > 0 ? 0 : 1e6)
      } else {
        // balanced: blend distance with capacity pressure
        const w = Math.min(1, Math.max(0, volumeWeight))
        const pressure = rem > 0 ? vol / rem : 2
        score = (1 - w) * miles + w * miles * (0.5 + pressure)
      }
      if (!best || score < best.score) {
        best = { hub, miles, score }
      }
    }

    if (!best) {
      unassigned.push(spoke.id)
      continue
    }

    remaining.set(
      best.hub.id,
      (remaining.get(best.hub.id) ?? 0) - vol,
    )
    assignments.push({
      spokeId: spoke.id,
      spokeName: spoke.name,
      hubId: best.hub.id,
      hubName: best.hub.name,
      miles: Math.round(best.miles),
      volume: vol,
    })
    void hubById
  }

  return { assignments, unassigned }
}

function buildHubLoads(
  hubs: NetworkNode[],
  assignments: SpokeAssignment[],
): HubLoad[] {
  return hubs.map((h) => {
    const spokes = assignments.filter((a) => a.hubId === h.id)
    const assignedVolume = spokes.reduce((s, a) => s + a.volume, 0)
    const capacity = parseCapacity(h.capacity)
    return {
      hubId: h.id,
      hubName: h.name,
      capacity,
      assignedVolume,
      utilPct:
        capacity > 0
          ? Math.round((assignedVolume / capacity) * 1000) / 10
          : 0,
      spokeCount: spokes.length,
    }
  })
}

function estimateKpis(
  before: KpiSnapshot,
  preview: {
    assignments: SpokeAssignment[]
    hubLoads: HubLoad[]
    newLaneCount: number
    replacedLaneCount: number
  },
): KpiSnapshot {
  const avgMiles =
    preview.assignments.length > 0
      ? preview.assignments.reduce((s, a) => s + a.miles, 0) /
        preview.assignments.length
      : 400
  // Rough: shorter avg haul → lower cost / co2; hub util balance → service
  const baselineAvg = 420
  const mileDelta = (avgMiles - baselineAvg) / baselineAvg
  const utilVals = preview.hubLoads.map((h) => h.utilPct)
  const maxUtil = utilVals.length ? Math.max(...utilVals) : 80
  const meanUtil =
    utilVals.length > 0
      ? utilVals.reduce((a, b) => a + b, 0) / utilVals.length
      : 70
  const overload = Math.max(0, maxUtil - 100)

  const refCost =
    parseFloat(String(before.cost.value).replace(/[^0-9.]/g, '')) || 48.2
  const refService =
    parseFloat(String(before.service.value).replace(/[^0-9.]/g, '')) || 94.1
  const refCo2 =
    parseFloat(String(before.co2.value).replace(/[^0-9.]/g, '')) || 12.4

  const cost = Math.max(28, refCost * (1 + mileDelta * 0.55))
  const costDeltaPct = ((cost - refCost) / refCost) * 100
  const service = Math.min(
    99.5,
    Math.max(80, refService + (baselineAvg - avgMiles) / 80 - overload * 0.08),
  )
  const serviceDelta = service - refService
  const co2 = Math.max(4, refCo2 * (1 + mileDelta * 0.7))
  const co2DeltaPct = ((co2 - refCo2) / refCo2) * 100
  const capexM = 0 // topology redesign, no new sites

  const riskLabel =
    overload > 15 || meanUtil > 110
      ? 'High'
      : overload > 0 || meanUtil > 95
        ? 'Med'
        : 'Low'

  return {
    cost: {
      value: `$${cost.toFixed(1)}M`,
      delta: `${costDeltaPct >= 0 ? '+' : '−'}${Math.abs(costDeltaPct).toFixed(1)}%`,
      better: costDeltaPct <= 0,
    },
    service: {
      value: `${service.toFixed(1)}%`,
      delta: `${serviceDelta >= 0 ? '+' : '−'}${Math.abs(serviceDelta).toFixed(1)}pp`,
      better: serviceDelta >= 0,
    },
    capex: {
      value: `$${capexM}M`,
      delta: '—',
      better: true,
    },
    co2: {
      value: `${co2.toFixed(1)} kt`,
      delta: `${co2DeltaPct >= 0 ? '+' : '−'}${Math.abs(co2DeltaPct).toFixed(0)}%`,
      better: co2DeltaPct <= 0,
    },
    risk: {
      value: riskLabel,
      delta: `max util ${maxUtil.toFixed(0)}%`,
      better: riskLabel !== 'High',
    },
  }
}

/** Preview hub-and-spoke redesign without mutating network. */
export function previewHubSpoke(
  network: UploadedNetwork,
  params: HubSpokeParams,
  referenceKpis: KpiSnapshot = BASELINE_KPIS,
): HubSpokePreview {
  const hubSet = new Set(params.hubIds)
  const hubs = network.nodes.filter((n) => hubSet.has(n.id))
  const spokes = network.nodes.filter((n) => n.kind === 'demand')

  const { assignments, unassigned } = assignSpokes({
    hubs,
    spokes,
    demandVolume: network.demandVolume,
    mode: params.mode,
    volumeWeight: params.volumeWeight,
  })

  const hubLoads = buildHubLoads(hubs, assignments)

  const newLanes: NetworkLane[] = assignments.map((a, i) => {
    const costs = laneCostFromMiles(a.miles)
    return {
      id: `hs-l-${a.hubId}-${a.spokeId}-${i}`,
      from: a.hubId,
      to: a.spokeId,
      mode: params.laneMode || 'Truck',
      costPerUnit: costs.costPerUnit,
      leadDays: costs.leadDays,
      co2Kg: costs.co2Kg,
    }
  })

  const demandIds = new Set(spokes.map((s) => s.id))
  const keptLanes = params.replaceDemandLanes
    ? network.lanes.filter((l) => !demandIds.has(l.to))
    : [...network.lanes]

  // Avoid duplicate hub→spoke if keep-all mode
  const existingKeys = new Set(keptLanes.map((l) => `${l.from}->${l.to}`))
  const uniqueNew = newLanes.filter(
    (l) => !existingKeys.has(`${l.from}->${l.to}`),
  )
  const resultingLanes = [...keptLanes, ...uniqueNew]

  const replacedCount = params.replaceDemandLanes
    ? network.lanes.length - keptLanes.length
    : 0

  const after = estimateKpis(referenceKpis, {
    assignments,
    hubLoads,
    newLaneCount: uniqueNew.length,
    replacedLaneCount: replacedCount,
  })

  const summary = `${hubs.length} hubs · ${assignments.length} spokes assigned · ${uniqueNew.length} new lanes${
    replacedCount ? ` · replaced ${replacedCount} demand lanes` : ''
  }${unassigned.length ? ` · ${unassigned.length} unassigned` : ''}`

  return {
    assignments,
    hubLoads,
    newLanes: uniqueNew,
    keptLanes,
    resultingLanes,
    kpis: { before: referenceKpis, after },
    unassignedSpokeIds: unassigned,
    summary,
  }
}

/** Apply hub-and-spoke redesign → new network + draft scenario. */
export function applyHubSpokeDesign(
  network: UploadedNetwork,
  params: HubSpokeParams,
  referenceKpis: KpiSnapshot = BASELINE_KPIS,
): HubSpokeResult {
  const preview = previewHubSpoke(network, params, referenceKpis)
  const issues = [...network.validation.issues]
  if (preview.unassignedSpokeIds.length > 0) {
    issues.push({
      level: 'warn',
      message: `${preview.unassignedSpokeIds.length} demand node(s) not assigned to a hub.`,
    })
  }
  const geocoded = network.nodes.filter(
    (n) => n.lat != null && n.lng != null,
  ).length
  const validation = buildValidation(
    network.nodes,
    preview.resultingLanes,
    network.demandVolume,
    issues,
    geocoded,
    network.nodes.length,
  )

  const next: UploadedNetwork = {
    ...network,
    lanes: preview.resultingLanes,
    source: network.source,
    fileNames: {
      ...network.fileNames,
      lanes: network.fileNames.lanes
        ? `${network.fileNames.lanes}+hub-spoke`
        : 'hub-spoke-lanes',
    },
    validation,
  }

  const name =
    params.scenarioName?.trim() ||
    `Hub-spoke (${params.hubIds.length} hubs · ${params.mode})`

  const draftScenario: Scenario = {
    id: `hubspoke-${Date.now().toString(36)}`,
    name,
    tag: 'Draft',
    baseId: 'baseline',
    kpis: preview.kpis.after,
    optimizeMeta: {
      heuristic: 'hub-spoke-v1',
      openedIds: params.hubIds,
      closedIds: [],
      servicePct:
        parseFloat(
          String(preview.kpis.after.service.value).replace(/[^0-9.]/g, ''),
        ) || 94,
      capexUsedM: 0,
      flows: preview.assignments.map((a) => ({
        from: a.hubId,
        to: a.spokeId,
        volume: a.volume,
        miles: a.miles,
      })),
    },
  }

  return { network: next, draftScenario, preview }
}
