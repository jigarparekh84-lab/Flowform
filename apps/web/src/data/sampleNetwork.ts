export type NodeKind = 'plant' | 'dc' | 'demand' | 'supplier'

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
}

export const PROJECT_NAME = 'NA Footprint 2027'

export const HORIZON_OPTIONS = ['FY26', 'FY27', 'FY28'] as const

export const LAYERS = [
  { id: 'plants', label: 'Plants', defaultOn: true },
  { id: 'dcs', label: 'DCs', defaultOn: true },
  { id: 'demand', label: 'Demand', defaultOn: true },
  { id: 'suppliers', label: 'Suppliers', defaultOn: false },
  { id: 'lanes', label: 'Lanes', defaultOn: true },
  { id: 'service', label: 'Service radii', defaultOn: false },
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

export const SCENARIOS: Scenario[] = [
  {
    id: 'baseline',
    name: 'Baseline',
    tag: 'Live',
    kpis: {
      cost: { value: '$48.2M', delta: '—', better: true },
      service: { value: '94.1%', delta: '—', better: true },
      capex: { value: '$0', delta: '—', better: true },
      co2: { value: '12.4 kt', delta: '—', better: true },
      risk: { value: 'Med', delta: '—', better: true },
    },
  },
  {
    id: 'east-dc',
    name: 'East Coast DC',
    tag: 'What-if',
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
    kpis: {
      cost: { value: '$47.0M', delta: '−2.5%', better: true },
      service: { value: '93.0%', delta: '−1.1pp', better: false },
      capex: { value: '$1.2M', delta: '+$1.2M', better: false },
      co2: { value: '11.8 kt', delta: '−5%', better: true },
      risk: { value: 'High', delta: '↑', better: false },
    },
  },
]

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
  }
}
