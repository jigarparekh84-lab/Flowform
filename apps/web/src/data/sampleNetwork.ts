export type NodeKind = 'plant' | 'dc' | 'demand' | 'supplier' | 'candidate'

export type NetworkNode = {
  id: string
  name: string
  kind: NodeKind
  region: string
  capacity: string
  x: number
  y: number
}

export type NetworkLane = {
  id: string
  from: string
  to: string
  mode: string
  costPerUnit: number
  leadDays: number
  co2Kg: number
}

export type KpiSnapshot = {
  cost: { value: string; delta: string; better: boolean }
  service: { value: string; delta: string; better: boolean }
  capex: { value: string; delta: string; better: boolean }
  co2: { value: string; delta: string; better: boolean }
  risk: { value: string; delta: string; better: boolean }
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
] as const

export const NODES: NetworkNode[] = [
  { id: 'n1', name: 'Austin Plant', kind: 'plant', region: 'South', capacity: '42k u/wk', x: 28, y: 62 },
  { id: 'n2', name: 'Columbus DC', kind: 'dc', region: 'Midwest', capacity: '18k pallet', x: 52, y: 38 },
  { id: 'n3', name: 'Atlanta DC', kind: 'dc', region: 'Southeast', capacity: '14k pallet', x: 62, y: 58 },
  { id: 'n4', name: 'Chicago Hub', kind: 'demand', region: 'Midwest', capacity: '9.2k u/wk', x: 48, y: 28 },
  { id: 'n5', name: 'Dallas Metro', kind: 'demand', region: 'South', capacity: '7.1k u/wk', x: 36, y: 55 },
  { id: 'n6', name: 'NYC Corridor', kind: 'demand', region: 'Northeast', capacity: '11.4k u/wk', x: 78, y: 32 },
  { id: 'n7', name: 'Monterrey Sup', kind: 'supplier', region: 'MX', capacity: '22k u/wk', x: 22, y: 72 },
  { id: 'n8', name: 'Reno DC', kind: 'dc', region: 'West', capacity: '12k pallet', x: 14, y: 36 },
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
