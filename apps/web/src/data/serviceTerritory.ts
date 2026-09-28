/**
 * Service territory / coverage design — assign demand to serving
 * DCs/plants by distance, capacity, or current lanes; coverage metrics,
 * gaps/overlaps; apply as scenario or update preferred (demand-inbound) lanes.
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

export type TerritoryAssignMode = 'distance' | 'capacity' | 'lanes'

export type TerritoryParams = {
  /** Serving facilities; empty = all open DC / plant / candidate. */
  facilityIds: string[]
  mode: TerritoryAssignMode
  /** Miles radius for “% covered within X miles”. */
  coverageMiles: number
  /** Lead-time (days) for “% covered within lead-time”. */
  coverageLeadDays: number
  /** Replace existing demand-inbound lanes with preferred assignments. */
  replaceDemandLanes: boolean
  /** Lane mode for newly created preferred links. */
  laneMode: string
  scenarioName?: string
}

export type TerritoryAssignment = {
  demandId: string
  demandName: string
  facilityId: string | null
  facilityName: string | null
  miles: number | null
  leadDays: number | null
  volume: number
  withinMiles: boolean
  withinLead: boolean
  /** Other facilities that also cover this demand (overlap). */
  overlapFacilityIds: string[]
  overlapNames: string[]
  status: 'assigned' | 'gap' | 'overlap'
}

export type TerritoryLoad = {
  facilityId: string
  facilityName: string
  capacity: number
  assignedVolume: number
  utilPct: number
  demandCount: number
  color: string
}

export type TerritoryMetrics = {
  totalDemandVolume: number
  assignedVolume: number
  unassignedVolume: number
  assignedCount: number
  gapCount: number
  overlapCount: number
  /** Volume-weighted % within coverageMiles. */
  pctCoveredWithinMiles: number
  /** Volume-weighted % within coverageLeadDays (assigned only; gaps = 0). */
  pctCoveredWithinLead: number
  demandCount: number
}

export type TerritoryKpiPair = {
  before: KpiSnapshot
  after: KpiSnapshot
}

export type TerritoryPreview = {
  assignments: TerritoryAssignment[]
  loads: TerritoryLoad[]
  metrics: TerritoryMetrics
  newLanes: NetworkLane[]
  keptLanes: NetworkLane[]
  resultingLanes: NetworkLane[]
  kpis: TerritoryKpiPair
  summary: string
  /** Facility id → color for map. */
  colorByFacility: Record<string, string>
}

export type TerritoryResult = {
  network: UploadedNetwork
  draftScenario: Scenario
  preview: TerritoryPreview
}

/** Distinct palette for territory map coloring. */
export const TERRITORY_PALETTE = [
  '#38bdf8',
  '#34d399',
  '#fbbf24',
  '#f472b6',
  '#a78bfa',
  '#fb923c',
  '#2dd4bf',
  '#e879f9',
  '#60a5fa',
  '#4ade80',
] as const

export const GAP_COLOR = '#94a3b8'
export const OVERLAP_RING = '#f87171'

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

/** Eligible serving sites: DC / plant / candidate (not closed). */
export function eligibleServingNodes(
  nodes: NetworkNode[],
  closedIds?: Set<string>,
): NetworkNode[] {
  return nodes.filter((n) => {
    if (n.kind !== 'dc' && n.kind !== 'plant' && n.kind !== 'candidate') {
      return false
    }
    if (closedIds?.has(n.id)) return false
    return true
  })
}

export function suggestServingIds(nodes: NetworkNode[]): string[] {
  return eligibleServingNodes(nodes).map((n) => n.id)
}

export function territoryColorForIndex(i: number): string {
  return TERRITORY_PALETTE[i % TERRITORY_PALETTE.length]
}

function assignByDistance(
  facilities: NetworkNode[],
  demands: NetworkNode[],
  demandVolume: Record<string, number>,
): Map<string, { facility: NetworkNode; miles: number }> {
  const out = new Map<string, { facility: NetworkNode; miles: number }>()
  if (facilities.length === 0) return out
  for (const d of demands) {
    const dLl = nodeLatLng(d)
    let best: { facility: NetworkNode; miles: number } | null = null
    for (const f of facilities) {
      const miles = haversineMiles(dLl, nodeLatLng(f))
      if (!best || miles < best.miles) best = { facility: f, miles }
    }
    if (best) out.set(d.id, best)
  }
  void demandVolume
  return out
}

function assignByCapacity(
  facilities: NetworkNode[],
  demands: NetworkNode[],
  demandVolume: Record<string, number>,
): Map<string, { facility: NetworkNode; miles: number }> {
  const out = new Map<string, { facility: NetworkNode; miles: number }>()
  if (facilities.length === 0) return out

  const remaining = new Map(
    facilities.map((f) => [f.id, parseCapacity(f.capacity) * 1.15]),
  )
  const ordered = [...demands].sort(
    (a, b) => demandVol(b, demandVolume) - demandVol(a, demandVolume),
  )

  for (const d of ordered) {
    const vol = demandVol(d, demandVolume)
    const dLl = nodeLatLng(d)
    let best: { facility: NetworkNode; miles: number; score: number } | null =
      null
    for (const f of facilities) {
      const miles = haversineMiles(dLl, nodeLatLng(f))
      const rem = remaining.get(f.id) ?? 0
      const headroomPenalty = rem >= vol ? 0 : (vol - rem) * 0.08
      const score = miles * 0.4 + headroomPenalty * 12 + (rem > 0 ? 0 : 1e6)
      if (!best || score < best.score) best = { facility: f, miles, score }
    }
    if (best) {
      remaining.set(
        best.facility.id,
        (remaining.get(best.facility.id) ?? 0) - vol,
      )
      out.set(d.id, { facility: best.facility, miles: best.miles })
    }
  }
  return out
}

/** Prefer current inbound lanes; if multiple, cheapest then fastest. */
function assignByLanes(
  facilities: NetworkNode[],
  demands: NetworkNode[],
  lanes: NetworkLane[],
  demandVolume: Record<string, number>,
): Map<string, { facility: NetworkNode; miles: number; leadDays: number }> {
  const facById = new Map(facilities.map((f) => [f.id, f]))
  const demandIds = new Set(demands.map((d) => d.id))
  const out = new Map<
    string,
    { facility: NetworkNode; miles: number; leadDays: number }
  >()

  const inbound = new Map<string, NetworkLane[]>()
  for (const lane of lanes) {
    if (!demandIds.has(lane.to)) continue
    if (!facById.has(lane.from)) continue
    const list = inbound.get(lane.to) ?? []
    list.push(lane)
    inbound.set(lane.to, list)
  }

  for (const d of demands) {
    const candidates = inbound.get(d.id) ?? []
    if (candidates.length === 0) continue
    const ranked = [...candidates].sort((a, b) => {
      if (a.costPerUnit !== b.costPerUnit) return a.costPerUnit - b.costPerUnit
      return a.leadDays - b.leadDays
    })
    const pick = ranked[0]
    const facility = facById.get(pick.from)!
    const miles = haversineMiles(nodeLatLng(d), nodeLatLng(facility))
    out.set(d.id, { facility, miles, leadDays: pick.leadDays })
  }
  void demandVolume
  return out
}

function findOverlaps(args: {
  demands: NetworkNode[]
  facilities: NetworkNode[]
  lanes: NetworkLane[]
  coverageMiles: number
  primary: Map<string, { facility: NetworkNode; miles: number }>
}): Map<string, NetworkNode[]> {
  const { demands, facilities, lanes, coverageMiles, primary } = args
  const demandIds = new Set(demands.map((d) => d.id))
  const facById = new Map(facilities.map((f) => [f.id, f]))
  const overlaps = new Map<string, NetworkNode[]>()

  // Multi-lane overlaps
  const inboundFac = new Map<string, Set<string>>()
  for (const lane of lanes) {
    if (!demandIds.has(lane.to)) continue
    if (!facById.has(lane.from)) continue
    const set = inboundFac.get(lane.to) ?? new Set()
    set.add(lane.from)
    inboundFac.set(lane.to, set)
  }

  for (const d of demands) {
    const others: NetworkNode[] = []
    const seen = new Set<string>()
    const primaryId = primary.get(d.id)?.facility.id

    const laneFacs = inboundFac.get(d.id)
    if (laneFacs && laneFacs.size > 1) {
      for (const fid of laneFacs) {
        if (fid === primaryId) continue
        const f = facById.get(fid)
        if (f && !seen.has(f.id)) {
          others.push(f)
          seen.add(f.id)
        }
      }
    }

    // Radius overlaps (other facilities within coverageMiles)
    const dLl = nodeLatLng(d)
    for (const f of facilities) {
      if (f.id === primaryId || seen.has(f.id)) continue
      const miles = haversineMiles(dLl, nodeLatLng(f))
      if (miles <= coverageMiles) {
        others.push(f)
        seen.add(f.id)
      }
    }

    if (others.length > 0) overlaps.set(d.id, others)
  }

  return overlaps
}

function estimateKpis(
  before: KpiSnapshot,
  preview: {
    assignments: TerritoryAssignment[]
    loads: TerritoryLoad[]
    metrics: TerritoryMetrics
  },
): KpiSnapshot {
  const assigned = preview.assignments.filter((a) => a.facilityId)
  const avgMiles =
    assigned.length > 0
      ? assigned.reduce((s, a) => s + (a.miles ?? 0), 0) / assigned.length
      : 400
  const baselineAvg = 420
  const mileDelta = (avgMiles - baselineAvg) / baselineAvg
  const utilVals = preview.loads.map((h) => h.utilPct)
  const maxUtil = utilVals.length ? Math.max(...utilVals) : 80
  const meanUtil =
    utilVals.length > 0
      ? utilVals.reduce((a, b) => a + b, 0) / utilVals.length
      : 70
  const overload = Math.max(0, maxUtil - 100)
  const coverBonus = (preview.metrics.pctCoveredWithinMiles - 85) / 20

  const refCost =
    parseFloat(String(before.cost.value).replace(/[^0-9.]/g, '')) || 48.2
  const refService =
    parseFloat(String(before.service.value).replace(/[^0-9.]/g, '')) || 94.1
  const refCo2 =
    parseFloat(String(before.co2.value).replace(/[^0-9.]/g, '')) || 12.4

  const cost = Math.max(28, refCost * (1 + mileDelta * 0.5))
  const costDeltaPct = ((cost - refCost) / refCost) * 100
  const service = Math.min(
    99.5,
    Math.max(
      75,
      refService +
        coverBonus * 2 +
        (baselineAvg - avgMiles) / 90 -
        overload * 0.07 -
        preview.metrics.gapCount * 0.4,
    ),
  )
  const serviceDelta = service - refService
  const co2 = Math.max(4, refCo2 * (1 + mileDelta * 0.65))
  const co2DeltaPct = ((co2 - refCo2) / refCo2) * 100

  const riskLabel =
    preview.metrics.gapCount > 0 || overload > 15 || meanUtil > 110
      ? 'High'
      : overload > 0 || meanUtil > 95 || preview.metrics.overlapCount > 2
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
      value: '$0M',
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
      delta: `${preview.metrics.gapCount} gaps · max util ${maxUtil.toFixed(0)}%`,
      better: riskLabel !== 'High',
    },
  }
}

/** Live map coloring from current network (lanes mode + distance fallback). */
export function computeTerritoryColors(
  network: UploadedNetwork,
  params?: Partial<TerritoryParams>,
): {
  colorByNode: Map<string, { color: string; label: string }>
  preview: TerritoryPreview
} {
  const preview = previewTerritory(network, {
    facilityIds: params?.facilityIds?.length
      ? params.facilityIds
      : suggestServingIds(network.nodes),
    mode: params?.mode ?? 'distance',
    coverageMiles: params?.coverageMiles ?? 400,
    coverageLeadDays: params?.coverageLeadDays ?? 3,
    replaceDemandLanes: false,
    laneMode: params?.laneMode ?? 'Truck',
  })

  const colorByNode = new Map<string, { color: string; label: string }>()
  for (const load of preview.loads) {
    colorByNode.set(load.facilityId, {
      color: load.color,
      label: `${load.facilityName} · ${load.demandCount} demand · ${load.utilPct.toFixed(0)}% util`,
    })
  }
  for (const a of preview.assignments) {
    if (!a.facilityId) {
      colorByNode.set(a.demandId, {
        color: GAP_COLOR,
        label: `${a.demandName} · coverage gap`,
      })
      continue
    }
    const color = preview.colorByFacility[a.facilityId] ?? GAP_COLOR
    const overlap =
      a.status === 'overlap' ? ` · overlap w/ ${a.overlapNames.join(', ')}` : ''
    colorByNode.set(a.demandId, {
      color,
      label: `${a.demandName} ← ${a.facilityName}${a.miles != null ? ` · ${a.miles} mi` : ''}${overlap}`,
    })
  }
  return { colorByNode, preview }
}

/** Preview territory design without mutating network. */
export function previewTerritory(
  network: UploadedNetwork,
  params: TerritoryParams,
  referenceKpis: KpiSnapshot = BASELINE_KPIS,
): TerritoryPreview {
  const eligible = eligibleServingNodes(network.nodes)
  const facSet =
    params.facilityIds.length > 0
      ? new Set(params.facilityIds)
      : new Set(eligible.map((n) => n.id))
  const facilities = eligible.filter((n) => facSet.has(n.id))
  const demands = network.nodes.filter((n) => n.kind === 'demand')

  const colorByFacility: Record<string, string> = {}
  facilities.forEach((f, i) => {
    colorByFacility[f.id] = territoryColorForIndex(i)
  })

  let primary = new Map<string, { facility: NetworkNode; miles: number; leadDays?: number }>()

  if (params.mode === 'distance') {
    primary = assignByDistance(facilities, demands, network.demandVolume)
  } else if (params.mode === 'capacity') {
    primary = assignByCapacity(facilities, demands, network.demandVolume)
  } else {
    // Lanes only — unassigned demand remains a coverage gap
    primary = assignByLanes(
      facilities,
      demands,
      network.lanes,
      network.demandVolume,
    )
  }

  const overlaps = findOverlaps({
    demands,
    facilities,
    lanes: network.lanes,
    coverageMiles: params.coverageMiles,
    primary,
  })

  const assignments: TerritoryAssignment[] = demands.map((d) => {
    const pick = primary.get(d.id)
    const vol = demandVol(d, network.demandVolume)
    const overlapNodes = overlaps.get(d.id) ?? []
    if (!pick) {
      return {
        demandId: d.id,
        demandName: d.name,
        facilityId: null,
        facilityName: null,
        miles: null,
        leadDays: null,
        volume: vol,
        withinMiles: false,
        withinLead: false,
        overlapFacilityIds: overlapNodes.map((o) => o.id),
        overlapNames: overlapNodes.map((o) => o.name),
        status: 'gap' as const,
      }
    }
    const miles = Math.round(pick.miles)
    const costs = laneCostFromMiles(pick.miles)
    const leadDays =
      pick.leadDays != null ? pick.leadDays : costs.leadDays
    const withinMiles = miles <= params.coverageMiles
    const withinLead = leadDays <= params.coverageLeadDays
    const status: TerritoryAssignment['status'] =
      overlapNodes.length > 0 ? 'overlap' : 'assigned'
    return {
      demandId: d.id,
      demandName: d.name,
      facilityId: pick.facility.id,
      facilityName: pick.facility.name,
      miles,
      leadDays,
      volume: vol,
      withinMiles,
      withinLead,
      overlapFacilityIds: overlapNodes.map((o) => o.id),
      overlapNames: overlapNodes.map((o) => o.name),
      status,
    }
  })

  const loads: TerritoryLoad[] = facilities.map((f) => {
    const served = assignments.filter((a) => a.facilityId === f.id)
    const assignedVolume = served.reduce((s, a) => s + a.volume, 0)
    const capacity = parseCapacity(f.capacity)
    return {
      facilityId: f.id,
      facilityName: f.name,
      capacity,
      assignedVolume,
      utilPct:
        capacity > 0
          ? Math.round((assignedVolume / capacity) * 1000) / 10
          : 0,
      demandCount: served.length,
      color: colorByFacility[f.id],
    }
  })

  const totalDemandVolume = assignments.reduce((s, a) => s + a.volume, 0)
  const assignedList = assignments.filter((a) => a.facilityId)
  const assignedVolume = assignedList.reduce((s, a) => s + a.volume, 0)
  const unassignedVolume = totalDemandVolume - assignedVolume
  const withinMilesVol = assignments
    .filter((a) => a.withinMiles)
    .reduce((s, a) => s + a.volume, 0)
  const withinLeadVol = assignments
    .filter((a) => a.withinLead)
    .reduce((s, a) => s + a.volume, 0)
  const denom = totalDemandVolume || 1

  const metrics: TerritoryMetrics = {
    totalDemandVolume,
    assignedVolume,
    unassignedVolume,
    assignedCount: assignedList.length,
    gapCount: assignments.filter((a) => a.status === 'gap' || !a.facilityId)
      .length,
    overlapCount: assignments.filter((a) => a.status === 'overlap').length,
    pctCoveredWithinMiles: Math.round((withinMilesVol / denom) * 1000) / 10,
    pctCoveredWithinLead: Math.round((withinLeadVol / denom) * 1000) / 10,
    demandCount: demands.length,
  }

  // In lanes mode with distance fallback, "true" gaps are only those still null
  // (already handled). For metrics gapCount use unassigned only.
  metrics.gapCount = assignments.filter((a) => !a.facilityId).length

  const newLanes: NetworkLane[] = assignedList.map((a, i) => {
    const miles = a.miles ?? 100
    const costs = laneCostFromMiles(miles)
    return {
      id: `terr-l-${a.facilityId}-${a.demandId}-${i}`,
      from: a.facilityId!,
      to: a.demandId,
      mode: params.laneMode || 'Truck',
      costPerUnit: costs.costPerUnit,
      leadDays: a.leadDays ?? costs.leadDays,
      co2Kg: costs.co2Kg,
    }
  })

  const demandIds = new Set(demands.map((d) => d.id))
  const keptLanes = params.replaceDemandLanes
    ? network.lanes.filter((l) => !demandIds.has(l.to))
    : [...network.lanes]

  const existingKeys = new Set(keptLanes.map((l) => `${l.from}->${l.to}`))
  const uniqueNew = newLanes.filter(
    (l) => !existingKeys.has(`${l.from}->${l.to}`),
  )
  const resultingLanes = params.replaceDemandLanes
    ? [...keptLanes, ...uniqueNew]
    : [...keptLanes, ...uniqueNew]

  const after = estimateKpis(referenceKpis, { assignments, loads, metrics })

  const summary = `${facilities.length} servers · ${metrics.assignedCount}/${metrics.demandCount} demand assigned · ${metrics.pctCoveredWithinMiles}% within ${params.coverageMiles} mi · ${metrics.pctCoveredWithinLead}% within ${params.coverageLeadDays}d lead · ${metrics.gapCount} gaps · ${metrics.overlapCount} overlaps`

  return {
    assignments,
    loads,
    metrics,
    newLanes: uniqueNew,
    keptLanes,
    resultingLanes,
    kpis: { before: referenceKpis, after },
    summary,
    colorByFacility,
  }
}

/** Apply territory → update preferred demand lanes + draft scenario. */
export function applyTerritoryDesign(
  network: UploadedNetwork,
  params: TerritoryParams,
  referenceKpis: KpiSnapshot = BASELINE_KPIS,
): TerritoryResult {
  const preview = previewTerritory(
    network,
    { ...params, replaceDemandLanes: true },
    referenceKpis,
  )
  const issues = [...network.validation.issues]
  if (preview.metrics.gapCount > 0) {
    issues.push({
      level: 'warn',
      message: `${preview.metrics.gapCount} demand node(s) outside service territory (unassigned).`,
    })
  }
  if (preview.metrics.overlapCount > 0) {
    issues.push({
      level: 'info',
      message: `${preview.metrics.overlapCount} demand node(s) have overlapping coverage.`,
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
        ? `${network.fileNames.lanes}+territory`
        : 'territory-lanes',
    },
    validation,
  }

  const name =
    params.scenarioName?.trim() ||
    `Territory (${params.mode} · ${params.coverageMiles} mi)`

  const draftScenario: Scenario = {
    id: `territory-${Date.now().toString(36)}`,
    name,
    tag: 'Draft',
    baseId: 'baseline',
    kpis: preview.kpis.after,
    optimizeMeta: {
      heuristic: 'territory-v1',
      openedIds: preview.loads.map((l) => l.facilityId),
      closedIds: [],
      servicePct: preview.metrics.pctCoveredWithinMiles,
      capexUsedM: 0,
      flows: preview.assignments
        .filter((a) => a.facilityId)
        .map((a) => ({
          from: a.facilityId!,
          to: a.demandId,
          volume: a.volume,
          miles: a.miles ?? undefined,
        })),
    },
  }

  return { network: next, draftScenario, preview }
}
