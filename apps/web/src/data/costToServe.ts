/**
 * Mock cost-to-serve by customer / region, driven by active scenario flows.
 */

import { parseMoneyM, type NetworkLane, type NetworkNode, type Scenario } from './sampleNetwork'
import type { WaterfallStep } from './sampleNetwork'

export type CtsRow = {
  id: string
  customer: string
  region: string
  volume: number
  transportM: number
  handlingM: number
  facilityM: number
  totalM: number
  ctsPerUnit: number
}

export type CtsResult = {
  rows: CtsRow[]
  waterfall: WaterfallStep[]
  totalM: number
}

function demandVolume(node: NetworkNode, demandVolumeMap: Record<string, number>): number {
  if (demandVolumeMap[node.id] != null) return demandVolumeMap[node.id]
  const m = node.capacity.match(/([\d.]+)/)
  if (!m) return 5000
  const n = parseFloat(m[1])
  if (/k/i.test(node.capacity)) return Math.round(n * 1000)
  return Math.round(n)
}

/**
 * Allocate lane transport cost to demand nodes proportionally.
 * Facility / handling are mock shares of scenario OpEx.
 */
export function computeCostToServe(args: {
  scenario: Scenario
  nodes: NetworkNode[]
  lanes: NetworkLane[]
  demandVolume: Record<string, number>
  /** Scenario cost scale vs baseline $48.2M (1 = baseline). */
  costScale?: number
}): CtsResult {
  const { scenario, nodes, lanes, demandVolume: volMap } = args
  const demand = nodes.filter((n) => n.kind === 'demand')
  const totalCostM = parseMoneyM(scenario.kpis.cost.value)
  const costScale = args.costScale ?? totalCostM / 48.2

  const nodeById = new Map(nodes.map((n) => [n.id, n]))
  const inboundCost: Record<string, number> = {}
  for (const d of demand) inboundCost[d.id] = 0

  for (const lane of lanes) {
    const to = nodeById.get(lane.to)
    const laneCost = lane.costPerUnit * 1000 * costScale // mock annualization
    if (to?.kind === 'demand') {
      inboundCost[to.id] = (inboundCost[to.id] ?? 0) + laneCost
    } else if (to) {
      // push a share to all demand in same region, else evenly
      const targets = demand.filter((d) => d.region === to.region)
      const bucket = targets.length > 0 ? targets : demand
      const share = laneCost / Math.max(1, bucket.length)
      for (const t of bucket) {
        inboundCost[t.id] = (inboundCost[t.id] ?? 0) + share
      }
    }
  }

  const transportSum = Object.values(inboundCost).reduce((a, b) => a + b, 0) / 1_000_000
  const transportBudget = totalCostM * 0.55
  const transportNorm =
    transportSum > 0 ? transportBudget / transportSum : transportBudget / Math.max(1, demand.length)

  const handlingBudget = totalCostM * 0.25
  const facilityBudget = totalCostM * 0.2
  const volTotal = demand.reduce((s, d) => s + demandVolume(d, volMap), 0) || 1

  const rows: CtsRow[] = demand.map((d) => {
    const volume = demandVolume(d, volMap)
    const transportM =
      Math.round(((inboundCost[d.id] ?? 0) / 1_000_000) * transportNorm * 100) / 100
    const handlingM = Math.round((handlingBudget * (volume / volTotal)) * 100) / 100
    const facilityM = Math.round((facilityBudget * (volume / volTotal)) * 100) / 100
    const totalM = Math.round((transportM + handlingM + facilityM) * 100) / 100
    const ctsPerUnit = volume > 0 ? Math.round((totalM * 1_000_000) / volume) / 100 : 0
    return {
      id: d.id,
      customer: d.name,
      region: d.region,
      volume,
      transportM,
      handlingM,
      facilityM,
      totalM,
      ctsPerUnit,
    }
  })

  rows.sort((a, b) => b.totalM - a.totalM)

  const sumTransport = rows.reduce((s, r) => s + r.transportM, 0)
  const sumHandling = rows.reduce((s, r) => s + r.handlingM, 0)
  const sumFacility = rows.reduce((s, r) => s + r.facilityM, 0)
  const totalM = Math.round((sumTransport + sumHandling + sumFacility) * 10) / 10

  const waterfall: WaterfallStep[] = [
    { id: 'start', label: 'Transport', amount: Math.round(sumTransport * 10) / 10, kind: 'start' },
    {
      id: 'handling',
      label: 'Handling / DC',
      amount: Math.round(sumHandling * 10) / 10,
      kind: 'driver',
    },
    {
      id: 'facility',
      label: 'Facility allocate',
      amount: Math.round(sumFacility * 10) / 10,
      kind: 'driver',
    },
    { id: 'total', label: `${scenario.name} CTS`, amount: totalM, kind: 'total' },
  ]

  return { rows, waterfall, totalM }
}

/** Region rollup of CTS rows. */
export function ctsByRegion(rows: CtsRow[]): {
  region: string
  totalM: number
  volume: number
  ctsPerUnit: number
}[] {
  const map = new Map<string, { totalM: number; volume: number }>()
  for (const r of rows) {
    const cur = map.get(r.region) ?? { totalM: 0, volume: 0 }
    cur.totalM += r.totalM
    cur.volume += r.volume
    map.set(r.region, cur)
  }
  return Array.from(map.entries())
    .map(([region, v]) => ({
      region,
      totalM: Math.round(v.totalM * 100) / 100,
      volume: v.volume,
      ctsPerUnit: v.volume > 0 ? Math.round((v.totalM * 1_000_000) / v.volume) / 100 : 0,
    }))
    .sort((a, b) => b.totalM - a.totalM)
}
