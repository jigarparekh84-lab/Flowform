/**
 * Client for Flowform Optimize API (apps/api).
 * Falls back to client heuristic when unreachable.
 */

import type { BomState } from './bom'
import type { UploadedNetwork } from './csvParsers'
import type { NetworkConstraints, Scenario } from './sampleNetwork'

export const DEFAULT_API_BASE =
  (typeof import.meta !== 'undefined' &&
    (import.meta as ImportMeta & { env?: { VITE_API_URL?: string } }).env
      ?.VITE_API_URL) ||
  'http://127.0.0.1:5182'

export type ApiFlow = {
  from: string
  to: string
  volume: number
  miles?: number
  echelon?: string
  unitCost?: number
  transportCostM?: number
  productId?: string
  productLabel?: string
}

export type ApiObjectiveBreakdown = {
  totalM: number
  transportM: number
  fixedCapexM: number
  fixedOpexM: number
  uncoveredPenaltyM: number
  currency?: string
}

export type ApiOpenFacility = {
  id: string
  name: string
  kind?: string
  fixedCapexM: number
  fixedOpexM: number
  throughput: number
  capacityMax: number
  utilizationPct: number
}

export type ApiShadowPrice = {
  facilityId: string
  constraint: string
  shadowPrice: number
  unit?: string
  binding?: boolean
  slack?: number
  method?: string
}


export type ApiProductBreakdown = {
  productId: string
  label: string
  demand: number
  served: number
  uncovered: number
  servicePct: number
  transportM: number
}

export type ApiInfeasibilityHint = {
  code: string
  severity?: string
  message: string
  entities?: string[]
  hint?: string
}

export type ApiInfeasibilityReport = {
  status: string
  summary: string
  hints: ApiInfeasibilityHint[]
  metrics?: Record<string, number | boolean | string>
  method?: string
  note?: string
}

export type ApiOptimizeResponse = {
  ok: boolean
  solver: string
  status: string
  model?: string
  solveSeconds?: number
  openedIds: string[]
  closedIds: string[]
  keptOpenIds: string[]
  openIds?: string[]
  openFacilities?: ApiOpenFacility[]
  flows: ApiFlow[]
  objectiveBreakdown?: ApiObjectiveBreakdown
  shadowPrices?: ApiShadowPrice[]
  sensitivity?: { method?: string; note?: string }
  commodityMode?: string
  hardServiceConstraints?: boolean
  productBreakdown?: ApiProductBreakdown[]
  infeasibilityReport?: ApiInfeasibilityReport
  kpis: {
    servicePct: number
    capexUsedM: number
    opexUsedM?: number
    transportCostM?: number
    costM: number
    co2Kt: number
    uncoveredDemand: number
    targetPct?: number
    objectiveTotalM?: number
    productCount?: number
  }
  log: string[]
}

export async function checkApiHealth(
  baseUrl: string = DEFAULT_API_BASE,
  timeoutMs = 1200,
): Promise<boolean> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/health`, {
      signal: ctrl.signal,
    })
    if (!res.ok) return false
    const body = (await res.json()) as { status?: string }
    return body.status === 'ok'
  } catch {
    return false
  } finally {
    clearTimeout(t)
  }
}

export type OptimizeBomDemand = {
  supplierId: string
  plantId: string
  qtyPerUnit: number
}

export async function postOptimize(args: {
  network: UploadedNetwork | {
    nodes: UploadedNetwork['nodes']
    lanes: UploadedNetwork['lanes']
    demandVolume: Record<string, number>
    bomDemand?: OptimizeBomDemand[]
    demandByProduct?: {
      customerId: string
      productId: string
      skuId?: string
      volume: number
    }[]
    skus?: { id: string; name?: string; code?: string; groupId?: string }[]
    productGroups?: { id: string; name?: string; code?: string }[]
  }
  constraints: NetworkConstraints
  reference: Scenario
  bom?: BomState | { rows: BomState['rows'] }
  bomDemand?: OptimizeBomDemand[]
  /** When set, echoed in API log / client status (enterprise-data-v1). */
  enterpriseSchemaVersion?: string
  baseUrl?: string
}): Promise<ApiOptimizeResponse> {
  const base = (args.baseUrl ?? DEFAULT_API_BASE).replace(/\/$/, '')
  const bomRows = (args.bom?.rows ?? []).map((r) => ({
    plantId: r.plantId,
    preferredSupplierId: r.preferredSupplierId,
    qtyPerUnit: r.qtyPerUnit,
    finishedGoodId: r.finishedGoodId,
    componentId: r.componentId,
  }))
  const bomDemand =
    args.bomDemand ??
    ('bomDemand' in args.network ? args.network.bomDemand : undefined) ??
    []
  const net = args.network as {
    nodes: UploadedNetwork['nodes']
    lanes: UploadedNetwork['lanes']
    demandVolume: Record<string, number>
    bomDemand?: OptimizeBomDemand[]
    demandByProduct?: {
      customerId: string
      productId: string
      skuId?: string
      volume: number
    }[]
    skus?: { id: string; name?: string; code?: string; groupId?: string }[]
    productGroups?: { id: string; name?: string; code?: string }[]
  }
  const res = await fetch(`${base}/optimize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      network: {
        nodes: net.nodes,
        lanes: net.lanes,
        demandVolume: net.demandVolume,
        bomDemand: bomDemand.length ? bomDemand : undefined,
        demandByProduct: net.demandByProduct,
        skus: net.skus,
        productGroups: net.productGroups,
      },
      constraints: args.constraints,
      reference: {
        id: args.reference.id,
        name: args.reference.name,
        kpis: args.reference.kpis,
      },
      bom: bomRows.length ? { rows: bomRows } : undefined,
      bomDemand: bomDemand.length ? bomDemand : undefined,
      enterpriseSchemaVersion: args.enterpriseSchemaVersion,
    }),
  })
  if (!res.ok) {
    let detail = res.statusText
    try {
      const err = (await res.json()) as { detail?: string }
      if (err.detail) detail = err.detail
    } catch {
      /* ignore */
    }
    throw new Error(`API optimize ${res.status}: ${detail}`)
  }
  return (await res.json()) as ApiOptimizeResponse
}
