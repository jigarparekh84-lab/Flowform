import type { ApiBaselineBlock } from './baselineKpis'
/**
 * Client for Flowform Optimize API (apps/api).
 * Falls back to client heuristic when unreachable.
 */

import type { BomState } from './bom'
import type { UploadedNetwork } from './csvParsers'
import type {
  NetworkConstraints,
  OptimizeLaneCapacityRow,
  OptimizeLaneUtilizationRow,
  OptimizeModeChoiceSummary,
  OptimizeExplain,
  OptimizeModeMixRow,
  Scenario,
} from './sampleNetwork'

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
  mode?: string
  modeKey?: string
  laneId?: string
  leadDays?: number
  co2Kg?: number
}

/** Off-lane rate + unmet-demand penalty knobs (see apps/api resolve_cost_scale). */
export type OptimizeCostFactors = {
  offLanePremium?: number
  offLaneRatePerUnitMile?: number
  uncoveredPenaltyPerUnit?: number
  [k: string]: unknown
}

/** Echo of the cost scale the MIP actually used. */
export type ApiCostScale = {
  currency: string
  volumeUnitScale: number
  volumeUnit: string
  medianLaneRatePerUnitMile: number | null
  medianLaneCostPerUnit: number | null
  offLanePremium: number
  offLaneRatePerUnitMile: number
  offLaneRateSource: string
  uncoveredPenaltyPerUnit: number
  uncoveredPenaltySource: string
}

export type ApiObjectiveBreakdown = {
  totalM: number
  transportM: number
  fixedCapexM: number
  fixedOpexM: number
  uncoveredPenaltyM: number
  /** $ per unit actually charged for unmet demand. */
  uncoveredPenaltyPerUnit?: number
  /** $ per unit-mile used for arcs without a lane rate. */
  offLaneRatePerUnitMile?: number
  laneFixedM?: number
  carbonM?: number
  modeMix?: OptimizeModeMixRow[]
  currency?: string
}

export type ApiLaneFlow = {
  laneId: string | null
  from: string
  to: string
  mode: string
  echelon?: string
  volume: number
  transportCostM: number
  co2Kg: number
  leadDays: number | null
  modeCapacity: number | null
  laneCapacity: number | null
  utilizationPct: number | null
  fixedCostM?: number
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
  rootCause?: boolean
  shortfalls?: Record<string, unknown>[]
}

export type ApiInfeasibilityReport = {
  status: string
  summary: string
  hints: ApiInfeasibilityHint[]
  rootCauses?: string[]
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
  /** CO₂ basis: unit weights (kg/unit) by commodity + tonne-miles. */
  co2Basis?: {
    basis: string
    defaultUnitWeightKg: number
    defaultSource?: string
    byCommodity: Record<string, number>
    demandWeightedUnitWeightKg?: number
    transportTonneMiles?: number
    transportTonneKm?: number
    missingWeightCommodities?: string[]
    issues?: { level: string; code: string; entityId?: string | null; message: string }[]
  }
  shadowPrices?: ApiShadowPrice[]
  sensitivity?: { method?: string; laneMethod?: string; note?: string; dualSeconds?: number }
  /** Depth 8 — present when the request set explain=true. */
  explain?: OptimizeExplain
  costScale?: ApiCostScale
  commodityMode?: string
  hardServiceConstraints?: boolean
  productBreakdown?: ApiProductBreakdown[]
  infeasibilityReport?: ApiInfeasibilityReport
  /** Depth 7 — lane capacity + mode choice outputs. */
  modeChoice?: OptimizeModeChoiceSummary
  laneFlows?: ApiLaneFlow[]
  laneUtilization?: OptimizeLaneUtilizationRow[]
  laneCapacity?: OptimizeLaneCapacityRow[]
  bindingLaneCapacities?: OptimizeLaneCapacityRow[]
  laneCapacityShortfalls?: {
    customers: {
      customerId: string
      demand: number
      inboundLaneCapacity: number
      shortfall: number
      laneIds: string[]
      serviceFilteredModes: number
    }[]
    plantOutbound: {
      outboundLaneCapacity: number
      demand: number
      shortfall: number
      laneIds: string[]
    } | null
    maxLeadTimeDays: number | null
  }
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
    transportCo2Kt?: number
    transportCo2Tonnes?: number
    transportTonneKm?: number
    /** g CO₂ per tonne-km (transport intensity). */
    co2GPerTonneKm?: number | null
    /** D-06: lane fixed charges — included in costM. */
    laneFixedM?: number
    carbonM?: number
    bindingLaneCount?: number
  }
  /** Current network costed as-is (when computeBaseline was requested). */
  baseline?: ApiBaselineBlock
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
    costFactors?: OptimizeCostFactors
  }
  constraints: NetworkConstraints
  reference: Scenario
  bom?: BomState | { rows: BomState['rows'] }
  bomDemand?: OptimizeBomDemand[]
  /** When set, echoed in API log / client status (enterprise-data-v1). */
  enterpriseSchemaVersion?: string
  /** Depth 8: request why-opened/closed explain cards (counterfactual re-solves). */
  explain?: boolean | { maxCounterfactuals?: number; budgetSec?: number; timeLimitSec?: number }
  /** Also cost the current network as-is → response.baseline (real Baseline KPIs). */
  computeBaseline?: boolean
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
    costFactors?: OptimizeCostFactors
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
        costFactors: net.costFactors,
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
      explain: args.explain || undefined,
      computeBaseline: args.computeBaseline || undefined,
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

export type MultiPeriodMode = 'choose_timing' | 'force_timeline'

export type ApiMultiPeriodEventTiming = {
  eventId: string
  name: string
  kind: string
  nodeId: string
  nodeName?: string
  year: number
  preferredYear?: number
  capexM: number
  capacityDelta?: number
  locked?: boolean
}

export type ApiMultiPeriodYearRow = {
  year: number
  label: string
  yearLabel?: string
  openIds: string[]
  openCount?: number
  capexM: number
  opexM: number
  transportM: number
  uncoveredPenaltyM?: number
  uncoveredDemand?: number
  totalCostM: number
  discountFactor: number
  npvContributionM: number
  servicePct: number
  demandScale?: number
  capacityByFacility?: Record<string, number>
  carbonM?: number
  laneFixedM?: number
  co2Kt?: number
  eventCapexM?: number
  candidateCapexM?: number
  runBreakdown?: {
    totalM: number
    transportM: number
    fixedCapexM: number
    fixedOpexM: number
    uncoveredPenaltyM: number
    laneFixedM: number
    carbonM: number
  }
  flowsSummary?: {
    arcCount: number
    totalVolume: number
    topFlows?: ApiFlow[]
  }
  eventsThisYear?: {
    eventId: string
    name: string
    kind: string
    capexM: number
  }[]
}

export type ApiMultiPeriodResponse = {
  ok: boolean
  solver: string
  status: string
  model?: string
  mode: MultiPeriodMode | string
  discountRate: number
  yearCount: number
  baseYearLabel?: string
  solveSeconds?: number
  npv: {
    totalM: number
    capexNpvM: number
    opexNpvM: number
    transportNpvM: number
    uncoveredPenaltyNpvM?: number
    carbonNpvM?: number
    laneFixedNpvM?: number
    currency?: string
  }
  basis?: {
    model: string
    description?: string
    commodityMode?: string
    commodities?: number
    variables?: number
    gapRel?: number
    timeLimitSec?: number
    buildSeconds?: number
    solveOnlySeconds?: number
  }
  runCheck?: {
    runTotalM?: number
    y0TotalM?: number
    deltaM?: number
    deltaPct?: number | null
    y0HasEvents?: boolean
    runOpenIds?: string[]
    y0OpenIds?: string[]
    matches?: boolean
    runStatus?: string
  } | null
  eventTiming: ApiMultiPeriodEventTiming[]
  years: ApiMultiPeriodYearRow[]
  kpis?: {
    npvTotalM?: number
    capexNpvM?: number
    opexNpvM?: number
    transportNpvM?: number
    servicePctEnd?: number
    eventsScheduled?: number
    yearCount?: number
    discountRate?: number
  }
  log: string[]
  infeasibilityReport?: ApiInfeasibilityReport
}

export type MultiPeriodRoadmapPayload = {
  baseYearLabel?: string
  yearCount: number
  discountRate: number
  mode: MultiPeriodMode
  events: {
    id: string
    name: string
    kind: string
    year: number
    nodeId: string
    nodeName?: string
    capexM: number
    capacityDelta: number
    facilityKind?: string
    earliestYear?: number
    latestYear?: number
    locked?: boolean
    region?: string
    notes?: string
  }[]
  demandScaleByYear?: number[]
  demandGrowthPct?: number
  hardServiceConstraints?: boolean
  capexBudgetTotalM?: number
  enforceCapexBudget?: boolean
  /** "run" (default) = every period is the Run MIP; "legacy-aggregate" = old model. */
  basis?: 'run' | 'legacy-aggregate'
  /** Also solve Run and return runCheck (Y0 vs Run). */
  compareRun?: boolean
  mipGapRel?: number
  timeLimitSec?: number
}

export async function postMultiPeriodOptimize(args: {
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
    skus?: { id: string; name?: string; code?: string; groupId?: string; unitWeightKg?: number }[]
    productGroups?: { id: string; name?: string; code?: string; unitWeightKg?: number }[]
    costFactors?: OptimizeCostFactors
  }
  constraints: NetworkConstraints
  bom?: BomState | { rows: BomState['rows'] }
  bomDemand?: OptimizeBomDemand[]
  enterpriseSchemaVersion?: string
  roadmap: MultiPeriodRoadmapPayload
  reference?: Scenario
  baseUrl?: string
}): Promise<ApiMultiPeriodResponse> {
  const base = (args.baseUrl ?? DEFAULT_API_BASE).replace(/\/$/, '')
  const net = args.network as {
    nodes: UploadedNetwork['nodes']
    lanes: UploadedNetwork['lanes']
    demandVolume: Record<string, number>
    bomDemand?: OptimizeBomDemand[]
    demandByProduct?: unknown[]
    skus?: unknown[]
    productGroups?: unknown[]
    costFactors?: OptimizeCostFactors
  }
  const bomRows = (args.bom?.rows ?? []).map((r) => ({
    plantId: r.plantId,
    preferredSupplierId: r.preferredSupplierId,
    qtyPerUnit: r.qtyPerUnit,
    finishedGoodId: r.finishedGoodId,
    componentId: r.componentId,
  }))
  const bomDemand = args.bomDemand ?? net.bomDemand ?? []
  const res = await fetch(`${base}/optimize/multi-period`, {
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
        costFactors: net.costFactors,
      },
      bom: bomRows.length ? { rows: bomRows } : undefined,
      bomDemand: bomDemand.length ? bomDemand : undefined,
      enterpriseSchemaVersion: args.enterpriseSchemaVersion,
      constraints: args.constraints,
      roadmap: args.roadmap,
      reference: args.reference
        ? {
            id: args.reference.id,
            name: args.reference.name,
            kpis: args.reference.kpis,
          }
        : undefined,
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
    throw new Error(`API multi-period optimize ${res.status}: ${detail}`)
  }
  return (await res.json()) as ApiMultiPeriodResponse
}

export type StochasticObjective = 'expected' | 'minimax' | 'cvar_lite'

export type StochasticScenarioInput = {
  id?: string
  name?: string
  probability: number
  demandScale?: number
  costScale?: number
  demandVolume?: Record<string, number>
}

export type ApiStochasticScenarioRow = {
  id: string
  name: string
  probability: number
  demandScale?: number
  costScale?: number
  capexM: number
  opexM: number
  transportM: number
  uncoveredPenaltyM?: number
  uncoveredDemand?: number
  totalCostM: number
  servicePct: number
  openIds: string[]
  flows?: ApiFlow[]
  flowsSummary?: {
    arcCount: number
    totalVolume: number
    topFlows?: ApiFlow[]
  }
}

export type ApiStochasticEvpi = {
  hereAndNowExpectedM: number
  waitAndSeeExpectedM: number | null
  evpiGapM: number | null
  note?: string
  waitAndSeeByScenario?: {
    id: string
    name: string
    probability: number
    ok: boolean
    costM: number | null
    openIds: string[]
    servicePct?: number
  }[]
  stableWaitAndSeeOpenIds?: string[]
  robustOpenIds?: string[]
  opensOnlyInRobust?: string[]
  opensOnlyInWaitAndSeeStable?: string[]
}

export type ApiStochasticResponse = {
  ok: boolean
  solver: string
  status: string
  model?: string
  objective: StochasticObjective | string
  cvarAlpha?: number | null
  solveSeconds?: number
  openedIds: string[]
  closedIds: string[]
  openIds?: string[]
  openFacilities?: ApiOpenFacility[]
  firstStage: {
    openIds: string[]
    capexM: number
    opexM: number
    fixedCostM?: number
  }
  scenarios: ApiStochasticScenarioRow[]
  objectiveValueM: number
  expectedCostM: number
  worstCostM: number
  evpi?: ApiStochasticEvpi | null
  kpis?: {
    expectedCostM?: number
    worstCostM?: number
    objectiveValueM?: number
    scenarioCount?: number
    openCount?: number
    evpiGapM?: number | null
    servicePctMin?: number
  }
  log: string[]
  infeasibilityReport?: ApiInfeasibilityReport
}

export type StochasticTreePayload = {
  objective: StochasticObjective
  cvarAlpha?: number
  computeEvpi?: boolean
  scenarios: StochasticScenarioInput[]
}

export async function postStochasticOptimize(args: {
  network: UploadedNetwork | {
    nodes: UploadedNetwork['nodes']
    lanes: UploadedNetwork['lanes']
    demandVolume: Record<string, number>
  }
  constraints: NetworkConstraints | Record<string, unknown>
  scenarioTree: StochasticTreePayload
  reference?: Scenario
  /** D-04: same BOM inbound as Run so robust totals are comparable. */
  bom?: { rows: unknown[] }
  bomDemand?: unknown[]
  enterpriseSchemaVersion?: string
  baseUrl?: string
}): Promise<ApiStochasticResponse> {
  const base = (args.baseUrl ?? DEFAULT_API_BASE).replace(/\/$/, '')
  // D-04: pass the full Run payload network (SKUs, demandByProduct, bomDemand…)
  const net = args.network
  const res = await fetch(`${base}/optimize/stochastic`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      network: net,
      constraints: args.constraints,
      ...(args.bom ? { bom: args.bom } : {}),
      ...(args.bomDemand ? { bomDemand: args.bomDemand } : {}),
      ...(args.enterpriseSchemaVersion
        ? { enterpriseSchemaVersion: args.enterpriseSchemaVersion }
        : {}),
      scenarioTree: args.scenarioTree,
      reference: args.reference
        ? {
            id: args.reference.id,
            name: args.reference.name,
            kpis: args.reference.kpis,
          }
        : undefined,
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
    throw new Error(`API stochastic optimize ${res.status}: ${detail}`)
  }
  return (await res.json()) as ApiStochasticResponse
}
