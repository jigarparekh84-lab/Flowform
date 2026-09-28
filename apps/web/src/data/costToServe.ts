/**
 * Cost-to-serve by customer / region.
 * Prefer MIP flows from optimizeMeta when present (landed cost + service DC);
 * fall back to mock lane allocation for heuristic / pre-optimize scenarios.
 */

import {
  parseMoneyM,
  type NetworkLane,
  type NetworkNode,
  type Scenario,
  type WaterfallStep,
} from './sampleNetwork'

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
  /** Primary serving DC / plant from MIP flows when available. */
  serviceDcId?: string
  serviceDc?: string
}

export type CtsResult = {
  rows: CtsRow[]
  waterfall: WaterfallStep[]
  totalM: number
  /** transport + variable (OpEx allocate) — should match MIP objective slice. */
  variableTotalM: number
  transportTotalM: number
  source: 'mip' | 'mock'
  /** Absolute gap vs objective transport + OpEx when MIP-backed. */
  fidelityGapM?: number
  objectiveTransportM?: number
  objectiveVariableM?: number
}

function demandVolume(node: NetworkNode, demandVolumeMap: Record<string, number>): number {
  if (demandVolumeMap[node.id] != null) return demandVolumeMap[node.id]
  const m = node.capacity.match(/([\d.]+)/)
  if (!m) return 5000
  const n = parseFloat(m[1])
  if (/k/i.test(node.capacity)) return Math.round(n * 1000)
  return Math.round(n)
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000
}

/**
 * MIP-backed CTS: allocate flow transportCostM to customers; assign service DC;
 * allocate open-facility OpEx (variable portion) by throughput share.
 * Totals aim to match objective transportM + fixedOpexM.
 */
export function computeCostToServeFromMip(args: {
  scenario: Scenario
  nodes: NetworkNode[]
  demandVolume: Record<string, number>
}): CtsResult | null {
  const meta = args.scenario.optimizeMeta
  const flows = meta?.flows
  const bd = meta?.objectiveBreakdown
  if (!flows?.length || !bd) return null

  const demand = args.nodes.filter((n) => n.kind === 'demand')
  if (!demand.length) return null

  const nodeById = new Map(args.nodes.map((n) => [n.id, n]))
  const nameOf = (id: string) => nodeById.get(id)?.name ?? id

  // Direct last-mile / plant→customer
  const custTransport: Record<string, number> = {}
  const custVolume: Record<string, number> = {}
  const custFromVol: Record<string, Record<string, number>> = {}

  for (const d of demand) {
    custTransport[d.id] = 0
    custVolume[d.id] = 0
    custFromVol[d.id] = {}
  }

  const dcOutVol: Record<string, number> = {}
  const dcCustVol: Record<string, Record<string, number>> = {}

  for (const f of flows) {
    const ech = f.echelon ?? ''
    const tx = f.transportCostM ?? (f.unitCost ?? 0) * f.volume
    if (ech === 'dc→customer' || ech === 'plant→customer') {
      if (!(f.to in custTransport)) continue
      custTransport[f.to] += tx
      custVolume[f.to] += f.volume
      custFromVol[f.to][f.from] = (custFromVol[f.to][f.from] ?? 0) + f.volume
      if (ech === 'dc→customer') {
        dcOutVol[f.from] = (dcOutVol[f.from] ?? 0) + f.volume
        dcCustVol[f.from] ??= {}
        dcCustVol[f.from][f.to] = (dcCustVol[f.from][f.to] ?? 0) + f.volume
      }
    }
  }

  // Allocate plant→DC (+ supplier→plant) into customers via DC share
  for (const f of flows) {
    const ech = f.echelon ?? ''
    const tx = f.transportCostM ?? (f.unitCost ?? 0) * f.volume
    if (ech === 'plant→dc') {
      const out = dcOutVol[f.to] ?? 0
      const shares = dcCustVol[f.to] ?? {}
      if (out <= 0) continue
      for (const [cid, vol] of Object.entries(shares)) {
        custTransport[cid] = (custTransport[cid] ?? 0) + tx * (vol / out)
      }
    }
  }

  // supplier→plant: allocate by plant FG share into customers (via plant→dc→cust + plant→cust)
  const plantFgToCust: Record<string, Record<string, number>> = {}
  for (const f of flows) {
    if (f.echelon === 'plant→customer') {
      plantFgToCust[f.from] ??= {}
      plantFgToCust[f.from][f.to] =
        (plantFgToCust[f.from][f.to] ?? 0) + f.volume
    }
    if (f.echelon === 'plant→dc') {
      const shares = dcCustVol[f.to] ?? {}
      const out = dcOutVol[f.to] ?? 0
      if (out <= 0) continue
      for (const [cid, vol] of Object.entries(shares)) {
        plantFgToCust[f.from] ??= {}
        plantFgToCust[f.from][cid] =
          (plantFgToCust[f.from][cid] ?? 0) + f.volume * (vol / out)
      }
    }
  }
  for (const f of flows) {
    if (f.echelon !== 'supplier→plant') continue
    const tx = f.transportCostM ?? (f.unitCost ?? 0) * f.volume
    const shares = plantFgToCust[f.to] ?? {}
    const tot = Object.values(shares).reduce((a, b) => a + b, 0)
    if (tot <= 0) continue
    for (const [cid, vol] of Object.entries(shares)) {
      custTransport[cid] = (custTransport[cid] ?? 0) + tx * (vol / tot)
    }
  }

  // Scale transport so sum matches objective.transportM (rounding / keep-bonus)
  const rawTxSum = Object.values(custTransport).reduce((a, b) => a + b, 0)
  const targetTx = bd.transportM
  const txScale = rawTxSum > 1e-9 ? targetTx / rawTxSum : 1

  // Variable OpEx from open facilities, allocated by customer volume through that facility
  const opexByFac: Record<string, number> = {}
  for (const of of meta.openFacilities ?? []) {
    opexByFac[of.id] = of.fixedOpexM
  }
  // Fallback: split objective OpEx evenly across open facilities if missing detail
  if (Object.keys(opexByFac).length === 0 && bd.fixedOpexM > 0) {
    const ids = new Set<string>()
    for (const fv of Object.values(custFromVol)) {
      for (const id of Object.keys(fv)) ids.add(id)
    }
    const share = bd.fixedOpexM / Math.max(1, ids.size)
    for (const id of ids) opexByFac[id] = share
  }

  const custOpex: Record<string, number> = {}
  for (const d of demand) custOpex[d.id] = 0

  // Allocate each facility's OpEx to customers it ships to (by volume)
  const facCustVol: Record<string, Record<string, number>> = {}
  for (const [cid, fromMap] of Object.entries(custFromVol)) {
    for (const [fid, vol] of Object.entries(fromMap)) {
      facCustVol[fid] ??= {}
      facCustVol[fid][cid] = (facCustVol[fid][cid] ?? 0) + vol
    }
  }
  for (const [fid, opex] of Object.entries(opexByFac)) {
    const shares = facCustVol[fid] ?? {}
    const tot = Object.values(shares).reduce((a, b) => a + b, 0)
    if (tot <= 0) {
      // No direct customers — spread across all demand by volume
      const volTotal =
        demand.reduce((s, d) => s + demandVolume(d, args.demandVolume), 0) || 1
      for (const d of demand) {
        const v = demandVolume(d, args.demandVolume)
        custOpex[d.id] += opex * (v / volTotal)
      }
      continue
    }
    for (const [cid, vol] of Object.entries(shares)) {
      custOpex[cid] = (custOpex[cid] ?? 0) + opex * (vol / tot)
    }
  }

  // Scale opex allocate to match objective fixedOpexM
  const rawOpexSum = Object.values(custOpex).reduce((a, b) => a + b, 0)
  const opexScale =
    rawOpexSum > 1e-9 && bd.fixedOpexM > 0 ? bd.fixedOpexM / rawOpexSum : 1

  const rows: CtsRow[] = demand.map((d) => {
    const volume =
      custVolume[d.id] > 0
        ? Math.round(custVolume[d.id])
        : demandVolume(d, args.demandVolume)
    const transportM = round4((custTransport[d.id] ?? 0) * txScale)
    const handlingM = round4((custOpex[d.id] ?? 0) * opexScale)
    const facilityM = 0 // CapEx excluded from variable CTS
    const totalM = round4(transportM + handlingM + facilityM)
    const ctsPerUnit =
      volume > 0 ? Math.round((totalM * 1_000_000) / volume) / 100 : 0

    let serviceDcId: string | undefined
    let best = 0
    for (const [fid, vol] of Object.entries(custFromVol[d.id] ?? {})) {
      if (vol > best) {
        best = vol
        serviceDcId = fid
      }
    }

    return {
      id: d.id,
      customer: d.name,
      region: d.region,
      volume,
      transportM: round2(transportM),
      handlingM: round2(handlingM),
      facilityM: round2(facilityM),
      totalM: round2(totalM),
      ctsPerUnit,
      serviceDcId,
      serviceDc: serviceDcId ? nameOf(serviceDcId) : undefined,
    }
  })

  rows.sort((a, b) => b.totalM - a.totalM)

  const transportTotalM = round4(rows.reduce((s, r) => s + r.transportM, 0))
  const handlingTotalM = round4(rows.reduce((s, r) => s + r.handlingM, 0))
  const variableTotalM = round4(transportTotalM + handlingTotalM)
  const objectiveVariableM = round4(bd.transportM + bd.fixedOpexM)
  const fidelityGapM = round4(Math.abs(variableTotalM - objectiveVariableM))

  const waterfall: WaterfallStep[] = [
    {
      id: 'start',
      label: 'Transport',
      amount: round2(transportTotalM),
      kind: 'start',
    },
    {
      id: 'handling',
      label: 'Variable OpEx',
      amount: round2(handlingTotalM),
      kind: 'driver',
    },
    {
      id: 'total',
      label: `${args.scenario.name} CTS`,
      amount: round2(variableTotalM),
      kind: 'total',
    },
  ]

  return {
    rows,
    waterfall,
    totalM: round2(variableTotalM),
    variableTotalM: round2(variableTotalM),
    transportTotalM: round2(transportTotalM),
    source: 'mip',
    fidelityGapM,
    objectiveTransportM: bd.transportM,
    objectiveVariableM,
  }
}

/**
 * Allocate lane transport cost to demand nodes proportionally (mock).
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
  const mip = computeCostToServeFromMip({
    scenario: args.scenario,
    nodes: args.nodes,
    demandVolume: args.demandVolume,
  })
  if (mip) return mip

  const { scenario, nodes, lanes, demandVolume: volMap } = args
  const demand = nodes.filter((n) => n.kind === 'demand')
  const totalCostM = parseMoneyM(scenario.kpis.cost.value)
  const costScale = args.costScale ?? totalCostM / 48.2

  const nodeById = new Map(nodes.map((n) => [n.id, n]))
  const inboundCost: Record<string, number> = {}
  for (const d of demand) inboundCost[d.id] = 0

  for (const lane of lanes) {
    const to = nodeById.get(lane.to)
    const laneCost = lane.costPerUnit * 1000 * costScale
    if (to?.kind === 'demand') {
      inboundCost[to.id] = (inboundCost[to.id] ?? 0) + laneCost
    } else if (to) {
      const targets = demand.filter((d) => d.region === to.region)
      const bucket = targets.length > 0 ? targets : demand
      const share = laneCost / Math.max(1, bucket.length)
      for (const t of bucket) {
        inboundCost[t.id] = (inboundCost[t.id] ?? 0) + share
      }
    }
  }

  const transportSum =
    Object.values(inboundCost).reduce((a, b) => a + b, 0) / 1_000_000
  const transportBudget = totalCostM * 0.55
  const transportNorm =
    transportSum > 0
      ? transportBudget / transportSum
      : transportBudget / Math.max(1, demand.length)

  const handlingBudget = totalCostM * 0.25
  const facilityBudget = totalCostM * 0.2
  const volTotal = demand.reduce((s, d) => s + demandVolume(d, volMap), 0) || 1

  const rows: CtsRow[] = demand.map((d) => {
    const volume = demandVolume(d, volMap)
    const transportM =
      Math.round(((inboundCost[d.id] ?? 0) / 1_000_000) * transportNorm * 100) /
      100
    const handlingM =
      Math.round(handlingBudget * (volume / volTotal) * 100) / 100
    const facilityM =
      Math.round(facilityBudget * (volume / volTotal) * 100) / 100
    const totalM = Math.round((transportM + handlingM + facilityM) * 100) / 100
    const ctsPerUnit =
      volume > 0 ? Math.round((totalM * 1_000_000) / volume) / 100 : 0
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
  const totalM =
    Math.round((sumTransport + sumHandling + sumFacility) * 10) / 10

  const waterfall: WaterfallStep[] = [
    {
      id: 'start',
      label: 'Transport',
      amount: Math.round(sumTransport * 10) / 10,
      kind: 'start',
    },
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
    {
      id: 'total',
      label: `${scenario.name} CTS`,
      amount: totalM,
      kind: 'total',
    },
  ]

  return {
    rows,
    waterfall,
    totalM,
    variableTotalM: Math.round((sumTransport + sumHandling) * 10) / 10,
    transportTotalM: Math.round(sumTransport * 10) / 10,
    source: 'mock',
  }
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
      ctsPerUnit:
        v.volume > 0 ? Math.round((v.totalM * 1_000_000) / v.volume) / 100 : 0,
    }))
    .sort((a, b) => b.totalM - a.totalM)
}
