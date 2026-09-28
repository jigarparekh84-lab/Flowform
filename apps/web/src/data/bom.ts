/**
 * Bill-of-materials / multi-echelon BOM flows.
 * Finished goods ← components/RM with qty per unit; plants produce FG from
 * inbound RM. Derive implied RM demand from FG demand + BOM; show echelon
 * Plant←Supplier / FG←RM; optional scenario that adds implied inbound lanes.
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

export type BomComponentKind = 'rm' | 'component' | 'wip'

export type BomRow = {
  id: string
  finishedGoodId: string
  finishedGoodName: string
  componentId: string
  componentName: string
  componentKind: BomComponentKind
  /** Qty of component per 1 unit of finished good. */
  qtyPerUnit: number
  /** Preferred supplier node id (inbound RM). */
  preferredSupplierId: string | null
  /** Plant that produces this FG from the component. */
  plantId: string | null
  notes?: string
}

export type FgDemandShare = {
  finishedGoodId: string
  finishedGoodName: string
  /** Share of total network demand attributed to this FG (0–100). */
  sharePct: number
}

export type BomState = {
  rows: BomRow[]
  fgShares: FgDemandShare[]
  /** Highlight BOM-driven / implied inbound lanes on Network. */
  highlightBomLanes: boolean
}

export type ImpliedRmDemand = {
  componentId: string
  componentName: string
  componentKind: BomComponentKind
  qtyNeeded: number
  preferredSupplierId: string | null
  preferredSupplierName: string | null
  sources: {
    finishedGoodId: string
    finishedGoodName: string
    fgDemand: number
    qtyPerUnit: number
    contrib: number
  }[]
}

export type BomRequirement = {
  plantId: string
  plantName: string
  finishedGoodId: string
  finishedGoodName: string
  fgDemand: number
  components: {
    componentId: string
    componentName: string
    componentKind: BomComponentKind
    qtyPerUnit: number
    qtyNeeded: number
    supplierId: string | null
    supplierName: string | null
  }[]
}

export type EchelonFlow = {
  id: string
  /** Geographic Plant←Supplier or material FG←RM. */
  echelon: 'plant←supplier' | 'fg←rm'
  fromId: string
  fromName: string
  fromKind: string
  toId: string
  toName: string
  toKind: string
  materialId: string
  materialName: string
  volume: number
  laneId: string | null
  implied: boolean
}

export type BomLanePreview = {
  existingLanes: NetworkLane[]
  newLanes: NetworkLane[]
  resultingLanes: NetworkLane[]
  flows: EchelonFlow[]
  impliedRm: ImpliedRmDemand[]
  requirements: BomRequirement[]
  kpis: { before: KpiSnapshot; after: KpiSnapshot }
  summary: string
}

export type BomInboundResult = {
  network: UploadedNetwork
  draftScenario: Scenario
  preview: BomLanePreview
}

function uid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`
}

function parseVolume(capacity: string): number {
  const m = capacity.replace(/,/g, '').match(/([\d.]+)/)
  if (!m) return 1000
  let v = parseFloat(m[1])
  if (/k/i.test(capacity)) v *= 1000
  return Math.round(v)
}

function totalDemand(network: UploadedNetwork): number {
  const sum = Object.values(network.demandVolume).reduce((s, v) => s + v, 0)
  if (sum > 0) return sum
  return network.nodes
    .filter((n) => n.kind === 'demand')
    .reduce((s, n) => s + parseVolume(n.capacity), 0)
}

function nodeName(nodes: NetworkNode[], id: string | null | undefined): string {
  if (!id) return '—'
  return nodes.find((n) => n.id === id)?.name ?? id
}

function normalizeFgShares(shares: FgDemandShare[]): FgDemandShare[] {
  const sum = shares.reduce((s, x) => s + Math.max(0, x.sharePct), 0)
  if (sum <= 0) {
    const each = Math.round((100 / Math.max(1, shares.length)) * 10) / 10
    return shares.map((s) => ({ ...s, sharePct: each }))
  }
  if (Math.abs(sum - 100) < 0.6) {
    return shares.map((s) => ({
      ...s,
      sharePct: Math.max(0, Math.round(s.sharePct * 10) / 10),
    }))
  }
  return shares.map((s) => ({
    ...s,
    sharePct: Math.round((Math.max(0, s.sharePct) / sum) * 1000) / 10,
  }))
}

/** Seed sample BOM for the NA footprint: Austin Plant ← Monterrey RM. */
export function defaultBom(network: UploadedNetwork): BomState {
  const plant =
    network.nodes.find((n) => n.kind === 'plant') ??
    network.nodes.find((n) => n.kind === 'dc')
  const supplier =
    network.nodes.find((n) => n.kind === 'supplier') ?? null
  const plantId = plant?.id ?? null
  const supplierId = supplier?.id ?? null

  const fgShares: FgDemandShare[] = [
    {
      finishedGoodId: 'fg-core',
      finishedGoodName: 'Core FG (Ambient)',
      sharePct: 55,
    },
    {
      finishedGoodId: 'fg-cold',
      finishedGoodName: 'Cold FG (Chilled)',
      sharePct: 30,
    },
    {
      finishedGoodId: 'fg-specialty',
      finishedGoodName: 'Specialty FG',
      sharePct: 15,
    },
  ]

  const rows: BomRow[] = [
    {
      id: 'bom-1',
      finishedGoodId: 'fg-core',
      finishedGoodName: 'Core FG (Ambient)',
      componentId: 'rm-polymer',
      componentName: 'Polymer resin',
      componentKind: 'rm',
      qtyPerUnit: 2.0,
      preferredSupplierId: supplierId,
      plantId,
      notes: 'Primary resin — inbound from supplier',
    },
    {
      id: 'bom-2',
      finishedGoodId: 'fg-core',
      finishedGoodName: 'Core FG (Ambient)',
      componentId: 'comp-carton',
      componentName: 'Carton pack',
      componentKind: 'component',
      qtyPerUnit: 1.0,
      preferredSupplierId: supplierId,
      plantId,
      notes: 'Corrugate / secondary pack',
    },
    {
      id: 'bom-3',
      finishedGoodId: 'fg-cold',
      finishedGoodName: 'Cold FG (Chilled)',
      componentId: 'rm-chill-base',
      componentName: 'Chill base',
      componentKind: 'rm',
      qtyPerUnit: 1.5,
      preferredSupplierId: supplierId,
      plantId,
      notes: 'Cold-chain feedstock',
    },
    {
      id: 'bom-4',
      finishedGoodId: 'fg-cold',
      finishedGoodName: 'Cold FG (Chilled)',
      componentId: 'comp-insul',
      componentName: 'Insulated liner',
      componentKind: 'component',
      qtyPerUnit: 1.0,
      preferredSupplierId: supplierId,
      plantId,
    },
    {
      id: 'bom-5',
      finishedGoodId: 'fg-specialty',
      finishedGoodName: 'Specialty FG',
      componentId: 'rm-additive',
      componentName: 'Specialty additive',
      componentKind: 'rm',
      qtyPerUnit: 0.4,
      preferredSupplierId: supplierId,
      plantId,
      notes: 'Low-volume / high-cost RM',
    },
    {
      id: 'bom-6',
      finishedGoodId: 'fg-specialty',
      finishedGoodName: 'Specialty FG',
      componentId: 'comp-drum',
      componentName: 'Drum / tote',
      componentKind: 'component',
      qtyPerUnit: 1.0,
      preferredSupplierId: supplierId,
      plantId,
    },
  ]

  return {
    rows,
    fgShares: normalizeFgShares(fgShares),
    highlightBomLanes: true,
  }
}

/** Merge prior BOM onto a (possibly new) network; rebind plant/supplier ids. */
export function mergeBom(
  prev: BomState | null | undefined,
  network: UploadedNetwork,
): BomState {
  const fresh = defaultBom(network)
  if (!prev || !prev.rows?.length) return fresh

  const plantIds = new Set(
    network.nodes.filter((n) => n.kind === 'plant').map((n) => n.id),
  )
  const supplierIds = new Set(
    network.nodes.filter((n) => n.kind === 'supplier').map((n) => n.id),
  )
  const fallbackPlant = fresh.rows[0]?.plantId ?? null
  const fallbackSupplier = fresh.rows[0]?.preferredSupplierId ?? null

  const rows = prev.rows.map((r) => ({
    ...r,
    qtyPerUnit: Math.max(0, r.qtyPerUnit),
    plantId:
      r.plantId && plantIds.has(r.plantId) ? r.plantId : fallbackPlant,
    preferredSupplierId:
      r.preferredSupplierId && supplierIds.has(r.preferredSupplierId)
        ? r.preferredSupplierId
        : fallbackSupplier,
  }))

  const fgShares =
    prev.fgShares?.length > 0
      ? normalizeFgShares(prev.fgShares)
      : fresh.fgShares

  return {
    rows,
    fgShares,
    highlightBomLanes: prev.highlightBomLanes ?? true,
  }
}

export function fgDemandFor(
  state: BomState,
  network: UploadedNetwork,
  finishedGoodId: string,
): number {
  const total = totalDemand(network)
  const share = state.fgShares.find((s) => s.finishedGoodId === finishedGoodId)
  const pct = share?.sharePct ?? 0
  return Math.round(total * (pct / 100))
}

/** Implied RM / component demand from FG demand × BOM qty. */
export function deriveImpliedRmDemand(
  state: BomState,
  network: UploadedNetwork,
): ImpliedRmDemand[] {
  const byComp = new Map<string, ImpliedRmDemand>()

  for (const row of state.rows) {
    const fgDemand = fgDemandFor(state, network, row.finishedGoodId)
    const contrib = Math.round(fgDemand * row.qtyPerUnit * 10) / 10
    let entry = byComp.get(row.componentId)
    if (!entry) {
      entry = {
        componentId: row.componentId,
        componentName: row.componentName,
        componentKind: row.componentKind,
        qtyNeeded: 0,
        preferredSupplierId: row.preferredSupplierId,
        preferredSupplierName: row.preferredSupplierId
          ? nodeName(network.nodes, row.preferredSupplierId)
          : null,
        sources: [],
      }
      byComp.set(row.componentId, entry)
    }
    entry.qtyNeeded = Math.round((entry.qtyNeeded + contrib) * 10) / 10
    if (!entry.preferredSupplierId && row.preferredSupplierId) {
      entry.preferredSupplierId = row.preferredSupplierId
      entry.preferredSupplierName = nodeName(
        network.nodes,
        row.preferredSupplierId,
      )
    }
    entry.sources.push({
      finishedGoodId: row.finishedGoodId,
      finishedGoodName: row.finishedGoodName,
      fgDemand,
      qtyPerUnit: row.qtyPerUnit,
      contrib,
    })
  }

  return [...byComp.values()].sort((a, b) => b.qtyNeeded - a.qtyNeeded)
}

/** Plant-level FG production requirements + inbound components. */
export function deriveBomRequirements(
  state: BomState,
  network: UploadedNetwork,
): BomRequirement[] {
  const key = (plantId: string, fgId: string) => `${plantId}::${fgId}`
  const map = new Map<string, BomRequirement>()

  for (const row of state.rows) {
    const plantId = row.plantId
    if (!plantId) continue
    const k = key(plantId, row.finishedGoodId)
    let req = map.get(k)
    if (!req) {
      req = {
        plantId,
        plantName: nodeName(network.nodes, plantId),
        finishedGoodId: row.finishedGoodId,
        finishedGoodName: row.finishedGoodName,
        fgDemand: fgDemandFor(state, network, row.finishedGoodId),
        components: [],
      }
      map.set(k, req)
    }
    const qtyNeeded =
      Math.round(req.fgDemand * row.qtyPerUnit * 10) / 10
    req.components.push({
      componentId: row.componentId,
      componentName: row.componentName,
      componentKind: row.componentKind,
      qtyPerUnit: row.qtyPerUnit,
      qtyNeeded,
      supplierId: row.preferredSupplierId,
      supplierName: row.preferredSupplierId
        ? nodeName(network.nodes, row.preferredSupplierId)
        : null,
    })
  }

  return [...map.values()].sort((a, b) =>
    a.plantName.localeCompare(b.plantName),
  )
}

function findLane(
  lanes: NetworkLane[],
  fromId: string,
  toId: string,
): NetworkLane | undefined {
  return lanes.find((l) => l.from === fromId && l.to === toId)
}

/** Echelon flows: Plant←Supplier (geo) and FG←RM (material). */
export function deriveEchelonFlows(
  state: BomState,
  network: UploadedNetwork,
): EchelonFlow[] {
  const flows: EchelonFlow[] = []
  const implied = deriveImpliedRmDemand(state, network)
  const byComp = new Map(implied.map((i) => [i.componentId, i]))

  // Aggregate supplier→plant volumes from BOM rows
  type PairKey = string
  const pairVol = new Map<
    PairKey,
    {
      supplierId: string
      plantId: string
      materialId: string
      materialName: string
      volume: number
    }
  >()

  for (const row of state.rows) {
    if (!row.preferredSupplierId || !row.plantId) continue
    const need = byComp.get(row.componentId)
    // Allocate full component need to this plant (single-plant sample)
    const vol = need?.qtyNeeded ?? 0
    const k = `${row.preferredSupplierId}|${row.plantId}|${row.componentId}`
    const prev = pairVol.get(k)
    if (prev) {
      // already counted this component for the pair
      continue
    }
    pairVol.set(k, {
      supplierId: row.preferredSupplierId,
      plantId: row.plantId,
      materialId: row.componentId,
      materialName: row.componentName,
      volume: vol,
    })
  }

  for (const p of pairVol.values()) {
    const lane = findLane(network.lanes, p.supplierId, p.plantId)
    flows.push({
      id: `ech-sup-${p.supplierId}-${p.plantId}-${p.materialId}`,
      echelon: 'plant←supplier',
      fromId: p.supplierId,
      fromName: nodeName(network.nodes, p.supplierId),
      fromKind: 'supplier',
      toId: p.plantId,
      toName: nodeName(network.nodes, p.plantId),
      toKind: 'plant',
      materialId: p.materialId,
      materialName: p.materialName,
      volume: p.volume,
      laneId: lane?.id ?? null,
      implied: !lane,
    })
  }

  // Material FG←RM edges (not geographic)
  for (const row of state.rows) {
    const fgDemand = fgDemandFor(state, network, row.finishedGoodId)
    const vol = Math.round(fgDemand * row.qtyPerUnit * 10) / 10
    flows.push({
      id: `ech-mat-${row.id}`,
      echelon: 'fg←rm',
      fromId: row.componentId,
      fromName: row.componentName,
      fromKind: row.componentKind,
      toId: row.finishedGoodId,
      toName: row.finishedGoodName,
      toKind: 'fg',
      materialId: row.componentId,
      materialName: row.componentName,
      volume: vol,
      laneId: null,
      implied: false,
    })
  }

  return flows
}

function parseNum(value: string): number {
  const m = value.replace(/,/g, '').match(/([\d.]+)/)
  return m ? parseFloat(m[1]) : 0
}

function estimateInboundKpis(
  before: KpiSnapshot,
  newLanes: NetworkLane[],
  nodes: NetworkNode[],
  addedVolume: number,
): KpiSnapshot {
  const costM = parseNum(before.cost.value)
  const co2Kt = parseNum(before.co2.value)
  const service = parseNum(before.service.value)

  let extraCost = 0
  let extraCo2 = 0
  for (const lane of newLanes) {
    const a = nodes.find((n) => n.id === lane.from)
    const b = nodes.find((n) => n.id === lane.to)
    const miles =
      a && b ? haversineMiles(nodeLatLng(a), nodeLatLng(b)) : 500
    // Rough: $0.001M per unit·$/u on new inbound, scaled lightly
    extraCost += (addedVolume * lane.costPerUnit) / 1_000_000
    extraCo2 += (addedVolume * lane.co2Kg * (miles / 500)) / 1_000_000
  }
  // Soft service bump from secured inbound
  const serviceBump = newLanes.length > 0 ? 0.4 : 0
  const nextCost = Math.round((costM + extraCost) * 10) / 10
  const nextCo2 = Math.round((co2Kt + extraCo2) * 10) / 10
  const nextService = Math.min(99.5, Math.round((service + serviceBump) * 10) / 10)
  const costDelta = nextCost - costM
  const co2Delta = nextCo2 - co2Kt
  const svcDelta = nextService - service

  return {
    cost: {
      value: `$${nextCost.toFixed(1)}M`,
      delta: `${costDelta >= 0 ? '+' : '−'}${Math.abs(costDelta).toFixed(1)}%`,
      better: costDelta <= 0,
    },
    service: {
      value: `${nextService.toFixed(1)}%`,
      delta: `${svcDelta >= 0 ? '+' : '−'}${Math.abs(svcDelta).toFixed(1)}pp`,
      better: svcDelta >= 0,
    },
    capex: {
      value: before.capex.value,
      delta: before.capex.delta,
      better: before.capex.better,
    },
    co2: {
      value: `${nextCo2.toFixed(1)} kt`,
      delta: `${co2Delta >= 0 ? '+' : '−'}${Math.abs(co2Delta).toFixed(1)}%`,
      better: co2Delta <= 0,
    },
    risk: {
      value: newLanes.length > 0 ? 'Low' : before.risk.value,
      delta: newLanes.length > 0 ? '↓' : before.risk.delta,
      better: true,
    },
  }
}

/** Preview implied inbound Supplier→Plant lanes from BOM gaps. */
export function previewBomInboundLanes(
  state: BomState,
  network: UploadedNetwork,
  referenceKpis: KpiSnapshot = BASELINE_KPIS,
): BomLanePreview {
  const flows = deriveEchelonFlows(state, network)
  const impliedRm = deriveImpliedRmDemand(state, network)
  const requirements = deriveBomRequirements(state, network)

  const plantSupplierFlows = flows.filter((f) => f.echelon === 'plant←supplier')
  const existingLanes: NetworkLane[] = []
  const newLanes: NetworkLane[] = []
  const seenPair = new Set<string>()

  for (const f of plantSupplierFlows) {
    const pair = `${f.fromId}|${f.toId}`
    if (seenPair.has(pair)) continue
    seenPair.add(pair)
    const existing = findLane(network.lanes, f.fromId, f.toId)
    if (existing) {
      existingLanes.push(existing)
      continue
    }
    const a = network.nodes.find((n) => n.id === f.fromId)
    const b = network.nodes.find((n) => n.id === f.toId)
    const miles =
      a && b ? Math.round(haversineMiles(nodeLatLng(a), nodeLatLng(b))) : 600
    newLanes.push({
      id: `bom-in-${f.fromId}-${f.toId}`,
      from: f.fromId,
      to: f.toId,
      mode: 'Truck',
      costPerUnit: Math.round((0.0022 * miles + 0.35) * 100) / 100,
      leadDays: Math.max(2, Math.round(miles / 350)),
      co2Kg: Math.round(miles * 0.03),
    })
  }

  const resultingLanes = [...network.lanes, ...newLanes]
  const addedVolume = plantSupplierFlows
    .filter((f) => f.implied)
    .reduce((s, f) => s + f.volume, 0)
  const after = estimateInboundKpis(
    referenceKpis,
    newLanes,
    network.nodes,
    addedVolume,
  )

  const summary = `${state.rows.length} BOM rows · ${impliedRm.length} components · ${plantSupplierFlows.length} Plant←Supplier flows · ${newLanes.length} implied inbound lane${newLanes.length === 1 ? '' : 's'} to add`

  return {
    existingLanes,
    newLanes,
    resultingLanes,
    flows,
    impliedRm,
    requirements,
    kpis: { before: referenceKpis, after },
    summary,
  }
}

/** Apply implied inbound lanes + draft BOM scenario. */
export function applyBomInboundLanes(
  state: BomState,
  network: UploadedNetwork,
  referenceKpis: KpiSnapshot = BASELINE_KPIS,
  scenarioName?: string,
): BomInboundResult {
  const preview = previewBomInboundLanes(state, network, referenceKpis)
  const issues = [...network.validation.issues]
  if (preview.newLanes.length === 0) {
    issues.push({
      level: 'info',
      message: 'BOM inbound: all Plant←Supplier pairs already have lanes.',
    })
  } else {
    issues.push({
      level: 'info',
      message: `BOM inbound: added ${preview.newLanes.length} supplier→plant lane(s).`,
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
        ? `${network.fileNames.lanes}+bom-inbound`
        : 'bom-inbound-lanes',
    },
    validation,
  }

  const name =
    scenarioName?.trim() ||
    `BOM inbound (${preview.newLanes.length} lane${preview.newLanes.length === 1 ? '' : 's'})`

  const draftScenario: Scenario = {
    id: `bom-in-${Date.now().toString(36)}`,
    name,
    tag: 'Draft',
    baseId: 'baseline',
    kpis: preview.kpis.after,
    optimizeMeta: {
      heuristic: 'bom-inbound-v1',
      openedIds: [
        ...new Set(
          preview.flows
            .filter((f) => f.echelon === 'plant←supplier')
            .map((f) => f.toId),
        ),
      ],
      closedIds: [],
      servicePct: parseNum(preview.kpis.after.service.value) || 94,
      capexUsedM: 0,
      flows: preview.flows
        .filter((f) => f.echelon === 'plant←supplier')
        .map((f) => ({
          from: f.fromId,
          to: f.toId,
          volume: f.volume,
        })),
    },
  }

  return { network: next, draftScenario, preview }
}

export function updateBomRow(
  state: BomState,
  rowId: string,
  patch: Partial<Omit<BomRow, 'id'>>,
): BomState {
  return {
    ...state,
    rows: state.rows.map((r) => (r.id === rowId ? { ...r, ...patch } : r)),
  }
}

export function addBomRow(
  state: BomState,
  partial?: Partial<BomRow>,
): BomState {
  const fg = state.fgShares[0]
  const template = state.rows[0]
  const row: BomRow = {
    id: uid('bom'),
    finishedGoodId: partial?.finishedGoodId ?? fg?.finishedGoodId ?? 'fg-new',
    finishedGoodName:
      partial?.finishedGoodName ?? fg?.finishedGoodName ?? 'New FG',
    componentId: partial?.componentId ?? `rm-${uid('c')}`,
    componentName: partial?.componentName ?? 'New component',
    componentKind: partial?.componentKind ?? 'rm',
    qtyPerUnit: partial?.qtyPerUnit ?? 1,
    preferredSupplierId:
      partial?.preferredSupplierId !== undefined
        ? partial.preferredSupplierId
        : (template?.preferredSupplierId ?? null),
    plantId:
      partial?.plantId !== undefined
        ? partial.plantId
        : (template?.plantId ?? null),
    notes: partial?.notes,
  }
  return { ...state, rows: [...state.rows, row] }
}

export function removeBomRow(state: BomState, rowId: string): BomState {
  return { ...state, rows: state.rows.filter((r) => r.id !== rowId) }
}

export function updateFgShare(
  state: BomState,
  finishedGoodId: string,
  sharePct: number,
): BomState {
  const fgShares = normalizeFgShares(
    state.fgShares.map((s) =>
      s.finishedGoodId === finishedGoodId
        ? { ...s, sharePct: Math.max(0, sharePct) }
        : s,
    ),
  )
  return { ...state, fgShares }
}

export function setBomHighlight(state: BomState, on: boolean): BomState {
  return { ...state, highlightBomLanes: on }
}

/** Lane ids that participate in BOM Plant←Supplier flows (existing or matching). */
export function bomDrivenLaneIds(
  state: BomState,
  network: UploadedNetwork,
): Set<string> {
  const ids = new Set<string>()
  if (!state.highlightBomLanes) return ids
  for (const f of deriveEchelonFlows(state, network)) {
    if (f.echelon === 'plant←supplier' && f.laneId) ids.add(f.laneId)
  }
  // Also mark any lane whose endpoints match a BOM supplier→plant pair
  for (const row of state.rows) {
    if (!row.preferredSupplierId || !row.plantId) continue
    const lane = findLane(network.lanes, row.preferredSupplierId, row.plantId)
    if (lane) ids.add(lane.id)
  }
  return ids
}

export function componentKindLabel(kind: BomComponentKind): string {
  switch (kind) {
    case 'rm':
      return 'RM'
    case 'component':
      return 'Comp'
    case 'wip':
      return 'WIP'
  }
}

export function bomRollup(state: BomState, network: UploadedNetwork) {
  const implied = deriveImpliedRmDemand(state, network)
  const flows = deriveEchelonFlows(state, network)
  const plantFlows = flows.filter((f) => f.echelon === 'plant←supplier')
  const matFlows = flows.filter((f) => f.echelon === 'fg←rm')
  const totalRm = implied.reduce((s, i) => s + i.qtyNeeded, 0)
  const impliedLanes = plantFlows.filter((f) => f.implied).length
  const coveredLanes = plantFlows.filter((f) => !f.implied).length
  return {
    bomRows: state.rows.length,
    fgCount: state.fgShares.length,
    componentCount: implied.length,
    totalRmQty: Math.round(totalRm),
    plantSupplierFlows: plantFlows.length,
    materialFlows: matFlows.length,
    impliedLaneGaps: impliedLanes,
    coveredLanePairs: coveredLanes,
  }
}
