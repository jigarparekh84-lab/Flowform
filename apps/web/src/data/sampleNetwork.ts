export type NodeKind = 'plant' | 'dc' | 'demand' | 'supplier' | 'candidate'

export type NetworkNode = {
  id: string
  name: string
  kind: NodeKind
  region: string
  capacity: string
  x: number
  y: number
  /** Optional WGS84 — preferred for MapLibre; canvas x/y always present. */
  lat?: number
  lng?: number
}

export type NetworkLane = {
  id: string
  from: string
  to: string
  mode: string
  costPerUnit: number
  leadDays: number
  co2Kg: number
  /** Optional lane throughput capacity (units); used by enterprise pack / MIP. */
  capacityUnits?: number
}

export type KpiCell = { value: string; delta: string; better: boolean }

export type KpiSnapshot = {
  cost: KpiCell
  service: KpiCell
  capex: KpiCell
  co2: KpiCell
  risk: KpiCell
  /** Network inventory $ (safety-stock holding) from Inventory policy. */
  inventory?: KpiCell
  /** Safety-stock units rollup. */
  invUnits?: KpiCell
}

export type OptimizeObjectiveBreakdown = {
  totalM: number
  transportM: number
  fixedCapexM: number
  fixedOpexM: number
  uncoveredPenaltyM: number
  currency?: string
}

export type OptimizeOpenFacility = {
  id: string
  name: string
  kind?: string
  fixedCapexM: number
  fixedOpexM: number
  throughput: number
  capacityMax: number
  utilizationPct: number
}

export type OptimizeShadowPrice = {
  facilityId: string
  constraint: string
  shadowPrice: number
  unit?: string
  binding?: boolean
  slack?: number
  method?: string
}

export type OptimizeMeta = {
  /** Client heuristic or API MIP solver id (e.g. pulp-highs, pulp-cbc). */
  heuristic: 'v1-greedy' | 'pulp-highs' | 'pulp-cbc' | string
  openedIds: string[]
  closedIds: string[]
  servicePct: number
  capexUsedM: number
  /** Assignment / multi-echelon flows from MIP when available. */
  flows?: {
    from: string
    to: string
    volume: number
    miles?: number
    echelon?: string
    unitCost?: number
    transportCostM?: number
    productId?: string
    productLabel?: string
  }[]
  /** Objective cost stack from fixed-charge MIP. */
  objectiveBreakdown?: OptimizeObjectiveBreakdown
  openFacilities?: OptimizeOpenFacility[]
  shadowPrices?: OptimizeShadowPrice[]
  model?: string
  /** Solver status string (Optimal, …). */
  status?: string
  /** Wall seconds for MIP solve (API). */
  solveSeconds?: number
  /** ISO timestamp when this optimize finished. */
  solvedAt?: string
  commodityMode?: string
  hardServiceConstraints?: boolean
  productBreakdown?: {
    productId: string
    label: string
    demand: number
    served: number
    uncovered: number
    servicePct: number
    transportM: number
  }[]
  infeasibilityReport?: {
    status: string
    summary: string
    hints: {
      code: string
      severity?: string
      message: string
      entities?: string[]
      hint?: string
    }[]
    metrics?: Record<string, number | boolean | string>
    method?: string
    note?: string
  }
  /** Positions for map-diff when nodes are not in the sample set. */
  marks?: { id: string; kind: 'open' | 'close'; label: string; x: number; y: number }[]
}

/** Stored Monte Carlo DES-lite result on a scenario. */
export type DesLiteResult = {
  runAt: string
  trials: number
  fillRatePct: number
  lateDemandPct: number
  meanLeadDays: number
  p95LeadDays: number
  demandNoisePct: number
  leadNoisePct: number
  serviceTargetDays: number
  seed: number
  fillRateBins: { label: string; count: number }[]
}

export type Scenario = {
  id: string
  name: string
  tag: string
  kpis: KpiSnapshot
  /** Baseline scenario this branches from (omit for root baseline). */
  baseId?: string
  /** Promoted delta items composed into this scenario. */
  deltaIds?: string[]
  /** Present when produced by Run optimize (heuristic v1). */
  optimizeMeta?: OptimizeMeta
  /** Latest DES-lite Monte Carlo service sim for this scenario. */
  desLite?: DesLiteResult
  /** Cost-driver tornado + Monte Carlo sensitivity result. */
  costSensitivity?: import('./costSensitivity').CostSensitivityResult
  /** Latest resilience / SPOF score for this scenario. */
  resilience?: ScenarioResilience
  /** Latest inventory rollup attached to KPIs. */
  inventoryRollup?: InventoryRollupSummary
}

/** Compact inventory rollup stored on a scenario. */
export type InventoryRollupSummary = {
  formula: 'simple' | 'ascm-combined'
  totalUnits: number
  totalDollars: number
  totalDollarsM: number
  appliedAt: string
}

/** Compact resilience result stored on a scenario. */
export type ScenarioResilience = {
  runAt: string
  thresholdPct: number
  baselineServicePct: number
  score: number
  criticalNodeIds: string[]
  criticalNames: string[]
  facilityCount: number
}

export type CandidateSite = {
  id: string
  name: string
  region: string
  x: number
  y: number
  score: number
  serviceMiles: number
}

export type GreenfieldParams = {
  demandSetId: string
  siteCount: number
  serviceMiles: number
  euclidean: boolean
  lockExisting: boolean
}

export type DeltaItem = {
  id: string
  name: string
  kind: 'candidates'
  createdAt: string
  params: GreenfieldParams
  candidates: CandidateSite[]
}

export type FacilityStatus = 'open' | 'closed' | 'candidate'

export type FacilityConstraint = {
  nodeId: string
  status: FacilityStatus
  capacityMin: number
  capacityMax: number
  /** CapEx $M to open if candidate / currently closed. */
  fixedCapexM: number
  /** Annualized fixed OpEx $M while open (optional; API defaults by kind). */
  fixedOpexM?: number
  /** Product / group ids this facility may handle (omit = all). */
  capableProductIds?: string[]
  capacityByProduct?: Record<string, number>
}

export type NetworkConstraints = {
  serviceTargetPct: number
  serviceRadiusMiles: number
  capexBudgetM: number
  maxFacilities: number
  /** When true, MIP forbids uncovered demand (may return Infeasible + diagnostics). */
  hardServiceConstraints?: boolean
  /** Optional max customer→server lead-time (days) in addition to radius. */
  maxLeadTimeDays?: number
  aggregateProductsByGroup?: boolean | 'auto' | 'always' | 'never'
  maxProductCommodities?: number
  facilities: FacilityConstraint[]
}


export type AssumptionItem = {
  id: string
  label: string
  checked: boolean
}

export type BriefState = {
  recommendedScenarioId: string | null
  comparedIds: string[]
  assumptions: AssumptionItem[]
  notes: string
  sentToHandoffAt: string | null
}

export type OptimizeRunStatus =
  | { phase: 'idle' }
  | { phase: 'running'; progress: number; message: string }
  | {
      phase: 'done'
      scenarioId: string
      message: string
      log: string[]
      solveSeconds?: number
      status?: string
      model?: string
      solver?: string
      infeasibilityReport?: OptimizeMeta['infeasibilityReport']
      productBreakdown?: OptimizeMeta['productBreakdown']
    }
  | {
      phase: 'error'
      message: string
      infeasibilityReport?: OptimizeMeta['infeasibilityReport']
      log?: string[]
    }

export const PROJECT_NAME = 'NA Footprint 2027'

export const HORIZON_OPTIONS = ['FY26', 'FY27', 'FY28'] as const

export const DEMAND_SETS = [
  { id: 'na-core', label: 'NA Core demand (sample)' },
  { id: 'east-heavy', label: 'East-heavy growth (stub)' },
  { id: 'west-coast', label: 'West Coast push (stub)' },
] as const

export const LAYERS = [
  { id: 'plants', label: 'Plants', defaultOn: true },
  { id: 'dcs', label: 'DCs', defaultOn: true },
  { id: 'demand', label: 'Demand', defaultOn: true },
  { id: 'suppliers', label: 'Suppliers', defaultOn: false },
  { id: 'lanes', label: 'Lanes', defaultOn: true },
  { id: 'service', label: 'Service radii', defaultOn: false },
  { id: 'candidates', label: 'Candidates', defaultOn: true },
  { id: 'utilization', label: 'Capacity heat', defaultOn: false },
  { id: 'territory', label: 'Territory', defaultOn: false },
] as const

export const NODES: NetworkNode[] = [
  { id: 'n1', name: 'Austin Plant', kind: 'plant', region: 'South', capacity: '42k u/wk', x: 28, y: 62, lat: 30.27, lng: -97.74 },
  { id: 'n2', name: 'Columbus DC', kind: 'dc', region: 'Midwest', capacity: '18k pallet', x: 52, y: 38, lat: 39.96, lng: -82.99 },
  { id: 'n3', name: 'Atlanta DC', kind: 'dc', region: 'Southeast', capacity: '14k pallet', x: 62, y: 58, lat: 33.75, lng: -84.39 },
  { id: 'n4', name: 'Chicago Hub', kind: 'demand', region: 'Midwest', capacity: '9.2k u/wk', x: 48, y: 28, lat: 41.88, lng: -87.63 },
  { id: 'n5', name: 'Dallas Metro', kind: 'demand', region: 'South', capacity: '7.1k u/wk', x: 36, y: 55, lat: 32.78, lng: -96.80 },
  { id: 'n6', name: 'NYC Corridor', kind: 'demand', region: 'Northeast', capacity: '11.4k u/wk', x: 78, y: 32, lat: 40.71, lng: -74.01 },
  { id: 'n7', name: 'Monterrey Sup', kind: 'supplier', region: 'MX', capacity: '22k u/wk', x: 22, y: 72, lat: 25.67, lng: -100.31 },
  { id: 'n8', name: 'Reno DC', kind: 'dc', region: 'West', capacity: '12k pallet', x: 14, y: 36, lat: 39.53, lng: -119.81 },
]

export const LANES: NetworkLane[] = [
  { id: 'l1', from: 'n7', to: 'n1', mode: 'Truck', costPerUnit: 1.12, leadDays: 3, co2Kg: 18 },
  { id: 'l2', from: 'n1', to: 'n2', mode: 'Rail', costPerUnit: 0.64, leadDays: 5, co2Kg: 9 },
  { id: 'l3', from: 'n1', to: 'n3', mode: 'Truck', costPerUnit: 0.88, leadDays: 2, co2Kg: 14 },
  { id: 'l4', from: 'n2', to: 'n4', mode: 'Truck', costPerUnit: 0.41, leadDays: 1, co2Kg: 6 },
  { id: 'l5', from: 'n3', to: 'n6', mode: 'Intermodal', costPerUnit: 0.97, leadDays: 4, co2Kg: 11 },
  { id: 'l6', from: 'n1', to: 'n5', mode: 'Truck', costPerUnit: 0.35, leadDays: 1, co2Kg: 5 },
  { id: 'l7', from: 'n8', to: 'n2', mode: 'Rail', costPerUnit: 0.72, leadDays: 6, co2Kg: 8 },
  { id: 'l8', from: 'n3', to: 'n5', mode: 'Truck', costPerUnit: 0.79, leadDays: 2, co2Kg: 12 },
]

export const BASELINE_KPIS: KpiSnapshot = {
  cost: { value: '$48.2M', delta: '—', better: true },
  service: { value: '94.1%', delta: '—', better: true },
  capex: { value: '$0', delta: '—', better: true },
  co2: { value: '12.4 kt', delta: '—', better: true },
  risk: { value: 'Med', delta: '—', better: true },
}

export const INITIAL_SCENARIOS: Scenario[] = [
  {
    id: 'baseline',
    name: 'Baseline',
    tag: 'Live',
    kpis: BASELINE_KPIS,
  },
  {
    id: 'east-dc',
    name: 'East Coast DC',
    tag: 'What-if',
    baseId: 'baseline',
    kpis: {
      cost: { value: '$46.1M', delta: '−4.4%', better: true },
      service: { value: '96.8%', delta: '+2.7pp', better: true },
      capex: { value: '$18M', delta: '+$18M', better: false },
      co2: { value: '11.1 kt', delta: '−10%', better: true },
      risk: { value: 'Low', delta: '↓', better: true },
    },
  },
  {
    id: 'nearshore',
    name: 'Nearshore MX',
    tag: 'What-if',
    baseId: 'baseline',
    kpis: {
      cost: { value: '$44.9M', delta: '−6.8%', better: true },
      service: { value: '92.4%', delta: '−1.7pp', better: false },
      capex: { value: '$9M', delta: '+$9M', better: false },
      co2: { value: '10.2 kt', delta: '−18%', better: true },
      risk: { value: 'Med', delta: '→', better: true },
    },
  },
  {
    id: 'lean-lanes',
    name: 'Lean Lanes',
    tag: 'Sketch',
    baseId: 'baseline',
    kpis: {
      cost: { value: '$47.0M', delta: '−2.5%', better: true },
      service: { value: '93.0%', delta: '−1.1pp', better: false },
      capex: { value: '$1.2M', delta: '+$1.2M', better: false },
      co2: { value: '11.8 kt', delta: '−5%', better: true },
      risk: { value: 'High', delta: '↑', better: false },
    },
  },
]

/** @deprecated Prefer INITIAL_SCENARIOS — kept as alias for gradual migration. */
export const SCENARIOS = INITIAL_SCENARIOS

export function nodeById(id: string): NetworkNode | undefined {
  return NODES.find((n) => n.id === id)
}

export function kindLabel(kind: NodeKind): string {
  switch (kind) {
    case 'plant':
      return 'Plant'
    case 'dc':
      return 'DC'
    case 'demand':
      return 'Demand'
    case 'supplier':
      return 'Supplier'
    case 'candidate':
      return 'Candidate'
  }
}

/** Rough region label from map x/y (0–100). */
export function regionFromXY(x: number, y: number): string {
  if (x < 30 && y > 55) return 'MX / South'
  if (x < 28) return 'West'
  if (x > 68) return 'Northeast'
  if (y < 35) return 'Midwest'
  if (y > 55) return 'South'
  return 'Southeast'
}

/**
 * Mock greenfield heuristic: place N candidate DCs near demand clusters
 * with jitter, optionally avoiding locked existing sites.
 */
export function generateCandidates(params: GreenfieldParams): CandidateSite[] {
  const demand = NODES.filter((n) => n.kind === 'demand')
  const existingSites = NODES.filter((n) => n.kind === 'dc' || n.kind === 'plant')
  const count = Math.min(6, Math.max(2, params.siteCount))
  const out: CandidateSite[] = []

  // Seed centroids from demand; cycle if fewer demand nodes than sites.
  for (let i = 0; i < count; i++) {
    const anchor = demand[i % demand.length]
    const angle = (i / count) * Math.PI * 2 + 0.35
    const radius = 4 + (i % 3) * 2.2
    let x = anchor.x + Math.cos(angle) * radius
    let y = anchor.y + Math.sin(angle) * radius

    // Nudge away from locked existing sites.
    if (params.lockExisting) {
      for (const site of existingSites) {
        const dx = x - site.x
        const dy = y - site.y
        const dist = Math.hypot(dx, dy)
        if (dist < 6 && dist > 0) {
          x += (dx / dist) * 5
          y += (dy / dist) * 5
        }
      }
    }

    x = Math.min(92, Math.max(8, x))
    y = Math.min(88, Math.max(12, y))

    // Score: closer to demand + farther from locked sites → higher.
    let score = 70 + ((i * 7) % 23)
    for (const d of demand) {
      const dist = Math.hypot(x - d.x, y - d.y)
      const reach = params.euclidean ? dist : dist * 1.15
      if (reach * 12 < params.serviceMiles) score += 4
    }

    out.push({
      id: `cand-${Date.now().toString(36)}-${i}`,
      name: `Candidate DC ${String.fromCharCode(65 + i)}`,
      region: regionFromXY(x, y),
      x: Math.round(x * 10) / 10,
      y: Math.round(y * 10) / 10,
      score: Math.min(99, score),
      serviceMiles: params.serviceMiles,
    })
  }

  return out
}

export function kpisForComposedScenario(
  base: Scenario,
  deltas: DeltaItem[],
): KpiSnapshot {
  const n = deltas.reduce((sum, d) => sum + d.candidates.length, 0)
  if (n === 0) return base.kpis
  const serviceBump = Math.min(4.5, n * 0.9)
  const capexM = n * 6
  const costDrop = Math.min(5.5, n * 1.1)
  return {
    cost: {
      value: `$${(48.2 - costDrop).toFixed(1)}M`,
      delta: `−${costDrop.toFixed(1)}%`,
      better: true,
    },
    service: {
      value: `${(94.1 + serviceBump).toFixed(1)}%`,
      delta: `+${serviceBump.toFixed(1)}pp`,
      better: true,
    },
    capex: {
      value: `$${capexM}M`,
      delta: `+$${capexM}M`,
      better: false,
    },
    co2: {
      value: `${(12.4 - n * 0.4).toFixed(1)} kt`,
      delta: `−${Math.round(n * 3)}%`,
      better: true,
    },
    risk: {
      value: n >= 4 ? 'Low' : 'Med',
      delta: n >= 4 ? '↓' : '→',
      better: true,
    },
  }
}


/** Parse "$48.2M" / "$18M" style KPI money into millions USD. */
export function parseMoneyM(value: string): number {
  const cleaned = value.replace(/[$,\s]/g, '')
  const m = cleaned.match(/([\d.]+)/)
  if (!m) return 0
  const n = parseFloat(m[1])
  if (/k$/i.test(cleaned)) return n / 1000
  return n
}

/** Parse "94.1%" style KPI into a number. */
export function parsePercent(value: string): number {
  const m = value.replace(/,/g, '').match(/([\d.]+)/)
  return m ? parseFloat(m[1]) : 0
}

export type MapDiffMark = {
  id: string
  kind: 'open' | 'close' | 'flow-up' | 'flow-down'
  label: string
  x: number
  y: number
  x2?: number
  y2?: number
}

/**
 * Mock map-diff vs Reference: promoted greenfield candidates are opens;
 * seeded what-if scenarios get heuristic opens/closes/flow accents.
 */
export function mapDiffForScenario(
  scenario: Scenario,
  deltas: DeltaItem[],
  referenceId: string,
): MapDiffMark[] {
  if (scenario.id === referenceId) return []

  const marks: MapDiffMark[] = []

  if (scenario.optimizeMeta) {
    if (scenario.optimizeMeta.marks && scenario.optimizeMeta.marks.length > 0) {
      return scenario.optimizeMeta.marks.map((m) => ({ ...m }))
    }
    for (const id of scenario.optimizeMeta.openedIds) {
      const n = NODES.find((x) => x.id === id)
      marks.push({
        id: `opt-open-${id}`,
        kind: 'open',
        label: `${n?.name ?? id} (open)`,
        x: n?.x ?? 50,
        y: n?.y ?? 50,
      })
    }
    for (const id of scenario.optimizeMeta.closedIds) {
      const n = NODES.find((x) => x.id === id)
      marks.push({
        id: `opt-close-${id}`,
        kind: 'close',
        label: `${n?.name ?? id} (close)`,
        x: n?.x ?? 50,
        y: n?.y ?? 50,
      })
    }
    if (marks.length > 0) return marks
  }

  const usedDeltas = (scenario.deltaIds ?? [])
    .map((id) => deltas.find((d) => d.id === id))
    .filter((d): d is DeltaItem => !!d)

  for (const d of usedDeltas) {
    for (const c of d.candidates) {
      marks.push({
        id: `open-${c.id}`,
        kind: 'open',
        label: `${c.name} (open)`,
        x: c.x,
        y: c.y,
      })
    }
  }

  // Seeded scenario heuristics when no composed candidates.
  if (usedDeltas.length === 0) {
    if (scenario.id === 'east-dc') {
      marks.push({
        id: 'open-east-dc',
        kind: 'open',
        label: 'East Coast DC (open)',
        x: 74,
        y: 34,
      })
      marks.push({
        id: 'flow-east-1',
        kind: 'flow-up',
        label: 'Lane + volume',
        x: 62,
        y: 58,
        x2: 74,
        y2: 34,
      })
      marks.push({
        id: 'flow-east-2',
        kind: 'flow-up',
        label: 'Lane + volume',
        x: 74,
        y: 34,
        x2: 78,
        y2: 32,
      })
    } else if (scenario.id === 'nearshore') {
      marks.push({
        id: 'open-nearshore',
        kind: 'open',
        label: 'Nearshore MX plant (open)',
        x: 20,
        y: 70,
      })
      marks.push({
        id: 'flow-ns-1',
        kind: 'flow-up',
        label: 'Inbound +',
        x: 20,
        y: 70,
        x2: 28,
        y2: 62,
      })
      marks.push({
        id: 'close-reno-partial',
        kind: 'close',
        label: 'West overflow (close capacity)',
        x: 14,
        y: 36,
      })
    } else if (scenario.id === 'lean-lanes') {
      marks.push({
        id: 'close-reno',
        kind: 'close',
        label: 'Reno DC (close)',
        x: 14,
        y: 36,
      })
      marks.push({
        id: 'flow-lean-1',
        kind: 'flow-down',
        label: 'Lane − volume',
        x: 14,
        y: 36,
        x2: 52,
        y2: 38,
      })
      marks.push({
        id: 'flow-lean-2',
        kind: 'flow-down',
        label: 'Lane − volume',
        x: 62,
        y: 58,
        x2: 78,
        y2: 32,
      })
    } else {
      // Generic what-if: open near densest demand, soft-close furthest DC.
      const demand = NODES.filter((n) => n.kind === 'demand')
      const dcs = NODES.filter((n) => n.kind === 'dc')
      if (demand[0]) {
        marks.push({
          id: `open-generic-${scenario.id}`,
          kind: 'open',
          label: `${scenario.name} site (open)`,
          x: Math.min(90, demand[0].x + 4),
          y: Math.min(85, demand[0].y + 3),
        })
      }
      if (dcs[0]) {
        marks.push({
          id: `close-generic-${scenario.id}`,
          kind: 'close',
          label: `${dcs[0].name} (at risk)`,
          x: dcs[0].x,
          y: dcs[0].y,
        })
      }
    }
  } else if (marks.filter((m) => m.kind === 'open').length >= 2) {
    // Heuristic close: furthest existing DC from first open.
    const opens = marks.filter((m) => m.kind === 'open')
    const anchor = opens[0]
    const dcs = NODES.filter((n) => n.kind === 'dc')
    let furthest = dcs[0]
    let best = -1
    for (const dc of dcs) {
      const dist = Math.hypot(dc.x - anchor.x, dc.y - anchor.y)
      if (dist > best) {
        best = dist
        furthest = dc
      }
    }
    if (furthest) {
      marks.push({
        id: `close-${furthest.id}-${scenario.id}`,
        kind: 'close',
        label: `${furthest.name} (close)`,
        x: furthest.x,
        y: furthest.y,
      })
      marks.push({
        id: `flow-open-${scenario.id}`,
        kind: 'flow-up',
        label: 'Reroute +',
        x: furthest.x,
        y: furthest.y,
        x2: anchor.x,
        y2: anchor.y,
      })
    }
  }

  return marks
}

export type WaterfallStep = {
  id: string
  label: string
  /** Signed millions USD contribution (end total is absolute). */
  amount: number
  kind: 'start' | 'driver' | 'total'
}

/** Mock cost bridge from Reference → selected scenario using KPI money values. */
export function waterfallForScenario(
  scenario: Scenario,
  reference: Scenario,
): WaterfallStep[] {
  const start = parseMoneyM(reference.kpis.cost.value)
  const end = parseMoneyM(scenario.kpis.cost.value)
  const gap = end - start
  if (Math.abs(gap) < 0.05) {
    return [
      { id: 'start', label: `${reference.name} cost`, amount: start, kind: 'start' },
      { id: 'total', label: `${scenario.name} total`, amount: end, kind: 'total' },
    ]
  }

  const capex = parseMoneyM(scenario.kpis.capex.value) - parseMoneyM(reference.kpis.capex.value)
  // Annualize CapEx lightly into OpEx bridge (mock 12% charge).
  const capexCharge = Math.round(capex * 0.12 * 10) / 10
  const serviceDelta =
    parsePercent(scenario.kpis.service.value) -
    parsePercent(reference.kpis.service.value)
  // Rough: each +pp service costs ~0.15M; negative service frees cost.
  const serviceCost = Math.round(-serviceDelta * 0.15 * 10) / 10
  const transport = Math.round((gap - capexCharge - serviceCost) * 10) / 10

  const steps: WaterfallStep[] = [
    { id: 'start', label: `${reference.name} cost`, amount: start, kind: 'start' },
  ]
  if (Math.abs(transport) >= 0.05) {
    steps.push({
      id: 'transport',
      label: transport < 0 ? 'Transport savings' : 'Transport increase',
      amount: transport,
      kind: 'driver',
    })
  }
  if (Math.abs(serviceCost) >= 0.05) {
    steps.push({
      id: 'service',
      label: serviceCost < 0 ? 'Service redesign' : 'Service uplift cost',
      amount: serviceCost,
      kind: 'driver',
    })
  }
  if (Math.abs(capexCharge) >= 0.05) {
    steps.push({
      id: 'capex',
      label: 'CapEx annualized',
      amount: capexCharge,
      kind: 'driver',
    })
  }
  const driven = steps
    .filter((s) => s.kind === 'driver')
    .reduce((sum, s) => sum + s.amount, 0)
  const residual = Math.round((gap - driven) * 10) / 10
  if (Math.abs(residual) >= 0.05) {
    steps.push({
      id: 'other',
      label: residual < 0 ? 'Other savings' : 'Other costs',
      amount: residual,
      kind: 'driver',
    })
  }
  steps.push({
    id: 'total',
    label: `${scenario.name} total`,
    amount: end,
    kind: 'total',
  })
  return steps
}
