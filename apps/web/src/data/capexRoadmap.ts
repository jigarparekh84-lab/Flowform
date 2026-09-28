/**
 * CapEx phasing / multi-year roadmap.
 * Model facility open / close / expand events across Y0–Y5 with CapEx $
 * and capacity delta; roll up cumulative spend + capacity; apply a year
 * slice as a network scenario or export a summary into Decision Brief.
 */

import { buildValidation, type UploadedNetwork } from './csvParsers'
import type {
  FacilityConstraint,
  KpiSnapshot,
  NetworkConstraints,
  NetworkNode,
  Scenario,
} from './sampleNetwork'
import { BASELINE_KPIS } from './sampleNetwork'

export type CapexEventKind = 'open' | 'close' | 'expand'

export type CapexEvent = {
  id: string
  name: string
  kind: CapexEventKind
  /** Year index 0..yearCount-1 (Y0 = base year). */
  year: number
  /** Facility node id (existing or new for open). */
  nodeId: string
  nodeName: string
  /** CapEx spend $M (close may be teardown cost; salvage as negative). */
  capexM: number
  /** Capacity units delta (positive expand/open; negative on close). */
  capacityDelta: number
  region?: string
  /** For open events: facility kind to create if missing. */
  facilityKind?: 'plant' | 'dc' | 'candidate'
  notes?: string
}

export type CapexRoadmapState = {
  /** Label for Y0, e.g. FY26. */
  baseYearLabel: string
  /** Inclusive span Y0..(yearCount-1); default 6 → Y0–Y5. */
  yearCount: number
  events: CapexEvent[]
}

export type YearSliceSummary = {
  year: number
  label: string
  yearLabel: string
  eventsThisYear: CapexEvent[]
  capexThisYearM: number
  cumulativeCapexM: number
  capacityDeltaThisYear: number
  cumulativeCapacityDelta: number
  /** Open facility capacity units after events through this year. */
  totalCapacityUnits: number
  openFacilityCount: number
  closedFacilityCount: number
}

export type ApplyYearSliceResult = {
  network: UploadedNetwork
  constraints: NetworkConstraints
  draftScenario: Scenario
  summary: YearSliceSummary
  appliedEvents: CapexEvent[]
}

const DEFAULT_YEAR_COUNT = 6

function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

function parseVolume(capacity: string): number {
  const m = String(capacity).match(/[\d.]+/)
  return m ? parseFloat(m[0]) : 0
}

function formatCapacity(units: number, kind: NetworkNode['kind']): string {
  const u = Math.max(0, Math.round(units * 10) / 10)
  if (kind === 'dc') return `${u}k pallet`
  return `${u}k u/wk`
}

export function yearLabelFor(baseYearLabel: string, year: number): string {
  const m = baseYearLabel.match(/^(FY|CY)?(\d{2,4})$/i)
  if (!m) return `${baseYearLabel}+${year}`
  const prefix = m[1] ?? ''
  let n = parseInt(m[2], 10)
  if (m[2].length === 2) n = 2000 + n
  const next = n + year
  const short = String(next).slice(-2)
  return `${prefix}${short}`
}

export function defaultCapexRoadmap(network: UploadedNetwork): CapexRoadmapState {
  const facilities = network.nodes.filter(
    (n) => n.kind === 'dc' || n.kind === 'plant' || n.kind === 'candidate',
  )
  const columbus = facilities.find((n) => /columbus/i.test(n.name))
  const reno = facilities.find((n) => /reno/i.test(n.name))
  const atlanta = facilities.find((n) => /atlanta/i.test(n.name))
  const plant = facilities.find((n) => n.kind === 'plant')

  const events: CapexEvent[] = []

  if (columbus) {
    events.push({
      id: 'ev-expand-columbus',
      name: `Expand ${columbus.name}`,
      kind: 'expand',
      year: 1,
      nodeId: columbus.id,
      nodeName: columbus.name,
      capexM: 4.5,
      capacityDelta: 6,
      region: columbus.region,
      notes: 'Midwest overflow capacity',
    })
  }

  events.push({
    id: 'ev-open-kc',
    name: 'Open Kansas City DC',
    kind: 'open',
    year: 2,
    nodeId: 'roadmap-kc-dc',
    nodeName: 'Kansas City DC',
    capexM: 12,
    capacityDelta: 10,
    region: 'Midwest',
    facilityKind: 'dc',
    notes: 'Central hub for NA Core growth',
  })

  if (reno) {
    events.push({
      id: 'ev-expand-reno',
      name: `Expand ${reno.name}`,
      kind: 'expand',
      year: 3,
      nodeId: reno.id,
      nodeName: reno.name,
      capexM: 3.2,
      capacityDelta: 4,
      region: reno.region,
      notes: 'West coast buffer',
    })
  }

  if (atlanta) {
    events.push({
      id: 'ev-close-atlanta',
      name: `Close ${atlanta.name}`,
      kind: 'close',
      year: 4,
      nodeId: atlanta.id,
      nodeName: atlanta.name,
      capexM: 1.5,
      capacityDelta: -parseVolume(atlanta.capacity),
      region: atlanta.region,
      notes: 'Consolidate Southeast into KC + Columbus',
    })
  }

  if (plant) {
    events.push({
      id: 'ev-expand-plant',
      name: `Expand ${plant.name}`,
      kind: 'expand',
      year: 5,
      nodeId: plant.id,
      nodeName: plant.name,
      capexM: 8,
      capacityDelta: 8,
      region: plant.region,
      notes: 'Finish-goods line +2',
    })
  }

  return {
    baseYearLabel: 'FY26',
    yearCount: DEFAULT_YEAR_COUNT,
    events,
  }
}

export function mergeCapexRoadmap(
  prev: CapexRoadmapState | undefined | null,
  network: UploadedNetwork,
): CapexRoadmapState {
  if (!prev || !Array.isArray(prev.events)) {
    return defaultCapexRoadmap(network)
  }
  return {
    baseYearLabel: prev.baseYearLabel || 'FY26',
    yearCount: Math.max(2, Math.min(10, prev.yearCount || DEFAULT_YEAR_COUNT)),
    events: prev.events.map((e) => ({
      ...e,
      year: Math.max(0, Math.min(9, e.year ?? 0)),
      capexM: Number.isFinite(e.capexM) ? e.capexM : 0,
      capacityDelta: Number.isFinite(e.capacityDelta) ? e.capacityDelta : 0,
    })),
  }
}

export function addCapexEvent(
  state: CapexRoadmapState,
  partial?: Partial<CapexEvent>,
): CapexRoadmapState {
  const year = Math.max(
    0,
    Math.min(state.yearCount - 1, partial?.year ?? 1),
  )
  const kind = partial?.kind ?? 'expand'
  const event: CapexEvent = {
    id: partial?.id ?? uid('ev'),
    name: partial?.name ?? 'New CapEx event',
    kind,
    year,
    nodeId: partial?.nodeId ?? uid('node'),
    nodeName: partial?.nodeName ?? 'New facility',
    capexM: partial?.capexM ?? (kind === 'open' ? 10 : kind === 'close' ? 1 : 3),
    capacityDelta:
      partial?.capacityDelta ??
      (kind === 'open' ? 8 : kind === 'close' ? -5 : 4),
    region: partial?.region,
    facilityKind: partial?.facilityKind ?? (kind === 'open' ? 'dc' : undefined),
    notes: partial?.notes,
  }
  return { ...state, events: [...state.events, event] }
}

export function updateCapexEvent(
  state: CapexRoadmapState,
  id: string,
  patch: Partial<Omit<CapexEvent, 'id'>>,
): CapexRoadmapState {
  return {
    ...state,
    events: state.events.map((e) =>
      e.id === id
        ? {
            ...e,
            ...patch,
            year:
              patch.year != null
                ? Math.max(0, Math.min(state.yearCount - 1, patch.year))
                : e.year,
          }
        : e,
    ),
  }
}

export function removeCapexEvent(
  state: CapexRoadmapState,
  id: string,
): CapexRoadmapState {
  return { ...state, events: state.events.filter((e) => e.id !== id) }
}

function baselineCapacityUnits(network: UploadedNetwork): number {
  return network.nodes
    .filter((n) => n.kind === 'dc' || n.kind === 'plant')
    .reduce((s, n) => s + parseVolume(n.capacity), 0)
}

function baselineOpenCount(network: UploadedNetwork): number {
  return network.nodes.filter((n) => n.kind === 'dc' || n.kind === 'plant')
    .length
}

/** Cumulative CapEx / capacity and facility counts by year. */
export function roadmapYearSummaries(
  state: CapexRoadmapState,
  network: UploadedNetwork,
): YearSliceSummary[] {
  const baseCap = baselineCapacityUnits(network)
  const baseOpen = baselineOpenCount(network)
  let cumCapex = 0
  let cumCapDelta = 0
  let openCount = baseOpen
  let closedCount = 0

  const out: YearSliceSummary[] = []
  for (let y = 0; y < state.yearCount; y++) {
    const eventsThisYear = state.events
      .filter((e) => e.year === y)
      .sort((a, b) => a.name.localeCompare(b.name))
    const capexThisYearM = eventsThisYear.reduce((s, e) => s + e.capexM, 0)
    const capacityDeltaThisYear = eventsThisYear.reduce(
      (s, e) => s + e.capacityDelta,
      0,
    )
    cumCapex += capexThisYearM
    cumCapDelta += capacityDeltaThisYear

    for (const e of eventsThisYear) {
      if (e.kind === 'open') openCount += 1
      if (e.kind === 'close') {
        openCount = Math.max(0, openCount - 1)
        closedCount += 1
      }
    }

    const yl = yearLabelFor(state.baseYearLabel, y)
    out.push({
      year: y,
      label: `Y${y}`,
      yearLabel: yl,
      eventsThisYear,
      capexThisYearM: round1(capexThisYearM),
      cumulativeCapexM: round1(cumCapex),
      capacityDeltaThisYear: round1(capacityDeltaThisYear),
      cumulativeCapacityDelta: round1(cumCapDelta),
      totalCapacityUnits: round1(baseCap + cumCapDelta),
      openFacilityCount: openCount,
      closedFacilityCount: closedCount,
    })
  }
  return out
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

function kpisForSlice(
  summary: YearSliceSummary,
  reference: KpiSnapshot,
): KpiSnapshot {
  const refCost =
    parseFloat(String(reference.cost.value).replace(/[^0-9.]/g, '')) || 48.2
  const refService =
    parseFloat(String(reference.service.value).replace(/[^0-9.]/g, '')) || 94.1
  const refCo2 =
    parseFloat(String(reference.co2.value).replace(/[^0-9.]/g, '')) || 12.4

  // More capacity → modest service lift; CapEx raises annualized cost a bit.
  const serviceBoost = Math.min(4, summary.cumulativeCapacityDelta * 0.12)
  const costLift = summary.cumulativeCapexM * 0.08
  const cost = Math.max(20, refCost + costLift - summary.openFacilityCount * 0.15)
  const service = Math.min(99.5, Math.max(70, refService + serviceBoost))
  const co2 = Math.max(3, refCo2 * (1 + summary.cumulativeCapacityDelta * 0.01))

  const risk =
    summary.closedFacilityCount > 1
      ? 'Med'
      : summary.cumulativeCapexM > 25
        ? 'Med'
        : 'Low'

  return {
    cost: {
      value: `$${cost.toFixed(1)}M`,
      delta: `${cost >= refCost ? '+' : '−'}$${Math.abs(cost - refCost).toFixed(1)}M`,
      better: cost <= refCost,
    },
    service: {
      value: `${service.toFixed(1)}%`,
      delta: `${service >= refService ? '+' : '−'}${Math.abs(service - refService).toFixed(1)}pp`,
      better: service >= refService,
    },
    capex: {
      value: `$${summary.cumulativeCapexM}M`,
      delta: `Y${summary.year} cum`,
      better: summary.cumulativeCapexM <= 20,
    },
    co2: {
      value: `${co2.toFixed(1)} kt`,
      delta: `${co2 >= refCo2 ? '+' : '−'}${Math.abs(((co2 - refCo2) / refCo2) * 100).toFixed(0)}%`,
      better: co2 <= refCo2,
    },
    risk: {
      value: risk,
      delta: `${summary.openFacilityCount} open · ${summary.eventsThisYear.length} events`,
      better: risk === 'Low',
    },
  }
}

/**
 * Apply all roadmap events with year <= throughYear onto a copy of the
 * network + constraints. Returns a draft scenario for that year slice.
 */
export function applyYearSlice(
  network: UploadedNetwork,
  constraints: NetworkConstraints,
  state: CapexRoadmapState,
  throughYear: number,
  referenceKpis: KpiSnapshot = BASELINE_KPIS,
  scenarioName?: string,
): ApplyYearSliceResult {
  const y = Math.max(0, Math.min(state.yearCount - 1, throughYear))
  const summaries = roadmapYearSummaries(state, network)
  const summary = summaries[y]!
  const appliedEvents = state.events
    .filter((e) => e.year <= y)
    .sort((a, b) => a.year - b.year || a.name.localeCompare(b.name))

  let nodes: NetworkNode[] = network.nodes.map((n) => ({ ...n }))
  const nodeMap = new Map(nodes.map((n) => [n.id, n]))
  let facilities: FacilityConstraint[] = constraints.facilities.map((f) => ({
    ...f,
  }))
  const facMap = new Map(facilities.map((f) => [f.nodeId, f]))

  for (const ev of appliedEvents) {
    if (ev.kind === 'open') {
      let node = nodeMap.get(ev.nodeId)
      if (!node) {
        const kind = ev.facilityKind ?? 'dc'
        node = {
          id: ev.nodeId,
          name: ev.nodeName,
          kind,
          region: ev.region ?? 'NA',
          capacity: formatCapacity(Math.max(1, ev.capacityDelta), kind),
          x: 45 + (ev.year % 3) * 8,
          y: 40 + (ev.year % 2) * 10,
          lat: 39.1 + ev.year * 0.2,
          lng: -94.6 - ev.year * 0.3,
        }
        nodes = [...nodes, node]
        nodeMap.set(node.id, node)
      } else {
        const vol = parseVolume(node.capacity) + Math.max(0, ev.capacityDelta)
        node = {
          ...node,
          kind: node.kind === 'candidate' ? 'dc' : node.kind,
          name: ev.nodeName || node.name,
          capacity: formatCapacity(vol, node.kind === 'candidate' ? 'dc' : node.kind),
        }
        nodeMap.set(node.id, node)
        nodes = nodes.map((n) => (n.id === node!.id ? node! : n))
      }
      const vol = parseVolume(node.capacity)
      const prev = facMap.get(ev.nodeId)
      const nextFac: FacilityConstraint = {
        nodeId: ev.nodeId,
        status: 'open',
        capacityMin: Math.round(vol * 0.6),
        capacityMax: Math.round(vol * 1.25),
        fixedCapexM: prev?.fixedCapexM ?? ev.capexM,
      }
      if (prev) {
        facilities = facilities.map((f) =>
          f.nodeId === ev.nodeId ? nextFac : f,
        )
      } else {
        facilities = [...facilities, nextFac]
      }
      facMap.set(ev.nodeId, nextFac)
    } else if (ev.kind === 'close') {
      const node = nodeMap.get(ev.nodeId)
      if (node) {
        const closed: NetworkNode = {
          ...node,
          capacity: formatCapacity(0, node.kind),
        }
        nodeMap.set(node.id, closed)
        nodes = nodes.map((n) => (n.id === node.id ? closed : n))
      }
      const prev = facMap.get(ev.nodeId)
      if (prev) {
        const nextFac: FacilityConstraint = {
          ...prev,
          status: 'closed',
          capacityMin: 0,
          capacityMax: 0,
        }
        facilities = facilities.map((f) =>
          f.nodeId === ev.nodeId ? nextFac : f,
        )
        facMap.set(ev.nodeId, nextFac)
      }
    } else if (ev.kind === 'expand') {
      const node = nodeMap.get(ev.nodeId)
      if (node) {
        const vol = parseVolume(node.capacity) + ev.capacityDelta
        const expanded: NetworkNode = {
          ...node,
          capacity: formatCapacity(Math.max(0, vol), node.kind),
        }
        nodeMap.set(node.id, expanded)
        nodes = nodes.map((n) => (n.id === node.id ? expanded : n))
        const prev = facMap.get(ev.nodeId)
        if (prev) {
          const nextFac: FacilityConstraint = {
            ...prev,
            status: 'open',
            capacityMin: Math.round(Math.max(0, vol) * 0.6),
            capacityMax: Math.round(Math.max(0, vol) * 1.25),
            fixedCapexM: prev.fixedCapexM + Math.max(0, ev.capexM),
          }
          facilities = facilities.map((f) =>
            f.nodeId === ev.nodeId ? nextFac : f,
          )
          facMap.set(ev.nodeId, nextFac)
        }
      }
    }
  }

  const geocoded = nodes.filter((n) => n.lat != null && n.lng != null).length
  const issues = [
    ...network.validation.issues.filter(
      (i) => !i.message.toLowerCase().includes('roadmap'),
    ),
    {
      level: 'info' as const,
      message: `Roadmap Y${y}: ${appliedEvents.length} CapEx event(s) applied (cum $${summary.cumulativeCapexM}M).`,
    },
  ]
  const validation = buildValidation(
    nodes,
    network.lanes,
    network.demandVolume,
    issues,
    geocoded,
    nodes.length,
  )
  const nextNetwork: UploadedNetwork = {
    ...network,
    nodes,
    validation,
  }
  const nextConstraints: NetworkConstraints = {
    ...constraints,
    facilities,
    capexBudgetM: Math.max(
      constraints.capexBudgetM,
      Math.ceil(summary.cumulativeCapexM + 5),
    ),
    maxFacilities: Math.max(constraints.maxFacilities, summary.openFacilityCount),
  }

  const yl = summary.yearLabel
  const draftScenario: Scenario = {
    id: uid(`roadmap-y${y}`),
    name:
      scenarioName?.trim() ||
      `Roadmap ${summary.label} (${yl})`,
    tag: 'Roadmap',
    baseId: 'baseline',
    kpis: kpisForSlice(summary, referenceKpis),
    optimizeMeta: {
      heuristic: 'capex-roadmap',
      openedIds: appliedEvents
        .filter((e) => e.kind === 'open')
        .map((e) => e.nodeId),
      closedIds: appliedEvents
        .filter((e) => e.kind === 'close')
        .map((e) => e.nodeId),
      servicePct: parseFloat(
        String(kpisForSlice(summary, referenceKpis).service.value).replace(
          /[^0-9.]/g,
          '',
        ),
      ),
      capexUsedM: summary.cumulativeCapexM,
    },
  }

  return {
    network: nextNetwork,
    constraints: nextConstraints,
    draftScenario,
    summary,
    appliedEvents,
  }
}

/** Markdown block for Decision Brief notes / export. */
export function formatRoadmapBriefSection(
  state: CapexRoadmapState,
  network: UploadedNetwork,
): string {
  const summaries = roadmapYearSummaries(state, network)
  const lines: string[] = [
    '## CapEx roadmap (multi-year)',
    '',
    `Base year: ${state.baseYearLabel} · Horizon: Y0–Y${state.yearCount - 1}`,
    '',
    '| Year | Label | Events | CapEx $M | Cum CapEx | Cap Δ | Cum capacity | Open |',
    '|------|-------|--------|----------|-----------|-------|--------------|------|',
  ]
  for (const s of summaries) {
    lines.push(
      `| ${s.label} | ${s.yearLabel} | ${s.eventsThisYear.length} | ${s.capexThisYearM} | ${s.cumulativeCapexM} | ${s.capacityDeltaThisYear >= 0 ? '+' : ''}${s.capacityDeltaThisYear} | ${s.totalCapacityUnits} | ${s.openFacilityCount} |`,
    )
  }
  lines.push('', '### Events', '')
  const sorted = [...state.events].sort(
    (a, b) => a.year - b.year || a.name.localeCompare(b.name),
  )
  for (const e of sorted) {
    lines.push(
      `- **Y${e.year} · ${e.kind}** — ${e.name}: $${e.capexM}M CapEx, capacity ${e.capacityDelta >= 0 ? '+' : ''}${e.capacityDelta}${e.notes ? ` (${e.notes})` : ''}`,
    )
  }
  const last = summaries[summaries.length - 1]
  if (last) {
    lines.push(
      '',
      `**Cumulative CapEx through Y${state.yearCount - 1}:** $${last.cumulativeCapexM}M · **Capacity:** ${last.totalCapacityUnits} units across ${last.openFacilityCount} open facilities.`,
      '',
    )
  }
  return lines.join('\n')
}

export function eventKindLabel(kind: CapexEventKind): string {
  switch (kind) {
    case 'open':
      return 'Open'
    case 'close':
      return 'Close'
    case 'expand':
      return 'Expand'
  }
}
