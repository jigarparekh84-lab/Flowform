import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  sampleUploadedNetwork,
  type UploadedNetwork,
} from '../data/csvParsers'
import {
  DEFAULT_EMISSION_FACTORS,
  formatCo2Kt,
  networkCo2Kt,
  type EmissionFactor,
} from '../data/emissions'
import { haversineMiles, nodeLatLng } from '../data/geo'
import {
  defaultConstraintsFromNetwork,
  mergeConstraints,
  runHeuristicOptimize,
} from '../data/optimize'
import {
  checkApiHealth,
  postOptimize,
  postMultiPeriodOptimize,
  postStochasticOptimize,
  type ApiOptimizeResponse,
  type MultiPeriodMode,
} from '../data/optimizeApi'
import {
  buildEnterprisePack,
  downloadEnterprisePack,
  productMixFromPack,
  emissionFactorsFromPack,
  packToBomRows,
  packToConstraints,
  packToOptimizePayload,
  packToUploadedNetwork,
  parseEnterprisePackJson,
  validateEnterprisePack,
  type EnterprisePack,
  type EnterpriseValidationScorecard,
} from '../data/enterprisePack'
import {
  createProject as createProjectStorage,
  DEFAULT_PROJECT_NAME,
  deleteProject as deleteProjectStorage,
  duplicateProject as duplicateProjectStorage,
  ensureDefaultProject,
  exportProjectJson,
  importProjectFromJson,
  listProjectMeta,
  loadProjectState,
  renameProject as renameProjectStorage,
  saveProjectState,
  setActiveProjectId,
  type ProjectMeta,
  type ProjectSnapshot,
} from '../data/projects'
import { BASELINE_KPIS,
  HORIZON_OPTIONS,
  INITIAL_SCENARIOS,
  generateCandidates,
  kpisForComposedScenario,
  type AssumptionItem,
  type BriefState,
  type CandidateSite,
  type DeltaItem,
  type FacilityConstraint,
  type GreenfieldParams,
  type NetworkConstraints,
  type NetworkLane,
  type NetworkNode,
  type OptimizeRunStatus,
  type Scenario,
} from '../data/sampleNetwork'
import {
  SENSITIVITY_PRESETS,
  kpisForSensitivity,
  sensitivityScenarioName,
  type SensitivityPresetId,
} from '../data/sensitivity'
import {
  computeInventoryRollup,
  defaultInventoryPolicies,
  formatInvDollars,
  formatInvUnits,
  mergeInventoryPolicies,
  type InventoryNodePolicy,
  type InventoryPolicyState,
  type SafetyStockFormula,
} from '../data/inventoryPolicy'
import {
  defaultProductMix,
  mergeProductMix,
  switchProductCatalog,
  type FacilityProductCap,
  type ProductCatalogId,
  type ProductGroupId,
  type ProductMixState,
} from '../data/productGroups'
import {
  resilienceRiskLabel,
  scoreResilience,
  type ResilienceResult,
} from '../data/resilience'
import {
  runDesLiteSim as runDesLiteEngine,
  type DesLiteParams,
  type DesLiteResult,
} from '../data/desLite'
import {
  runCostSensitivity as runCostSensitivityEngine,
  type CostSensitivityParams,
  type CostSensitivityResult,
} from '../data/costSensitivity'
import {
  addComment,
  deleteComment,
  buildSharePack,
  copyShareDeepLink,
  downloadSharePack,
  type ScenarioComment,
  type SharePack,
} from '../data/collaboration'
import {
  appendDecisionEntry,
  clearDecisionLog as emptyDecisionLog,
  type DecisionActionType,
  type DecisionLogEntry,
} from '../data/decisionLog'
import { applyLaneModeChange, emissionModeKey } from '../data/modeMix'
import {
  addBidToLane,
  applyBidToLane,
  defaultLaneRates,
  laneMiles as laneMilesHelper,
  mergeLaneRates,
  rankBids as rankBidsHelper,
  removeBidFromLane,
  setSelectedBid,
  updateBidInState,
  type BidStrategy,
  type LaneRatesState,
  type RateBid,
} from '../data/laneRates'
import {
  addBomRow,
  applyBomInboundLanes,
  defaultBom,
  mergeBom,
  removeBomRow,
  setBomHighlight,
  updateBomRow,
  updateFgShare,
  type BomRow,
  type BomState,
} from '../data/bom'
import {
  addCapexEvent,
  applyEventTimingToRoadmap,
  applyYearSlice,
  defaultCapexRoadmap,
  formatMultiPeriodBriefSection,
  formatRoadmapBriefSection,
  mergeCapexRoadmap,
  removeCapexEvent,
  updateCapexEvent,
  type CapexEvent,
  type CapexRoadmapState,
  type ApplyYearSliceResult,
  type MultiPeriodOptimizeResult,
} from '../data/capexRoadmap'
import {
  apiToStochasticResult,
  formatStochasticBriefSection,
  shocksFromScenarioChips,
  DEFAULT_DEMAND_SHOCKS,
  type StochasticOptimizeResult,
} from '../data/stochasticOptimize'
import type { StochasticObjective, StochasticScenarioInput } from '../data/optimizeApi'
import { readStoredTheme, type ThemeMode } from './theme'

export type SelectKind = 'node' | 'lane'

export type SelectionState = {
  ids: string[]
  kind: SelectKind | null
}

const DEFAULT_ASSUMPTIONS: AssumptionItem[] = [
  { id: 'a1', label: 'Demand is FY27 steady-state (no promotional spikes)', checked: true },
  { id: 'a2', label: 'Service radius uses Euclidean miles on canvas map', checked: true },
  { id: 'a3', label: 'CapEx is overnight build — no phased construction', checked: true },
  { id: 'a4', label: 'Optimize prefers API MIP (PuLP) when available; else heuristic v1', checked: true },
  { id: 'a5', label: 'Lane rates held constant vs Reference', checked: false },
  { id: 'a6', label: 'CO₂ factors are planning estimates only', checked: true },
]

function defaultBrief(scenarios: Scenario[]): BriefState {
  const baseline = scenarios.find((s) => s.id === 'baseline')
  const alts = scenarios.filter((s) => s.id !== 'baseline').slice(0, 2)
  return {
    recommendedScenarioId: alts[0]?.id ?? null,
    comparedIds: [baseline?.id, ...alts.map((s) => s.id)].filter(
      (x): x is string => !!x,
    ),
    assumptions: DEFAULT_ASSUMPTIONS,
    notes: '',
    sentToHandoffAt: null,
  }
}

function buildFreshSnapshot(theme?: ThemeMode): ProjectSnapshot {
  const net = sampleUploadedNetwork()
  return {
    version: 1,
    horizon: 'FY27',
    scenarios: structuredClone(INITIAL_SCENARIOS),
    activeScenarioId: INITIAL_SCENARIOS[0].id,
    deltas: [],
    network: net,
    constraints: defaultConstraintsFromNetwork(net),
    brief: defaultBrief(INITIAL_SCENARIOS),
    handoffPayload: null,
    emissionFactors: structuredClone(DEFAULT_EMISSION_FACTORS),
    lastCandidates: [],
    theme,
    inventoryPolicies: defaultInventoryPolicies(net),
    comments: [],
    productMix: defaultProductMix(net),
    laneRates: defaultLaneRates(net),
    bom: defaultBom(net),
    capexRoadmap: defaultCapexRoadmap(net),
    decisionLog: [],
  }
}

function kpisFromApi(
  api: ApiOptimizeResponse,
  reference: Scenario,
): Scenario['kpis'] {
  const refCost = parseFloat(
    String(reference.kpis.cost.value).replace(/[^0-9.]/g, ''),
  ) || 48.2
  const refService =
    parseFloat(String(reference.kpis.service.value).replace(/[^0-9.]/g, '')) ||
    94.1
  const refCo2 =
    parseFloat(String(reference.kpis.co2.value).replace(/[^0-9.]/g, '')) || 12.4
  const cost = api.kpis.costM
  const service = api.kpis.servicePct
  const co2 = api.kpis.co2Kt
  const costDeltaPct = ((cost - refCost) / refCost) * 100
  const serviceDelta = service - refService
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
      value: `$${api.kpis.capexUsedM.toFixed(0)}M`,
      delta: `+$${api.kpis.capexUsedM.toFixed(0)}M`,
      better: api.kpis.capexUsedM === 0,
    },
    co2: {
      value: `${co2.toFixed(1)} kt`,
      delta: `${co2 <= refCo2 ? '−' : '+'}${Math.abs(((co2 - refCo2) / refCo2) * 100).toFixed(0)}%`,
      better: co2 <= refCo2,
    },
    risk: {
      value: service >= 96 ? 'Low' : service >= 92 ? 'Med' : 'High',
      delta: service >= refService ? '↓' : '↑',
      better: service >= refService,
    },
  }
}

type FlowformContextValue = {
  horizon: (typeof HORIZON_OPTIONS)[number]
  setHorizon: (h: (typeof HORIZON_OPTIONS)[number]) => void
  scenarios: Scenario[]
  activeScenarioId: string
  activeScenario: Scenario
  setActiveScenarioId: (id: string) => void
  deltas: DeltaItem[]
  selection: SelectionState
  selectEntity: (id: string, kind: SelectKind, additive?: boolean) => void
  clearSelection: () => void
  runGreenfield: (params: GreenfieldParams) => CandidateSite[]
  lastCandidates: CandidateSite[]
  promoteCandidates: (selectedIds: string[], name?: string) => DeltaItem | null
  composeScenario: (args: {
    name: string
    baseId: string
    deltaIds: string[]
  }) => Scenario | null

  network: UploadedNetwork
  nodes: NetworkNode[]
  lanes: NetworkLane[]
  nodeById: (id: string) => NetworkNode | undefined
  loadUploadedNetwork: (net: UploadedNetwork) => void
  resetToSampleNetwork: () => void
  /** Build + validate enterprise pack from active studio state. */
  getEnterprisePack: () => {
    pack: EnterprisePack
    scorecard: EnterpriseValidationScorecard
  }
  exportEnterprisePackFile: () => void
  importEnterprisePack: (raw: unknown) => EnterpriseValidationScorecard | null

  constraints: NetworkConstraints
  setConstraints: (c: NetworkConstraints) => void
  updateFacilityConstraint: (
    nodeId: string,
    patch: Partial<FacilityConstraint>,
  ) => void
  updateConstraintGlobals: (
    patch: Partial<
      Pick<
        NetworkConstraints,
        | 'serviceTargetPct'
        | 'serviceRadiusMiles'
        | 'capexBudgetM'
        | 'maxFacilities'
        | 'hardServiceConstraints'
        | 'maxLeadTimeDays'
        | 'aggregateProductsByGroup'
        | 'maxProductCommodities'
      >
    >,
  ) => void

  optimizeStatus: OptimizeRunStatus
  runOptimize: () => Promise<Scenario | null>

  brief: BriefState
  setBrief: (b: BriefState) => void
  updateBrief: (patch: Partial<BriefState>) => void
  sendBriefToHandoff: () => void
  handoffPayload: BriefState | null

  emissionFactors: EmissionFactor[]
  setEmissionFactors: (f: EmissionFactor[]) => void
  updateEmissionFactor: (mode: string, kgPerTonMile: number) => void
  computedCo2Kt: number

  applySensitivityPreset: (presetId: SensitivityPresetId) => Scenario | null

  /** DES-lite Monte Carlo service sim — stores result on active scenario. */
  runDesLite: (params?: DesLiteParams) => DesLiteResult | null

  /** Cost-driver tornado + Monte Carlo — stores result on active scenario. */
  runCostSensitivity: (
    params?: CostSensitivityParams,
  ) => CostSensitivityResult | null

  /** Multi-echelon lite inventory policies (per DC/plant). */
  inventoryPolicies: InventoryPolicyState
  setInventoryFormula: (formula: SafetyStockFormula) => void
  updateInventoryNode: (
    nodeId: string,
    patch: Partial<InventoryNodePolicy>,
  ) => void
  resetInventoryPolicies: () => void
  /** Recompute rollup and attach inventory $ / units to Active scenario KPIs. */
  applyInventoryToActive: () => InventoryPolicyState | null

  /** Resilience / SPOF scoring — stores result on active scenario. */
  runResilience: (thresholdPct?: number) => ResilienceResult | null

  /** Projects room */
  projectMeta: ProjectMeta | null
  projects: ProjectMeta[]
  activeProjectId: string | null
  projectName: string
  createProject: (name?: string) => ProjectMeta
  renameProject: (id: string, name: string) => boolean
  duplicateProject: (id: string) => ProjectMeta | null
  deleteProject: (id: string) => void
  switchProject: (id: string) => void
  exportActiveProject: () => boolean
  importProjectFile: (raw: unknown) => ProjectMeta | null
  refreshProjects: () => void

  /** Per-scenario comment threads (project localStorage). */
  comments: ScenarioComment[]
  addScenarioComment: (scenarioId: string, body: string, author?: string) => void
  deleteScenarioComment: (id: string) => void

  /** Append-only decision / audit log (project localStorage). */
  decisionLog: DecisionLogEntry[]
  logDecision: (args: {
    action: DecisionActionType
    summary: string
    scenarioId?: string
  }) => void
  clearDecisionLog: () => void

  /** Edit lane transport mode (Road/Rail/Air/Ocean/Intermodal); rescales cost + CO₂. */
  updateLaneMode: (laneId: string, mode: string) => void

  /** Share stub: copy deep-link and/or download read-only share pack. */
  shareProject: (mode: 'copy' | 'download' | 'both') => Promise<{
    ok: boolean
    deepLink?: string
    pack?: SharePack
    message: string
  }>

  /** Apply M&A merged network + optional draft scenario. */
  applyMergedNetwork: (
    net: import('../data/csvParsers').UploadedNetwork,
    draftScenario?: Scenario,
  ) => void

  /** Apply hub-and-spoke redesign + draft scenario. */
  applyHubSpokeNetwork: (
    net: import('../data/csvParsers').UploadedNetwork,
    draftScenario?: Scenario,
  ) => void

  /** Apply service territory / preferred demand lanes + draft scenario. */
  applyTerritoryNetwork: (
    net: import('../data/csvParsers').UploadedNetwork,
    draftScenario?: Scenario,
  ) => void

  /** Multi-commodity / product groups. */
  productMix: ProductMixState
  setProductCatalog: (catalog: ProductCatalogId) => void
  setProductFilter: (groupId: ProductGroupId | null) => void
  updateDemandProductShares: (
    nodeId: string,
    shares: Record<ProductGroupId, number>,
  ) => void
  updateLaneProductGroups: (laneId: string, groupIds: ProductGroupId[]) => void
  updateFacilityProductCap: (
    nodeId: string,
    patch: Partial<FacilityProductCap>,
  ) => void
  resetProductMix: () => void

  /** Lane rate tables + carrier bid comparison. */
  laneRates: LaneRatesState
  setLaneRatesStrategy: (strategy: BidStrategy) => void
  updateRateBid: (
    laneId: string,
    bidId: string,
    patch: Partial<Omit<RateBid, 'id'>>,
  ) => void
  addRateBid: (laneId: string, bid?: Partial<RateBid>) => void
  removeRateBid: (laneId: string, bidId: string) => void
  /** Apply bid to network lane cost/transit/mode; marks selected. */
  applyRateBid: (laneId: string, bidId: string) => void
  /** Apply strategy winners across all lanes (or one lane). */
  applyWinningBids: (strategy?: BidStrategy, laneId?: string) => number
  resetLaneRates: () => void

  /** Bill-of-materials / multi-echelon FG←RM. */
  bom: BomState
  updateBomRow: (rowId: string, patch: Partial<Omit<BomRow, 'id'>>) => void
  addBomRow: (partial?: Partial<BomRow>) => void
  removeBomRow: (rowId: string) => void
  updateFgShare: (finishedGoodId: string, sharePct: number) => void
  setBomHighlight: (on: boolean) => void
  resetBom: () => void
  /** Draft scenario that adds implied Supplier→Plant inbound lanes. */
  applyBomInboundScenario: (scenarioName?: string) => {
    addedLanes: number
    scenarioId: string
  }

  /** CapEx phasing / multi-year roadmap. */
  capexRoadmap: CapexRoadmapState
  setCapexRoadmap: (next: CapexRoadmapState) => void
  updateCapexEvent: (
    id: string,
    patch: Partial<Omit<CapexEvent, 'id'>>,
  ) => void
  removeCapexEvent: (id: string) => void
  addCapexRoadmapEvent: (partial?: Partial<CapexEvent>) => void
  resetCapexRoadmap: () => void
  /** Apply events through year as network scenario. */
  applyRoadmapYearSlice: (
    throughYear: number,
    scenarioName?: string,
  ) => ApplyYearSliceResult | null
  /** Append roadmap markdown into Brief notes; uncheck overnight CapEx assumption. */
  exportRoadmapToBrief: () => boolean
  /** Multi-period CapEx NPV optimize (API). */
  multiPeriodResult: MultiPeriodOptimizeResult | null
  multiPeriodStatus: { phase: 'idle' | 'running' | 'done' | 'error'; message?: string }
  runMultiPeriodOptimize: (opts?: {
    mode?: MultiPeriodMode
    discountRate?: number
    applyTimingToRoadmap?: boolean
  }) => Promise<MultiPeriodOptimizeResult | null>
  exportMultiPeriodToBrief: () => boolean
  clearMultiPeriodResult: () => void
  /** Stochastic / robust scenario-tree optimize (API). */
  stochasticResult: StochasticOptimizeResult | null
  stochasticStatus: { phase: 'idle' | 'running' | 'done' | 'error'; message?: string }
  runStochasticOptimize: (opts?: {
    objective?: StochasticObjective
    cvarAlpha?: number
    scenarios?: StochasticScenarioInput[]
    /** When set, map these scenario chips to demand/cost shocks. */
    fromScenarioChips?: Scenario[]
    computeEvpi?: boolean
  }) => Promise<StochasticOptimizeResult | null>
  exportStochasticToBrief: () => boolean
  clearStochasticResult: () => void
}

const FlowformContext = createContext<FlowformContextValue | null>(null)

function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

export function FlowformProvider({ children }: { children: ReactNode }) {
  const boot = useMemo(() => {
    const meta = ensureDefaultProject(() => buildFreshSnapshot(readStoredTheme()))
    const snap = loadProjectState(meta.id) ?? buildFreshSnapshot(readStoredTheme())
    return { meta, snap, list: listProjectMeta() }
  }, [])

  const [projectMeta, setProjectMeta] = useState<ProjectMeta | null>(boot.meta)
  const [projects, setProjects] = useState<ProjectMeta[]>(boot.list)
  const [horizon, setHorizon] = useState<(typeof HORIZON_OPTIONS)[number]>(
    boot.snap.horizon,
  )
  const [scenarios, setScenarios] = useState<Scenario[]>(boot.snap.scenarios)
  const [activeScenarioId, setActiveScenarioIdState] = useState(
    boot.snap.activeScenarioId,
  )
  const [deltas, setDeltas] = useState<DeltaItem[]>(boot.snap.deltas)
  const [selection, setSelection] = useState<SelectionState>({
    ids: [],
    kind: null,
  })
  const [lastCandidates, setLastCandidates] = useState<CandidateSite[]>(
    boot.snap.lastCandidates ?? [],
  )
  const [lastParams, setLastParams] = useState<GreenfieldParams | null>(null)

  const [network, setNetwork] = useState<UploadedNetwork>(boot.snap.network)
  const [constraints, setConstraints] = useState<NetworkConstraints>(
    boot.snap.constraints,
  )
  const [optimizeStatus, setOptimizeStatus] = useState<OptimizeRunStatus>({
    phase: 'idle',
  })
  const [brief, setBrief] = useState<BriefState>(boot.snap.brief)
  const [handoffPayload, setHandoffPayload] = useState<BriefState | null>(
    boot.snap.handoffPayload,
  )
  const [emissionFactors, setEmissionFactors] = useState<EmissionFactor[]>(
    boot.snap.emissionFactors,
  )
  const [inventoryPolicies, setInventoryPolicies] =
    useState<InventoryPolicyState>(
      () =>
        mergeInventoryPolicies(
          boot.snap.inventoryPolicies,
          boot.snap.network,
        ),
    )
  const [comments, setComments] = useState<ScenarioComment[]>(
    () => boot.snap.comments ?? [],
  )
  const [decisionLog, setDecisionLog] = useState<DecisionLogEntry[]>(
    () => boot.snap.decisionLog ?? [],
  )
  const [productMix, setProductMix] = useState<ProductMixState>(
    () => mergeProductMix(boot.snap.productMix, boot.snap.network),
  )
  const [laneRates, setLaneRates] = useState<LaneRatesState>(
    () => mergeLaneRates(boot.snap.laneRates, boot.snap.network),
  )
  const [bom, setBom] = useState<BomState>(
    () => mergeBom(boot.snap.bom, boot.snap.network),
  )
  const [capexRoadmap, setCapexRoadmap] = useState<CapexRoadmapState>(() =>
    mergeCapexRoadmap(boot.snap.capexRoadmap, boot.snap.network),
  )
  const [multiPeriodResult, setMultiPeriodResult] =
    useState<MultiPeriodOptimizeResult | null>(null)
  const [multiPeriodStatus, setMultiPeriodStatus] = useState<{
    phase: 'idle' | 'running' | 'done' | 'error'
    message?: string
  }>({ phase: 'idle' })

  const [stochasticResult, setStochasticResult] =
    useState<StochasticOptimizeResult | null>(null)
  const [stochasticStatus, setStochasticStatus] = useState<{
    phase: 'idle' | 'running' | 'done' | 'error'
    message?: string
  }>({ phase: 'idle' })
  const optimizeLock = useRef(false)
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const skipPersist = useRef(true)
  const activeScenarioIdRef = useRef(boot.snap.activeScenarioId)

  useEffect(() => {
    activeScenarioIdRef.current = activeScenarioId
  }, [activeScenarioId])

  const activeScenario = useMemo(
    () => scenarios.find((s) => s.id === activeScenarioId) ?? scenarios[0],
    [scenarios, activeScenarioId],
  )

  const nodes = network.nodes
  const lanes = network.lanes

  const nodeById = useCallback(
    (id: string) => nodes.find((n) => n.id === id),
    [nodes],
  )

  const captureSnapshot = useCallback((): ProjectSnapshot => {
    let theme: ThemeMode | undefined
    try {
      const t = localStorage.getItem('flowform-theme')
      if (t === 'light' || t === 'dark') theme = t
    } catch {
      /* ignore */
    }
    return {
      version: 1,
      horizon,
      scenarios,
      activeScenarioId,
      deltas,
      network,
      constraints,
      brief,
      handoffPayload,
      emissionFactors,
      lastCandidates,
      theme,
      inventoryPolicies,
      comments,
      productMix,
      laneRates,
      bom,
      capexRoadmap,
      decisionLog,
    }
  }, [
    horizon,
    scenarios,
    activeScenarioId,
    deltas,
    network,
    constraints,
    brief,
    handoffPayload,
    emissionFactors,
    lastCandidates,
    inventoryPolicies,
    comments,
    productMix,
    laneRates,
    bom,
    capexRoadmap,
    decisionLog,
  ])

  const persistNow = useCallback(() => {
    if (!projectMeta) return
    saveProjectState(projectMeta.id, captureSnapshot())
    setProjects(listProjectMeta())
    setProjectMeta(
      listProjectMeta().find((p) => p.id === projectMeta.id) ?? projectMeta,
    )
  }, [projectMeta, captureSnapshot])

  // Debounced auto-save of active project
  useEffect(() => {
    if (skipPersist.current) {
      skipPersist.current = false
      return
    }
    if (!projectMeta) return
    if (persistTimer.current) clearTimeout(persistTimer.current)
    persistTimer.current = setTimeout(() => {
      saveProjectState(projectMeta.id, captureSnapshot())
      setProjects(listProjectMeta())
    }, 400)
    return () => {
      if (persistTimer.current) clearTimeout(persistTimer.current)
    }
  }, [
    projectMeta,
    captureSnapshot,
    horizon,
    scenarios,
    activeScenarioId,
    deltas,
    network,
    constraints,
    brief,
    handoffPayload,
    emissionFactors,
    lastCandidates,
    inventoryPolicies,
    comments,
    productMix,
    laneRates,
    bom,
    capexRoadmap,
    decisionLog,
  ])

  const applySnapshot = useCallback((snap: ProjectSnapshot) => {
    skipPersist.current = true
    setHorizon(snap.horizon)
    setScenarios(snap.scenarios)
    setActiveScenarioIdState(snap.activeScenarioId)
    setDeltas(snap.deltas ?? [])
    setNetwork(snap.network)
    setConstraints(snap.constraints)
    setBrief(snap.brief)
    setHandoffPayload(snap.handoffPayload)
    setEmissionFactors(snap.emissionFactors ?? DEFAULT_EMISSION_FACTORS)
    setLastCandidates(snap.lastCandidates ?? [])
    setInventoryPolicies(
      mergeInventoryPolicies(snap.inventoryPolicies, snap.network),
    )
    setComments(snap.comments ?? [])
    setDecisionLog(snap.decisionLog ?? [])
    setProductMix(mergeProductMix(snap.productMix, snap.network))
    setLaneRates(mergeLaneRates(snap.laneRates, snap.network))
    setBom(mergeBom(snap.bom, snap.network))
    setCapexRoadmap(mergeCapexRoadmap(snap.capexRoadmap, snap.network))
    setSelection({ ids: [], kind: null })
    setOptimizeStatus({ phase: 'idle' })
    if (snap.theme === 'light' || snap.theme === 'dark') {
      try {
        localStorage.setItem('flowform-theme', snap.theme)
        document.documentElement.setAttribute('data-theme', snap.theme)
        document.documentElement.style.colorScheme = snap.theme
      } catch {
        /* ignore */
      }
    }
  }, [])

  const refreshProjects = useCallback(() => {
    setProjects(listProjectMeta())
  }, [])

  const switchProject = useCallback(
    (id: string) => {
      if (projectMeta?.id === id) return
      // Save current first
      if (projectMeta) {
        saveProjectState(projectMeta.id, captureSnapshot())
      }
      const snap = loadProjectState(id)
      if (!snap) return
      setActiveProjectId(id)
      const meta = listProjectMeta().find((p) => p.id === id) ?? null
      setProjectMeta(meta)
      setProjects(listProjectMeta())
      applySnapshot(snap)
    },
    [projectMeta, captureSnapshot, applySnapshot],
  )

  const createProject = useCallback(
    (name?: string) => {
      if (projectMeta) {
        saveProjectState(projectMeta.id, captureSnapshot())
      }
      const snap = buildFreshSnapshot(readStoredTheme())
      const meta = createProjectStorage(
        name?.trim() || `Study ${listProjectMeta().length + 1}`,
        snap,
      )
      setProjectMeta(meta)
      setProjects(listProjectMeta())
      applySnapshot(snap)
      return meta
    },
    [projectMeta, captureSnapshot, applySnapshot],
  )

  const renameProject = useCallback(
    (id: string, name: string) => {
      const updated = renameProjectStorage(id, name)
      if (!updated) return false
      setProjects(listProjectMeta())
      if (projectMeta?.id === id) setProjectMeta(updated)
      return true
    },
    [projectMeta],
  )

  const duplicateProject = useCallback(
    (id: string) => {
      if (projectMeta?.id === id) {
        saveProjectState(id, captureSnapshot())
      }
      const meta = duplicateProjectStorage(id)
      if (!meta) return null
      setProjects(listProjectMeta())
      // Stay on current; user can Open the copy
      setActiveProjectId(projectMeta?.id ?? meta.id)
      // duplicateProjectStorage sets active to new — restore prior active
      if (projectMeta) setActiveProjectId(projectMeta.id)
      setProjects(listProjectMeta())
      return meta
    },
    [projectMeta, captureSnapshot],
  )

  const deleteProject = useCallback(
    (id: string) => {
      const remaining = listProjectMeta().filter((p) => p.id !== id)
      if (remaining.length === 0) return
      deleteProjectStorage(id)
      setProjects(listProjectMeta())
      if (projectMeta?.id === id) {
        const next = listProjectMeta()[0]
        if (next) {
          const snap = loadProjectState(next.id) ?? buildFreshSnapshot()
          setProjectMeta(next)
          setActiveProjectId(next.id)
          applySnapshot(snap)
        }
      }
    },
    [projectMeta, applySnapshot],
  )

  const exportActiveProject = useCallback(() => {
    if (!projectMeta) return false
    saveProjectState(projectMeta.id, captureSnapshot())
    return !!exportProjectJson(projectMeta.id)
  }, [projectMeta, captureSnapshot])

  const importProjectFile = useCallback(
    (raw: unknown) => {
      if (projectMeta) {
        saveProjectState(projectMeta.id, captureSnapshot())
      }
      const meta = importProjectFromJson(raw)
      if (!meta) return null
      const snap = loadProjectState(meta.id)
      if (!snap) return null
      setProjectMeta(meta)
      setProjects(listProjectMeta())
      applySnapshot(snap)
      return meta
    },
    [projectMeta, captureSnapshot, applySnapshot],
  )

  const selectEntity = useCallback(
    (id: string, kind: SelectKind, additive = false) => {
      setSelection((prev) => {
        if (additive && prev.kind === kind) {
          const has = prev.ids.includes(id)
          const ids = has
            ? prev.ids.filter((x) => x !== id)
            : [...prev.ids, id]
          return ids.length === 0
            ? { ids: [], kind: null }
            : { ids, kind }
        }
        return { ids: [id], kind }
      })
    },
    [],
  )

  const clearSelection = useCallback(() => {
    setSelection({ ids: [], kind: null })
  }, [])

  const runGreenfield = useCallback((params: GreenfieldParams) => {
    const sites = generateCandidates(params)
    setLastCandidates(sites)
    setLastParams(params)
    return sites
  }, [])

  const promoteCandidates = useCallback(
    (selectedIds: string[], name?: string): DeltaItem | null => {
      const picks = lastCandidates.filter((c) => selectedIds.includes(c.id))
      if (picks.length === 0) return null
      const baseParams: GreenfieldParams = lastParams ?? {
        demandSetId: 'na-core',
        siteCount: picks.length,
        serviceMiles: picks[0]?.serviceMiles ?? 250,
        euclidean: true,
        lockExisting: true,
      }
      const item: DeltaItem = {
        id: uid('delta'),
        name: name?.trim() || `Greenfield +${picks.length} sites`,
        kind: 'candidates',
        createdAt: new Date().toISOString(),
        params: {
          ...baseParams,
          siteCount: picks.length,
        },
        candidates: picks,
      }
      setDeltas((prev) => [item, ...prev])

      setNetwork((prev) => {
        const existingIds = new Set(prev.nodes.map((n) => n.id))
        const added: NetworkNode[] = picks
          .filter((c) => !existingIds.has(c.id))
          .map((c) => ({
            id: c.id,
            name: c.name,
            kind: 'candidate' as const,
            region: c.region,
            capacity: '12k pallet',
            x: c.x,
            y: c.y,
          }))
        if (added.length === 0) return prev
        return { ...prev, nodes: [...prev.nodes, ...added] }
      })
      setConstraints((c) => {
        const existing = new Set(c.facilities.map((f) => f.nodeId))
        const extra = picks
          .filter((p) => !existing.has(p.id))
          .map((p) => ({
            nodeId: p.id,
            status: 'candidate' as const,
            capacityMin: 7200,
            capacityMax: 15000,
            fixedCapexM: 6,
          }))
        if (extra.length === 0) return c
        return { ...c, facilities: [...c.facilities, ...extra] }
      })

      return item
    },
    [lastCandidates, lastParams],
  )

  const composeScenario = useCallback(
    ({
      name,
      baseId,
      deltaIds,
    }: {
      name: string
      baseId: string
      deltaIds: string[]
    }): Scenario | null => {
      const trimmed = name.trim()
      if (!trimmed || deltaIds.length === 0) return null
      const base = scenarios.find((s) => s.id === baseId)
      if (!base) return null
      const used = deltas.filter((d) => deltaIds.includes(d.id))
      if (used.length === 0) return null
      const scenario: Scenario = {
        id: uid('scen'),
        name: trimmed,
        tag: 'What-if',
        baseId,
        deltaIds: used.map((d) => d.id),
        kpis: kpisForComposedScenario(base, used),
      }
      setScenarios((prev) => [...prev, scenario])
      setActiveScenarioIdState(scenario.id)
      setDecisionLog((prev) =>
        appendDecisionEntry(prev, {
          action: 'create_scenario',
          summary: `Created scenario “${scenario.name}” from ${used.length} delta(s)`,
          scenarioId: scenario.id,
        }),
      )
      return scenario
    },
    [scenarios, deltas],
  )

  const loadUploadedNetwork = useCallback((net: UploadedNetwork) => {
    setNetwork(net)
    setConstraints((prev) => mergeConstraints(prev, net))
    setInventoryPolicies((prev) => mergeInventoryPolicies(prev, net))
    setProductMix((prev) => mergeProductMix(prev, net))
    setLaneRates((prev) => mergeLaneRates(prev, net))
    setBom((prev) => mergeBom(prev, net))
    setCapexRoadmap((prev) => mergeCapexRoadmap(prev, net))
    setSelection({ ids: [], kind: null })
  }, [])

  const resetToSampleNetwork = useCallback(() => {
    const sample = sampleUploadedNetwork()
    setNetwork(sample)
    setConstraints(defaultConstraintsFromNetwork(sample))
    setInventoryPolicies(defaultInventoryPolicies(sample))
    setProductMix(defaultProductMix(sample))
    setLaneRates(defaultLaneRates(sample))
    setBom(defaultBom(sample))
    setCapexRoadmap(defaultCapexRoadmap(sample))
    setSelection({ ids: [], kind: null })
  }, [])

  const getEnterprisePack = useCallback(() => {
    const pack = buildEnterprisePack({
      network,
      constraints,
      productMix,
      bom,
      emissionFactors,
      name: projectMeta?.name,
    })
    return { pack, scorecard: validateEnterprisePack(pack) }
  }, [network, constraints, productMix, bom, emissionFactors, projectMeta?.name])

  const exportEnterprisePackFile = useCallback(() => {
    const { pack } = getEnterprisePack()
    downloadEnterprisePack(pack)
  }, [getEnterprisePack])

  const importEnterprisePack = useCallback(
    (raw: unknown): EnterpriseValidationScorecard | null => {
      const parsed = parseEnterprisePackJson(raw)
      if (!parsed) return null
      const { pack, scorecard } = parsed
      if (!scorecard.ok) {
        // Still allow load when only warnings? Require no errors.
        // Errors block apply — return scorecard for UI.
        const fatal = scorecard.errorCount > 0
        if (fatal) return scorecard
      }
      const net = packToUploadedNetwork(pack)
      setNetwork(net)
      setConstraints(packToConstraints(pack))
      setEmissionFactors(emissionFactorsFromPack(pack))
      setBom((prev) => {
        const rows = packToBomRows(pack)
        if (rows.length === 0) return prev
        return {
          ...prev,
          rows,
          fgShares: pack.skus
            .filter((s) => pack.bom.some((b) => b.parentSkuId === s.id))
            .map((s) => ({
              finishedGoodId: s.id,
              finishedGoodName: s.name,
              sharePct: Math.round(100 / Math.max(1, pack.skus.filter((x) =>
                pack.bom.some((b) => b.parentSkuId === x.id),
              ).length)),
            })),
        }
      })
      setInventoryPolicies((prev) => mergeInventoryPolicies(prev, net))
      setProductMix((prev) => productMixFromPack(pack, net, prev))
      setLaneRates((prev) => mergeLaneRates(prev, net))
      setCapexRoadmap((prev) => mergeCapexRoadmap(prev, net))
      setSelection({ ids: [], kind: null })
      return scorecard
    },
    [],
  )

  const updateFacilityConstraint = useCallback(
    (nodeId: string, patch: Partial<FacilityConstraint>) => {
      setConstraints((prev) => ({
        ...prev,
        facilities: prev.facilities.map((f) =>
          f.nodeId === nodeId ? { ...f, ...patch } : f,
        ),
      }))
    },
    [],
  )

  const updateConstraintGlobals = useCallback(
    (
      patch: Partial<
        Pick<
          NetworkConstraints,
          | 'serviceTargetPct'
          | 'serviceRadiusMiles'
          | 'capexBudgetM'
          | 'maxFacilities'
          | 'hardServiceConstraints'
          | 'maxLeadTimeDays'
          | 'aggregateProductsByGroup'
          | 'maxProductCommodities'
        >
      >,
    ) => {
      setConstraints((prev) => ({ ...prev, ...patch }))
    },
    [],
  )

  const computedCo2Kt = useMemo(() => {
    const inputs = lanes.map((lane) => {
      const a = nodes.find((n) => n.id === lane.from)
      const b = nodes.find((n) => n.id === lane.to)
      let miles = 0
      if (a && b) {
        miles = haversineMiles(nodeLatLng(a), nodeLatLng(b))
      }
      return {
        mode: emissionModeKey(lane.mode),
        miles,
        tons: 1,
        fallbackCo2Kg: lane.co2Kg,
      }
    })
    return networkCo2Kt(emissionFactors, inputs)
  }, [lanes, nodes, emissionFactors])

  const updateEmissionFactor = useCallback(
    (mode: string, kgPerTonMile: number) => {
      setEmissionFactors((prev) =>
        prev.map((f) =>
          f.mode === mode
            ? { ...f, kgPerTonMile: Math.max(0, kgPerTonMile) }
            : f,
        ),
      )
    },
    [],
  )

  const applySensitivityPreset = useCallback(
    (presetId: SensitivityPresetId): Scenario | null => {
      const preset = SENSITIVITY_PRESETS.find((p) => p.id === presetId)
      if (!preset) return null
      const base = scenarios.find((s) => s.id === activeScenarioId) ?? scenarios[0]
      if (!base) return null
      const scenario: Scenario = {
        id: uid('sens'),
        name: sensitivityScenarioName(base, preset),
        tag: preset.tag,
        baseId: base.id,
        kpis: kpisForSensitivity(base, presetId),
      }
      if (presetId === 'fuel-20') {
        const kt = Math.round(computedCo2Kt * 1.03 * 10) / 10
        scenario.kpis = {
          ...scenario.kpis,
          co2: {
            ...scenario.kpis.co2,
            value: formatCo2Kt(kt),
          },
        }
      }
      setScenarios((prev) => [...prev, scenario])
      setActiveScenarioIdState(scenario.id)
      setDecisionLog((prev) =>
        appendDecisionEntry(prev, {
          action: 'apply_sensitivity',
          summary: `Applied sensitivity “${preset.label}” → “${scenario.name}”`,
          scenarioId: scenario.id,
        }),
      )
      return scenario
    },
    [scenarios, activeScenarioId, computedCo2Kt],
  )

  const runDesLite = useCallback(
    (params?: DesLiteParams): DesLiteResult | null => {
      const scenario =
        scenarios.find((s) => s.id === activeScenarioId) ?? scenarios[0]
      if (!scenario) return null
      const result = runDesLiteEngine({
        network,
        constraints,
        scenario,
        params,
      })
      setScenarios((prev) =>
        prev.map((s) =>
          s.id === scenario.id ? { ...s, desLite: result } : s,
        ),
      )
      return result
    },
    [scenarios, activeScenarioId, network, constraints],
  )

  const runCostSensitivity = useCallback(
    (params?: CostSensitivityParams): CostSensitivityResult | null => {
      const scenario =
        scenarios.find((s) => s.id === activeScenarioId) ?? scenarios[0]
      if (!scenario) return null
      const result = runCostSensitivityEngine({ scenario, params })
      setScenarios((prev) =>
        prev.map((s) =>
          s.id === scenario.id ? { ...s, costSensitivity: result } : s,
        ),
      )
      setDecisionLog((prev) =>
        appendDecisionEntry(prev, {
          action: 'apply_sensitivity',
          summary: `Ran cost tornado + Monte Carlo on “${scenario.name}” (${result.trials} trials)`,
          scenarioId: scenario.id,
        }),
      )
      return result
    },
    [scenarios, activeScenarioId],
  )

  const applyOptimizeResult = useCallback(
    (args: {
      openedIds: string[]
      closedIds: string[]
      servicePct: number
      capexUsedM: number
      heuristic: string
      flows?: ApiOptimizeResponse['flows']
      objectiveBreakdown?: ApiOptimizeResponse['objectiveBreakdown']
      openFacilities?: ApiOptimizeResponse['openFacilities']
      shadowPrices?: ApiOptimizeResponse['shadowPrices']
      model?: string
      status?: string
      solveSeconds?: number
      commodityMode?: string
      hardServiceConstraints?: boolean
      productBreakdown?: ApiOptimizeResponse['productBreakdown']
      infeasibilityReport?: ApiOptimizeResponse['infeasibilityReport']
      laneUtilization?: ApiOptimizeResponse['laneUtilization']
      laneCapacity?: ApiOptimizeResponse['laneCapacity']
      bindingLaneCapacities?: ApiOptimizeResponse['bindingLaneCapacities']
      modeChoice?: ApiOptimizeResponse['modeChoice']
      explain?: ApiOptimizeResponse['explain']
      log: string[]
      name: string
      kpis: Scenario['kpis']
      statusMessage: string
      skipConstraintApply?: boolean
    }) => {
      const { openedIds, closedIds } = args
      const facilities = network.nodes.filter(
        (n) => n.kind === 'dc' || n.kind === 'plant' || n.kind === 'candidate',
      )
      const scenario: Scenario = {
        id: uid('opt'),
        name: args.name,
        tag: 'Optimize',
        baseId: 'baseline',
        kpis: args.kpis,
        optimizeMeta: {
          heuristic: args.heuristic,
          openedIds,
          closedIds,
          servicePct: Math.round(args.servicePct * 10) / 10,
          capexUsedM: Math.round(args.capexUsedM * 10) / 10,
          flows: args.flows,
          objectiveBreakdown: args.objectiveBreakdown,
          openFacilities: args.openFacilities,
          shadowPrices: args.shadowPrices,
          model: args.model,
          status: args.status,
          solveSeconds: args.solveSeconds,
          commodityMode: args.commodityMode,
          hardServiceConstraints: args.hardServiceConstraints,
          productBreakdown: args.productBreakdown,
          infeasibilityReport: args.infeasibilityReport,
          laneUtilization: args.laneUtilization,
          laneCapacity: args.laneCapacity,
          bindingLaneCapacities: args.bindingLaneCapacities,
          modeChoice: args.modeChoice,
          explain: args.explain,
          solvedAt: new Date().toISOString(),
          marks: [
            ...openedIds.map((id) => {
              const n = facilities.find((f) => f.id === id)
              return {
                id: `opt-open-${id}`,
                kind: 'open' as const,
                label: `${n?.name ?? id} (open)`,
                x: n?.x ?? 50,
                y: n?.y ?? 50,
              }
            }),
            ...closedIds.map((id) => {
              const n = facilities.find((f) => f.id === id)
              return {
                id: `opt-close-${id}`,
                kind: 'close' as const,
                label: `${n?.name ?? id} (close)`,
                x: n?.x ?? 50,
                y: n?.y ?? 50,
              }
            }),
          ],
        },
      }

      if (!args.skipConstraintApply) {
        setConstraints((prev) => ({
          ...prev,
          facilities: prev.facilities.map((f) => {
            if (openedIds.includes(f.nodeId)) {
              return { ...f, status: 'open' as const }
            }
            if (closedIds.includes(f.nodeId)) {
              return { ...f, status: 'closed' as const }
            }
            return f
          }),
        }))
      }

      setScenarios((prev) => [...prev, scenario])
      setActiveScenarioIdState(scenario.id)
      setBrief((prev) => {
        const compared = Array.from(
          new Set([
            'baseline',
            scenario.id,
            ...prev.comparedIds.filter((id) => id !== scenario.id),
          ]),
        ).slice(0, 4)
        return {
          ...prev,
          recommendedScenarioId: scenario.id,
          comparedIds: compared,
        }
      })
      setOptimizeStatus({
        phase: 'done',
        scenarioId: scenario.id,
        message: args.statusMessage,
        log: args.log,
        solveSeconds: args.solveSeconds,
        status: args.status,
        model: args.model,
        solver: args.heuristic,
        infeasibilityReport: args.infeasibilityReport,
        productBreakdown: args.productBreakdown,
      })
      setDecisionLog((prev) =>
        appendDecisionEntry(prev, {
          action: 'run_optimize',
          summary: `Ran optimize “${scenario.name}” (${args.heuristic}) — open ${openedIds.length}, close ${closedIds.length}`,
          scenarioId: scenario.id,
        }),
      )
      return scenario
    },
    [network.nodes],
  )

  const runOptimize = useCallback(async (): Promise<Scenario | null> => {
    if (optimizeLock.current) return null
    optimizeLock.current = true
    try {
      setOptimizeStatus({
        phase: 'running',
        progress: 10,
        message: 'Checking optimize API…',
      })

      const apiUp = await checkApiHealth()
      const reference =
        scenarios.find((s) => s.id === 'baseline') ?? scenarios[0]

      // Enterprise pack → MIP payload (capacities, fixed costs, BOM demand)
      const pack = buildEnterprisePack({
        network,
        constraints,
        productMix,
        bom,
        emissionFactors,
        name: projectMeta?.name,
      })
      const scorecard = validateEnterprisePack(pack)
      const mipPayload = packToOptimizePayload(pack, scorecard)

      if (apiUp) {
        setOptimizeStatus({
          phase: 'running',
          progress: 35,
          message: scorecard.ok
            ? `API available — MIP via ${scorecard.schemaVersion} (score ${scorecard.score})…`
            : `API available — pack score ${scorecard.score} (warns ok) — running PuLP MIP…`,
        })
        try {
          const api = await postOptimize({
            network: mipPayload.network,
            constraints: mipPayload.constraints,
            reference,
            bom: mipPayload.bom,
            bomDemand: mipPayload.network.bomDemand,
            enterpriseSchemaVersion: mipPayload.enterpriseSchemaVersion,
            explain: { maxCounterfactuals: 12, budgetSec: 30 },
          })
          setOptimizeStatus({
            phase: 'running',
            progress: 85,
            message: `Packaging ${api.solver} result…`,
          })
          await sleep(120)
          const bd = api.objectiveBreakdown
          const bdMsg = bd
            ? ` · obj $${bd.totalM.toFixed(2)}M (tx $${bd.transportM.toFixed(2)}M + CapEx $${bd.fixedCapexM.toFixed(1)}M + OpEx $${bd.fixedOpexM.toFixed(1)}M)`
            : ''
          const solveSec = api.solveSeconds
          const timeMsg =
            solveSec != null ? ` · ${solveSec.toFixed(3)}s` : ''
          const infeas = api.status === 'Infeasible' || api.ok === false
          const report = api.infeasibilityReport
          const reportMsg = report
            ? ` · ${report.summary.slice(0, 120)}`
            : ''
          const skuMsg =
            api.productBreakdown && api.productBreakdown.length > 1
              ? ` · ${api.productBreakdown.length} SKUs/groups`
              : ''
          const mix = api.objectiveBreakdown?.modeMix ?? []
          const modeMsg =
            api.modeChoice?.enabled && mix.length
              ? ` · modes ${mix
                  .slice(0, 3)
                  .map((m) => `${m.mode} ${Math.round(m.sharePct)}%`)
                  .join('/')}`
              : ''
          const laneMsg = api.bindingLaneCapacities?.length
            ? ` · ${api.bindingLaneCapacities.length} binding lane cap(s)`
            : ''
          return applyOptimizeResult({
            openedIds: api.openedIds ?? [],
            closedIds: api.closedIds ?? [],
            servicePct: api.kpis.servicePct,
            capexUsedM: api.kpis.capexUsedM,
            heuristic: api.solver,
            flows: api.flows,
            objectiveBreakdown: api.objectiveBreakdown,
            openFacilities: api.openFacilities,
            shadowPrices: api.shadowPrices,
            model: api.model,
            status: api.status,
            solveSeconds: api.solveSeconds,
            commodityMode: api.commodityMode,
            hardServiceConstraints: api.hardServiceConstraints,
            productBreakdown: api.productBreakdown,
            infeasibilityReport: report,
            laneUtilization: api.laneUtilization,
            laneCapacity: api.laneCapacity,
            bindingLaneCapacities: api.bindingLaneCapacities,
            modeChoice: api.modeChoice,
            explain: api.explain,
            log: api.log,
            name: infeas
              ? `Optimize Infeasible ${new Date().toLocaleTimeString()}`
              : `Optimize MIP ${new Date().toLocaleTimeString()}`,
            kpis: kpisFromApi(api, reference),
            skipConstraintApply: infeas,
            statusMessage: infeas
              ? `API ${api.solver} · Infeasible${timeMsg}${reportMsg}${skuMsg}`
              : `API ${api.solver} · ${api.status}${timeMsg} · ${api.model ?? 'MIP'} · service ${api.kpis.servicePct.toFixed(1)}%${bdMsg}${skuMsg}${modeMsg}${laneMsg}`,
          })
        } catch (apiErr) {
          const msg =
            apiErr instanceof Error ? apiErr.message : 'API optimize failed'
          setOptimizeStatus({
            phase: 'running',
            progress: 45,
            message: `API failed (${msg}) — falling back to heuristic v1…`,
          })
          await sleep(280)
        }
      } else {
        setOptimizeStatus({
          phase: 'running',
          progress: 28,
          message: 'API offline — client heuristic v1…',
        })
        await sleep(220)
      }

      setOptimizeStatus({
        phase: 'running',
        progress: 55,
        message: 'Heuristic v1 — greedy open/close…',
      })
      await sleep(260)

      const result = runHeuristicOptimize({
        network,
        constraints,
        reference,
      })

      setOptimizeStatus({
        phase: 'running',
        progress: 88,
        message: 'Packaging scenario KPIs…',
      })
      await sleep(160)

      return applyOptimizeResult({
        openedIds: result.openedIds,
        closedIds: result.closedIds,
        servicePct: result.servicePct,
        capexUsedM: result.capexUsedM,
        heuristic: 'v1-greedy',
        log: [
          ...(apiUp
            ? ['Fell back to client heuristic after API issue.']
            : ['Optimize API unreachable — used client heuristic v1.']),
          ...result.log,
        ],
        name: result.scenario.name,
        kpis: result.scenario.kpis,
        statusMessage: `Heuristic v1 · service ${result.servicePct.toFixed(1)}% (API offline or fallback)`,
      })
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Optimize failed unexpectedly'
      setOptimizeStatus({ phase: 'error', message })
      return null
    } finally {
      optimizeLock.current = false
    }
  }, [scenarios, network, constraints, bom, productMix, emissionFactors, projectMeta?.name, applyOptimizeResult])

  const setInventoryFormula = useCallback((formula: SafetyStockFormula) => {
    setInventoryPolicies((prev) => ({ ...prev, formula }))
  }, [])

  const updateInventoryNode = useCallback(
    (nodeId: string, patch: Partial<InventoryNodePolicy>) => {
      setInventoryPolicies((prev) => ({
        ...prev,
        nodes: prev.nodes.map((n) =>
          n.nodeId === nodeId ? { ...n, ...patch } : n,
        ),
      }))
    },
    [],
  )

  const resetInventoryPolicies = useCallback(() => {
    setInventoryPolicies(defaultInventoryPolicies(network))
  }, [network])

  const applyInventoryToActive = useCallback((): InventoryPolicyState | null => {
    const scenario =
      scenarios.find((s) => s.id === activeScenarioId) ?? scenarios[0]
    if (!scenario) return null
    const rollup = computeInventoryRollup(inventoryPolicies, network)
    const invCell = {
      value: formatInvDollars(rollup.totalDollars),
      delta: inventoryPolicies.formula === 'simple' ? 'simple' : 'ASCM',
      better: true,
    }
    const unitsCell = {
      value: formatInvUnits(rollup.totalUnits),
      delta: `${rollup.nodes.length} sites`,
      better: true,
    }
    setScenarios((prev) =>
      prev.map((s) =>
        s.id === scenario.id
          ? {
              ...s,
              kpis: {
                ...s.kpis,
                inventory: invCell,
                invUnits: unitsCell,
              },
              inventoryRollup: {
                formula: rollup.formula,
                totalUnits: rollup.totalUnits,
                totalDollars: rollup.totalDollars,
                totalDollarsM: rollup.totalDollarsM,
                appliedAt: new Date().toISOString(),
              },
            }
          : s,
      ),
    )
    return inventoryPolicies
  }, [scenarios, activeScenarioId, inventoryPolicies, network])

  const runResilience = useCallback(
    (thresholdPct?: number): ResilienceResult | null => {
      const scenario =
        scenarios.find((s) => s.id === activeScenarioId) ?? scenarios[0]
      if (!scenario) return null
      const result = scoreResilience({
        network,
        constraints,
        scenario,
        thresholdPct,
      })
      const risk = resilienceRiskLabel(result.score)
      setScenarios((prev) =>
        prev.map((s) =>
          s.id === scenario.id
            ? {
                ...s,
                resilience: {
                  runAt: result.runAt,
                  thresholdPct: result.thresholdPct,
                  baselineServicePct: result.baselineServicePct,
                  score: result.score,
                  criticalNodeIds: result.critical.map((c) => c.nodeId),
                  criticalNames: result.critical.map((c) => c.name),
                  facilityCount: result.facilityCount,
                },
                kpis: {
                  ...s.kpis,
                  risk: {
                    value: risk,
                    delta:
                      result.critical.length === 0
                        ? 'no SPOF'
                        : `${result.critical.length} SPOF`,
                    better: result.score >= 60,
                  },
                },
              }
            : s,
        ),
      )
      return result
    },
    [scenarios, activeScenarioId, network, constraints],
  )

  const addScenarioComment = useCallback(
    (scenarioId: string, body: string, author?: string) => {
      setComments((prev) =>
        addComment(prev, {
          scenarioId,
          body,
          author: author ?? 'You',
        }),
      )
    },
    [],
  )

  const deleteScenarioComment = useCallback((id: string) => {
    setComments((prev) => deleteComment(prev, id))
  }, [])

  const logDecision = useCallback(
    (args: {
      action: DecisionActionType
      summary: string
      scenarioId?: string
    }) => {
      setDecisionLog((prev) =>
        appendDecisionEntry(prev, {
          action: args.action,
          summary: args.summary,
          scenarioId: args.scenarioId,
        }),
      )
    },
    [],
  )

  const clearDecisionLog = useCallback(() => {
    setDecisionLog(emptyDecisionLog())
  }, [])

  const setActiveScenarioId = useCallback(
    (id: string) => {
      if (activeScenarioIdRef.current === id) return
      const name =
        scenarios.find((s) => s.id === id)?.name ?? id
      setActiveScenarioIdState(id)
      setDecisionLog((prev) =>
        appendDecisionEntry(prev, {
          action: 'activate_scenario',
          summary: `Activated “${name}”`,
          scenarioId: id,
        }),
      )
    },
    [scenarios],
  )

  const updateLaneMode = useCallback(
    (laneId: string, mode: string) => {
      setNetwork((prev) => {
        const lanes = prev.lanes.map((l) =>
          l.id === laneId
            ? applyLaneModeChange(l, mode, {
                nodes: prev.nodes,
                factors: emissionFactors,
              })
            : l,
        )
        return { ...prev, lanes }
      })
    },
    [emissionFactors],
  )

  const shareProject = useCallback(
    async (mode: 'copy' | 'download' | 'both') => {
      if (!projectMeta) {
        return { ok: false, message: 'No active project to share.' }
      }
      // Flush latest snapshot into storage before export
      saveProjectState(projectMeta.id, captureSnapshot())
      const pack = buildSharePack(projectMeta.id, captureSnapshot())
      if (!pack) {
        return { ok: false, message: 'Could not build share pack.' }
      }
      let copied = false
      if (mode === 'copy' || mode === 'both') {
        copied = await copyShareDeepLink(projectMeta)
      }
      if (mode === 'download' || mode === 'both') {
        downloadSharePack(pack)
      }
      const parts: string[] = []
      if (mode === 'copy' || mode === 'both') {
        parts.push(copied ? 'Deep-link copied' : 'Clipboard unavailable')
      }
      if (mode === 'download' || mode === 'both') {
        parts.push('Share pack downloaded')
      }
      setDecisionLog((prev) =>
        appendDecisionEntry(prev, {
          action: 'share',
          summary: `Shared project “${projectMeta.name}” (${mode})`,
          scenarioId: activeScenarioIdRef.current,
        }),
      )
      return {
        ok: true,
        deepLink: pack.deepLink,
        pack,
        message: parts.join(' · '),
      }
    },
    [projectMeta, captureSnapshot],
  )

  const applyMergedNetwork = useCallback(
    (
      net: import('../data/csvParsers').UploadedNetwork,
      draftScenario?: Scenario,
    ) => {
      setNetwork(net)
      setConstraints((prev) => mergeConstraints(prev, net))
      setInventoryPolicies((prev) => mergeInventoryPolicies(prev, net))
      setProductMix((prev) => mergeProductMix(prev, net))
      setLaneRates((prev) => mergeLaneRates(prev, net))
      setBom((prev) => mergeBom(prev, net))
      setSelection({ ids: [], kind: null })
      if (draftScenario) {
        setScenarios((prev) => {
          if (prev.some((s) => s.id === draftScenario.id)) return prev
          return [...prev, draftScenario]
        })
        setActiveScenarioIdState(draftScenario.id)
      }
    },
    [],
  )

  const applyHubSpokeNetwork = useCallback(
    (
      net: import('../data/csvParsers').UploadedNetwork,
      draftScenario?: Scenario,
    ) => {
      setNetwork(net)
      setConstraints((prev) => mergeConstraints(prev, net))
      setInventoryPolicies((prev) => mergeInventoryPolicies(prev, net))
      setProductMix((prev) => mergeProductMix(prev, net))
      setLaneRates((prev) => mergeLaneRates(prev, net))
      setBom((prev) => mergeBom(prev, net))
      setSelection({ ids: [], kind: null })
      if (draftScenario) {
        setScenarios((prev) => {
          if (prev.some((s) => s.id === draftScenario.id)) return prev
          return [...prev, draftScenario]
        })
        setActiveScenarioIdState(draftScenario.id)
      }
      setDecisionLog((prev) =>
        appendDecisionEntry(prev, {
          action: 'apply_hub',
          summary: draftScenario
            ? `Applied hub-and-spoke design → “${draftScenario.name}”`
            : 'Applied hub-and-spoke network redesign',
          scenarioId: draftScenario?.id,
        }),
      )
    },
    [],
  )

  const applyTerritoryNetwork = useCallback(
    (
      net: import('../data/csvParsers').UploadedNetwork,
      draftScenario?: Scenario,
    ) => {
      setNetwork(net)
      setConstraints((prev) => mergeConstraints(prev, net))
      setInventoryPolicies((prev) => mergeInventoryPolicies(prev, net))
      setProductMix((prev) => mergeProductMix(prev, net))
      setLaneRates((prev) => mergeLaneRates(prev, net))
      setBom((prev) => mergeBom(prev, net))
      setSelection({ ids: [], kind: null })
      if (draftScenario) {
        setScenarios((prev) => {
          if (prev.some((s) => s.id === draftScenario.id)) return prev
          return [...prev, draftScenario]
        })
        setActiveScenarioIdState(draftScenario.id)
      }
      setDecisionLog((prev) =>
        appendDecisionEntry(prev, {
          action: 'apply_territory',
          summary: draftScenario
            ? `Applied territory design → “${draftScenario.name}”`
            : 'Applied territory / coverage network',
          scenarioId: draftScenario?.id,
        }),
      )
    },
    [],
  )

  const setProductCatalog = useCallback(
    (catalog: ProductCatalogId) => {
      setProductMix(switchProductCatalog(network, catalog))
    },
    [network],
  )

  const setProductFilter = useCallback((groupId: ProductGroupId | null) => {
    setProductMix((prev) => ({ ...prev, filterGroupId: groupId }))
  }, [])

  const updateDemandProductShares = useCallback(
    (nodeId: string, shares: Record<ProductGroupId, number>) => {
      setProductMix((prev) => ({
        ...prev,
        demandMix: prev.demandMix.map((d) =>
          d.nodeId === nodeId ? { ...d, shares: { ...shares } } : d,
        ),
      }))
    },
    [],
  )

  const updateLaneProductGroups = useCallback(
    (laneId: string, groupIds: ProductGroupId[]) => {
      setProductMix((prev) => {
        const exists = prev.laneTags.some((l) => l.laneId === laneId)
        const laneTags = exists
          ? prev.laneTags.map((l) =>
              l.laneId === laneId ? { ...l, groupIds: [...groupIds] } : l,
            )
          : [...prev.laneTags, { laneId, groupIds: [...groupIds] }]
        return { ...prev, laneTags }
      })
    },
    [],
  )

  const updateFacilityProductCap = useCallback(
    (nodeId: string, patch: Partial<FacilityProductCap>) => {
      setProductMix((prev) => ({
        ...prev,
        facilityCaps: prev.facilityCaps.map((f) =>
          f.nodeId === nodeId ? { ...f, ...patch } : f,
        ),
      }))
    },
    [],
  )

  const resetProductMix = useCallback(() => {
    setProductMix(defaultProductMix(network, productMix.catalog))
  }, [network, productMix.catalog])


  const setLaneRatesStrategy = useCallback((strategy: BidStrategy) => {
    setLaneRates((prev) => ({ ...prev, compareStrategy: strategy }))
  }, [])

  const updateRateBid = useCallback(
    (
      laneId: string,
      bidId: string,
      patch: Partial<Omit<RateBid, 'id'>>,
    ) => {
      setLaneRates((prev) => updateBidInState(prev, laneId, bidId, patch))
    },
    [],
  )

  const addRateBid = useCallback((laneId: string, bid?: Partial<RateBid>) => {
    setLaneRates((prev) => addBidToLane(prev, laneId, bid))
  }, [])

  const removeRateBid = useCallback((laneId: string, bidId: string) => {
    setLaneRates((prev) => removeBidFromLane(prev, laneId, bidId))
  }, [])

  const applyRateBid = useCallback((laneId: string, bidId: string) => {
    setLaneRates((prev) => {
      const table = prev.tables.find((t) => t.laneId === laneId)
      const bid = table?.bids.find((b) => b.id === bidId)
      if (!bid) return prev
      setNetwork((net) => ({
        ...net,
        lanes: net.lanes.map((l) =>
          l.id === laneId ? applyBidToLane(l, bid, net.nodes) : l,
        ),
      }))
      setDecisionLog((log) =>
        appendDecisionEntry(log, {
          action: 'apply_bids',
          summary: `Applied bid “${bid.carrier}” on lane ${laneId} ($${bid.rate}/${bid.rateUnit})`,
          scenarioId: activeScenarioIdRef.current,
        }),
      )
      return setSelectedBid(prev, laneId, bidId)
    })
  }, [])

  const applyWinningBids = useCallback(
    (strategy?: BidStrategy, laneId?: string): number => {
      const strat = strategy ?? laneRates.compareStrategy
      const targets = laneId
        ? laneRates.tables.filter((t) => t.laneId === laneId)
        : laneRates.tables

      const winners: { laneId: string; bid: RateBid }[] = []
      for (const table of targets) {
        const lane = network.lanes.find((l) => l.id === table.laneId)
        if (!lane || table.bids.length === 0) continue
        const ranked = rankBidsHelper(
          table.bids,
          laneMilesHelper(lane, network.nodes),
          strat,
          table.selectedBidId,
        )
        const win = ranked.find((r) => r.isWinner)
        if (win) winners.push({ laneId: table.laneId, bid: win.bid })
      }
      if (winners.length === 0) return 0

      setNetwork((net) => ({
        ...net,
        lanes: net.lanes.map((l) => {
          const hit = winners.find((w) => w.laneId === l.id)
          return hit ? applyBidToLane(l, hit.bid, net.nodes) : l
        }),
      }))
      setLaneRates((prev) => {
        let next = prev
        if (strategy) next = { ...next, compareStrategy: strategy }
        for (const w of winners) {
          next = setSelectedBid(next, w.laneId, w.bid.id)
        }
        return next
      })
      setDecisionLog((prev) =>
        appendDecisionEntry(prev, {
          action: 'apply_bids',
          summary: `Applied ${winners.length} winning bid(s) (${strat}${laneId ? ` · lane ${laneId}` : ' · all lanes'})`,
          scenarioId: activeScenarioIdRef.current,
        }),
      )
      return winners.length
    },
    [laneRates, network],
  )

  const resetLaneRates = useCallback(() => {
    setLaneRates(defaultLaneRates(network))
  }, [network])

  const updateBomRowCb = useCallback(
    (rowId: string, patch: Partial<Omit<BomRow, 'id'>>) => {
      setBom((prev) => updateBomRow(prev, rowId, patch))
    },
    [],
  )

  const addBomRowCb = useCallback((partial?: Partial<BomRow>) => {
    setBom((prev) => addBomRow(prev, partial))
  }, [])

  const removeBomRowCb = useCallback((rowId: string) => {
    setBom((prev) => removeBomRow(prev, rowId))
  }, [])

  const updateFgShareCb = useCallback(
    (finishedGoodId: string, sharePct: number) => {
      setBom((prev) => updateFgShare(prev, finishedGoodId, sharePct))
    },
    [],
  )

  const setBomHighlightCb = useCallback((on: boolean) => {
    setBom((prev) => setBomHighlight(prev, on))
  }, [])

  const resetBom = useCallback(() => {
    setBom(defaultBom(network))
  }, [network])

  const applyBomInboundScenario = useCallback(
    (scenarioName?: string) => {
      const active = scenarios.find((s) => s.id === activeScenarioId)
      const refKpis = active?.kpis ?? BASELINE_KPIS
      const result = applyBomInboundLanes(bom, network, refKpis, scenarioName)
      setNetwork(result.network)
      setConstraints((prev) => mergeConstraints(prev, result.network))
      setInventoryPolicies((prev) =>
        mergeInventoryPolicies(prev, result.network),
      )
      setProductMix((prev) => mergeProductMix(prev, result.network))
      setLaneRates((prev) => mergeLaneRates(prev, result.network))
      setBom((prev) => mergeBom(prev, result.network))
      setScenarios((prev) => {
        if (prev.some((s) => s.id === result.draftScenario.id)) return prev
        return [...prev, result.draftScenario]
      })
      setActiveScenarioIdState(result.draftScenario.id)
      setSelection({ ids: [], kind: null })
      setDecisionLog((prev) =>
        appendDecisionEntry(prev, {
          action: 'apply_bom',
          summary: `Applied BOM inbound lanes (+${result.preview.newLanes.length}) → “${result.draftScenario.name}”`,
          scenarioId: result.draftScenario.id,
        }),
      )
      return {
        addedLanes: result.preview.newLanes.length,
        scenarioId: result.draftScenario.id,
      }
    },
    [bom, network, scenarios, activeScenarioId],
  )

  const updateBrief = useCallback((patch: Partial<BriefState>) => {

    setBrief((prev) => ({ ...prev, ...patch }))
  }, [])

  const sendBriefToHandoff = useCallback(() => {
    const payload: BriefState = {
      ...brief,
      sentToHandoffAt: new Date().toISOString(),
    }
    setBrief(payload)
    setHandoffPayload(payload)
    setDecisionLog((prev) =>
      appendDecisionEntry(prev, {
        action: 'handoff_export',
        summary: 'Sent Decision Brief to Handoff',
        scenarioId: payload.recommendedScenarioId ?? undefined,
      }),
    )
  }, [brief])


  const updateCapexEventCb = useCallback(
    (id: string, patch: Partial<Omit<CapexEvent, 'id'>>) => {
      setCapexRoadmap((prev) => updateCapexEvent(prev, id, patch))
    },
    [],
  )

  const removeCapexEventCb = useCallback((id: string) => {
    setCapexRoadmap((prev) => removeCapexEvent(prev, id))
  }, [])

  const addCapexRoadmapEvent = useCallback((partial?: Partial<CapexEvent>) => {
    setCapexRoadmap((prev) => addCapexEvent(prev, partial))
  }, [])

  const resetCapexRoadmap = useCallback(() => {
    setCapexRoadmap(defaultCapexRoadmap(network))
  }, [network])

  const applyRoadmapYearSlice = useCallback(
    (throughYear: number, scenarioName?: string): ApplyYearSliceResult | null => {
      const result = applyYearSlice(
        network,
        constraints,
        capexRoadmap,
        throughYear,
        activeScenario.kpis,
        scenarioName,
      )
      setNetwork(result.network)
      setConstraints(result.constraints)
      setInventoryPolicies((prev) => mergeInventoryPolicies(prev, result.network))
      setProductMix((prev) => mergeProductMix(prev, result.network))
      setLaneRates((prev) => mergeLaneRates(prev, result.network))
      setBom((prev) => mergeBom(prev, result.network))
      setSelection({ ids: [], kind: null })
      setScenarios((prev) => {
        if (prev.some((s) => s.id === result.draftScenario.id)) return prev
        return [...prev, result.draftScenario]
      })
      setActiveScenarioIdState(result.draftScenario.id)
      setDecisionLog((prev) =>
        appendDecisionEntry(prev, {
          action: 'apply_roadmap',
          summary: `Applied CapEx roadmap through ${throughYear} → “${result.draftScenario.name}”`,
          scenarioId: result.draftScenario.id,
        }),
      )
      return result
    },
    [network, constraints, capexRoadmap, activeScenario.kpis],
  )

  const exportRoadmapToBrief = useCallback(() => {
    const section = formatRoadmapBriefSection(capexRoadmap, network)
    setBrief((prev) => {
      const notes = prev.notes.trim()
      let merged: string
      if (notes.includes('## CapEx roadmap')) {
        merged = notes.replace(
          /## CapEx roadmap[\s\S]*?(?=\n## |$)/,
          section.trim() + '\n\n',
        )
      } else {
        merged = (notes ? notes + '\n\n' : '') + section
      }
      return {
        ...prev,
        notes: merged.trim() + '\n',
        assumptions: prev.assumptions.map((a) =>
          a.id === 'a3'
            ? {
                ...a,
                checked: false,
                label:
                  'CapEx is overnight build — no phased construction (roadmap in notes)',
              }
            : a,
        ),
      }
    })
    return true
  }, [capexRoadmap, network])


  const runMultiPeriodOptimize = useCallback(
    async (opts?: {
      mode?: MultiPeriodMode
      discountRate?: number
      applyTimingToRoadmap?: boolean
    }): Promise<MultiPeriodOptimizeResult | null> => {
      const mode = opts?.mode ?? 'choose_timing'
      const discountRate = opts?.discountRate ?? 0.1
      const applyTiming = opts?.applyTimingToRoadmap !== false
      setMultiPeriodStatus({ phase: 'running', message: 'Solving multi-period CapEx NPV…' })
      try {
        const apiUp = await checkApiHealth()
        if (!apiUp) {
          setMultiPeriodStatus({
            phase: 'error',
            message: 'Optimize API unreachable — start apps/api on :5182.',
          })
          return null
        }
        const api = await postMultiPeriodOptimize({
          network,
          constraints,
          reference: activeScenario,
          roadmap: {
            baseYearLabel: capexRoadmap.baseYearLabel,
            yearCount: capexRoadmap.yearCount,
            discountRate,
            mode,
            enforceCapexBudget: false,
            events: capexRoadmap.events.map((e) => ({
              id: e.id,
              name: e.name,
              kind: e.kind,
              year: e.year,
              nodeId: e.nodeId,
              nodeName: e.nodeName,
              capexM: e.capexM,
              capacityDelta: e.capacityDelta,
              facilityKind: e.facilityKind,
              region: e.region,
              notes: e.notes,
              earliestYear: mode === 'force_timeline' ? e.year : 0,
              latestYear:
                mode === 'force_timeline' ? e.year : capexRoadmap.yearCount - 1,
              locked: mode === 'force_timeline',
            })),
          },
        })
        const result: MultiPeriodOptimizeResult = {
          ok: api.ok,
          status: api.status,
          mode: String(api.mode),
          discountRate: api.discountRate,
          yearCount: api.yearCount,
          baseYearLabel: api.baseYearLabel,
          solveSeconds: api.solveSeconds,
          npv: api.npv,
          eventTiming: api.eventTiming,
          years: api.years.map((y) => ({
            year: y.year,
            label: y.label,
            yearLabel: y.yearLabel,
            openIds: y.openIds,
            capexM: y.capexM,
            opexM: y.opexM,
            transportM: y.transportM,
            totalCostM: y.totalCostM,
            npvContributionM: y.npvContributionM,
            servicePct: y.servicePct,
            flowsSummary: y.flowsSummary
              ? {
                  arcCount: y.flowsSummary.arcCount,
                  totalVolume: y.flowsSummary.totalVolume,
                }
              : undefined,
          })),
          log: api.log,
          ranAt: new Date().toLocaleString(),
        }
        setMultiPeriodResult(result)
        if (api.ok && applyTiming && api.eventTiming?.length) {
          setCapexRoadmap((prev) =>
            applyEventTimingToRoadmap(
              prev,
              api.eventTiming.map((t) => ({
                eventId: t.eventId,
                year: t.year,
              })),
            ),
          )
        }
        setDecisionLog((prev) =>
          appendDecisionEntry(prev, {
            action: 'optimize_timing',
            summary: api.ok
              ? `Multi-period CapEx NPV $${api.npv.totalM.toFixed(2)}M (${mode}, r=${(discountRate * 100).toFixed(0)}%)`
              : `Multi-period CapEx optimize ${api.status}`,
            scenarioId: activeScenario.id,
          }),
        )
        setMultiPeriodStatus({
          phase: api.ok ? 'done' : 'error',
          message: api.ok
            ? `NPV $${api.npv.totalM.toFixed(2)}M · ${api.eventTiming.length} events · ${api.solveSeconds ?? '?'}s`
            : api.infeasibilityReport?.summary || api.status,
        })
        return result
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        setMultiPeriodStatus({ phase: 'error', message: msg })
        return null
      }
    },
    [network, constraints, capexRoadmap, activeScenario],
  )

  const exportMultiPeriodToBrief = useCallback(() => {
    if (!multiPeriodResult) return false
    const section = formatMultiPeriodBriefSection(multiPeriodResult)
    const roadmapSection = formatRoadmapBriefSection(capexRoadmap, network)
    setBrief((prev) => {
      let notes = prev.notes.trim()
      if (notes.includes('## CapEx multi-period optimize')) {
        notes = notes.replace(
          /## CapEx multi-period optimize[\s\S]*?(?=\n## |$)/,
          section.trim() + '\n\n',
        )
      } else {
        notes = (notes ? notes + '\n\n' : '') + section
      }
      if (notes.includes('## CapEx roadmap')) {
        notes = notes.replace(
          /## CapEx roadmap[\s\S]*?(?=\n## |$)/,
          roadmapSection.trim() + '\n\n',
        )
      } else {
        notes = notes.trim() + '\n\n' + roadmapSection
      }
      return {
        ...prev,
        notes: notes.trim() + '\n',
        assumptions: prev.assumptions.map((a) =>
          a.id === 'a3'
            ? {
                ...a,
                checked: false,
                label:
                  'CapEx is overnight build — no phased construction (roadmap NPV in notes)',
              }
            : a,
        ),
      }
    })
    return true
  }, [multiPeriodResult, capexRoadmap, network])

  const clearMultiPeriodResult = useCallback(() => {
    setMultiPeriodResult(null)
    setMultiPeriodStatus({ phase: 'idle' })
  }, [])

  const runStochasticOptimize = useCallback(
    async (opts?: {
      objective?: StochasticObjective
      cvarAlpha?: number
      scenarios?: StochasticScenarioInput[]
      fromScenarioChips?: Scenario[]
      computeEvpi?: boolean
    }): Promise<StochasticOptimizeResult | null> => {
      const objective = opts?.objective ?? 'expected'
      const cvarAlpha = opts?.cvarAlpha ?? 0.3
      const computeEvpi = opts?.computeEvpi !== false
      let scenarios: StochasticScenarioInput[]
      if (opts?.scenarios && opts.scenarios.length >= 2) {
        scenarios = opts.scenarios.slice(0, 5)
      } else if (opts?.fromScenarioChips && opts.fromScenarioChips.length >= 2) {
        scenarios = shocksFromScenarioChips(opts.fromScenarioChips)
      } else {
        scenarios = DEFAULT_DEMAND_SHOCKS
      }
      setStochasticStatus({
        phase: 'running',
        message: `Solving ${objective} scenario-tree (${scenarios.length} scenarios)…`,
      })
      try {
        const apiUp = await checkApiHealth()
        if (!apiUp) {
          setStochasticStatus({
            phase: 'error',
            message: 'Optimize API unreachable — start apps/api on :5182.',
          })
          return null
        }
        const api = await postStochasticOptimize({
          network,
          constraints,
          reference: activeScenario,
          scenarioTree: {
            objective,
            cvarAlpha: objective === 'cvar_lite' ? cvarAlpha : undefined,
            computeEvpi,
            scenarios,
          },
        })
        const result = apiToStochasticResult(api)
        setStochasticResult(result)
        setDecisionLog((prev) =>
          appendDecisionEntry(prev, {
            action: 'robust_optimize',
            summary: api.ok
              ? `Robust ${objective}: E[cost] $${api.expectedCostM.toFixed(2)}M · worst $${api.worstCostM.toFixed(2)}M · opens ${api.firstStage.openIds.join(',') || '—'}`
              : `Robust optimize ${api.status}`,
            scenarioId: activeScenario.id,
          }),
        )
        setStochasticStatus({
          phase: api.ok ? 'done' : 'error',
          message: api.ok
            ? `E[cost] $${api.expectedCostM.toFixed(2)}M · worst $${api.worstCostM.toFixed(2)}M · ${api.firstStage.openIds.length} opens · ${api.solveSeconds ?? '?'}s`
            : api.infeasibilityReport?.summary || api.status,
        })
        return result
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        setStochasticStatus({ phase: 'error', message: msg })
        return null
      }
    },
    [network, constraints, activeScenario],
  )

  const exportStochasticToBrief = useCallback(() => {
    if (!stochasticResult) return false
    const section = formatStochasticBriefSection(stochasticResult)
    setBrief((prev) => {
      let notes = prev.notes.trim()
      if (notes.includes('## Robust / stochastic optimize')) {
        notes = notes.replace(
          /## Robust \/ stochastic optimize[\s\S]*?(?=\n## |$)/,
          section.trim() + '\n\n',
        )
      } else {
        notes = (notes ? notes + '\n\n' : '') + section
      }
      return { ...prev, notes: notes.trim() + '\n' }
    })
    return true
  }, [stochasticResult])

  const clearStochasticResult = useCallback(() => {
    setStochasticResult(null)
    setStochasticStatus({ phase: 'idle' })
  }, [])

  const value = useMemo<FlowformContextValue>(
    () => ({
      horizon,
      setHorizon,
      scenarios,
      activeScenarioId,
      activeScenario,
      setActiveScenarioId,
      deltas,
      selection,
      selectEntity,
      clearSelection,
      runGreenfield,
      lastCandidates,
      promoteCandidates,
      composeScenario,
      network,
      nodes,
      lanes,
      nodeById,
      loadUploadedNetwork,
      resetToSampleNetwork,
      getEnterprisePack,
      exportEnterprisePackFile,
      importEnterprisePack,
      constraints,
      setConstraints,
      updateFacilityConstraint,
      updateConstraintGlobals,
      optimizeStatus,
      runOptimize,
      brief,
      setBrief,
      updateBrief,
      sendBriefToHandoff,
      handoffPayload,
      emissionFactors,
      setEmissionFactors,
      updateEmissionFactor,
      computedCo2Kt,
      applySensitivityPreset,
      runDesLite,
      runCostSensitivity,
      inventoryPolicies,
      setInventoryFormula,
      updateInventoryNode,
      resetInventoryPolicies,
      applyInventoryToActive,
      runResilience,
      projectMeta,
      projects,
      activeProjectId: projectMeta?.id ?? null,
      projectName: projectMeta?.name ?? DEFAULT_PROJECT_NAME,
      createProject,
      renameProject,
      duplicateProject,
      deleteProject,
      switchProject,
      exportActiveProject,
      importProjectFile,
      refreshProjects,
      comments,
      addScenarioComment,
      deleteScenarioComment,
      decisionLog,
      logDecision,
      clearDecisionLog,
      updateLaneMode,
      shareProject,
      applyMergedNetwork,
      applyHubSpokeNetwork,
      applyTerritoryNetwork,
      productMix,
      setProductCatalog,
      setProductFilter,
      updateDemandProductShares,
      updateLaneProductGroups,
      updateFacilityProductCap,
      resetProductMix,
      laneRates,
      setLaneRatesStrategy,
      updateRateBid,
      addRateBid,
      removeRateBid,
      applyRateBid,
      applyWinningBids,
      resetLaneRates,
      bom,
      updateBomRow: updateBomRowCb,
      addBomRow: addBomRowCb,
      removeBomRow: removeBomRowCb,
      updateFgShare: updateFgShareCb,
      setBomHighlight: setBomHighlightCb,
      resetBom,
      applyBomInboundScenario,
      capexRoadmap,
      setCapexRoadmap,
      updateCapexEvent: updateCapexEventCb,
      removeCapexEvent: removeCapexEventCb,
      addCapexRoadmapEvent,
      resetCapexRoadmap,
      applyRoadmapYearSlice,
      exportRoadmapToBrief,
      multiPeriodResult,
      multiPeriodStatus,
      runMultiPeriodOptimize,
      exportMultiPeriodToBrief,
      clearMultiPeriodResult,
      stochasticResult,
      stochasticStatus,
      runStochasticOptimize,
      exportStochasticToBrief,
      clearStochasticResult,
    }),
    [
      horizon,
      scenarios,
      activeScenarioId,
      activeScenario,
      deltas,
      selection,
      selectEntity,
      clearSelection,
      runGreenfield,
      lastCandidates,
      promoteCandidates,
      composeScenario,
      network,
      nodes,
      lanes,
      nodeById,
      loadUploadedNetwork,
      resetToSampleNetwork,
      getEnterprisePack,
      exportEnterprisePackFile,
      importEnterprisePack,
      constraints,
      updateFacilityConstraint,
      updateConstraintGlobals,
      optimizeStatus,
      runOptimize,
      brief,
      updateBrief,
      sendBriefToHandoff,
      handoffPayload,
      emissionFactors,
      updateEmissionFactor,
      computedCo2Kt,
      applySensitivityPreset,
      runDesLite,
      runCostSensitivity,
      inventoryPolicies,
      setInventoryFormula,
      updateInventoryNode,
      resetInventoryPolicies,
      applyInventoryToActive,
      runResilience,
      projectMeta,
      projects,
      createProject,
      renameProject,
      duplicateProject,
      deleteProject,
      switchProject,
      exportActiveProject,
      importProjectFile,
      refreshProjects,
      comments,
      addScenarioComment,
      deleteScenarioComment,
      decisionLog,
      logDecision,
      clearDecisionLog,
      updateLaneMode,
      shareProject,
      applyMergedNetwork,
      applyHubSpokeNetwork,
      applyTerritoryNetwork,
      productMix,
      setProductCatalog,
      setProductFilter,
      updateDemandProductShares,
      updateLaneProductGroups,
      updateFacilityProductCap,
      resetProductMix,
      laneRates,
      setLaneRatesStrategy,
      updateRateBid,
      addRateBid,
      removeRateBid,
      applyRateBid,
      applyWinningBids,
      resetLaneRates,
      bom,
      updateBomRowCb,
      addBomRowCb,
      removeBomRowCb,
      updateFgShareCb,
      setBomHighlightCb,
      resetBom,
      applyBomInboundScenario,
      capexRoadmap,
      updateCapexEventCb,
      removeCapexEventCb,
      addCapexRoadmapEvent,
      resetCapexRoadmap,
      applyRoadmapYearSlice,
      exportRoadmapToBrief,
      multiPeriodResult,
      multiPeriodStatus,
      runMultiPeriodOptimize,
      exportMultiPeriodToBrief,
      clearMultiPeriodResult,
      stochasticResult,
      stochasticStatus,
      runStochasticOptimize,
      exportStochasticToBrief,
      clearStochasticResult,
    ],
  )

  // silence unused persistNow (available for explicit flush)
  void persistNow

  return (
    <FlowformContext.Provider value={value}>{children}</FlowformContext.Provider>
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function useFlowform(): FlowformContextValue {
  const ctx = useContext(FlowformContext)
  if (!ctx) {
    throw new Error('useFlowform must be used within FlowformProvider')
  }
  return ctx
}
