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
  type ApiOptimizeResponse,
} from '../data/optimizeApi'
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
import {
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
  addComment,
  deleteComment,
  buildSharePack,
  copyShareDeepLink,
  downloadSharePack,
  type ScenarioComment,
  type SharePack,
} from '../data/collaboration'
import { applyLaneModeChange, emissionModeKey } from '../data/modeMix'
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
  const [activeScenarioId, setActiveScenarioId] = useState(
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
  const [productMix, setProductMix] = useState<ProductMixState>(
    () => mergeProductMix(boot.snap.productMix, boot.snap.network),
  )
  const optimizeLock = useRef(false)
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const skipPersist = useRef(true)

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
  ])

  const applySnapshot = useCallback((snap: ProjectSnapshot) => {
    skipPersist.current = true
    setHorizon(snap.horizon)
    setScenarios(snap.scenarios)
    setActiveScenarioId(snap.activeScenarioId)
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
    setProductMix(mergeProductMix(snap.productMix, snap.network))
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
      setActiveScenarioId(scenario.id)
      return scenario
    },
    [scenarios, deltas],
  )

  const loadUploadedNetwork = useCallback((net: UploadedNetwork) => {
    setNetwork(net)
    setConstraints((prev) => mergeConstraints(prev, net))
    setInventoryPolicies((prev) => mergeInventoryPolicies(prev, net))
    setProductMix((prev) => mergeProductMix(prev, net))
    setSelection({ ids: [], kind: null })
  }, [])

  const resetToSampleNetwork = useCallback(() => {
    const sample = sampleUploadedNetwork()
    setNetwork(sample)
    setConstraints(defaultConstraintsFromNetwork(sample))
    setInventoryPolicies(defaultInventoryPolicies(sample))
    setProductMix(defaultProductMix(sample))
    setSelection({ ids: [], kind: null })
  }, [])

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
      setActiveScenarioId(scenario.id)
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

  const applyOptimizeResult = useCallback(
    (args: {
      openedIds: string[]
      closedIds: string[]
      servicePct: number
      capexUsedM: number
      heuristic: string
      flows?: ApiOptimizeResponse['flows']
      log: string[]
      name: string
      kpis: Scenario['kpis']
      statusMessage: string
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

      setScenarios((prev) => [...prev, scenario])
      setActiveScenarioId(scenario.id)
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
      })
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

      if (apiUp) {
        setOptimizeStatus({
          phase: 'running',
          progress: 35,
          message: 'API available — running PuLP MIP…',
        })
        try {
          const api = await postOptimize({
            network,
            constraints,
            reference,
          })
          setOptimizeStatus({
            phase: 'running',
            progress: 85,
            message: `Packaging ${api.solver} result…`,
          })
          await sleep(120)
          return applyOptimizeResult({
            openedIds: api.openedIds,
            closedIds: api.closedIds,
            servicePct: api.kpis.servicePct,
            capexUsedM: api.kpis.capexUsedM,
            heuristic: api.solver,
            flows: api.flows,
            log: api.log,
            name: `Optimize MIP ${new Date().toLocaleTimeString()}`,
            kpis: kpisFromApi(api, reference),
            statusMessage: `API ${api.solver} · ${api.status} · service ${api.kpis.servicePct.toFixed(1)}%`,
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
  }, [scenarios, network, constraints, applyOptimizeResult])

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
      setSelection({ ids: [], kind: null })
      if (draftScenario) {
        setScenarios((prev) => {
          if (prev.some((s) => s.id === draftScenario.id)) return prev
          return [...prev, draftScenario]
        })
        setActiveScenarioId(draftScenario.id)
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
      setSelection({ ids: [], kind: null })
      if (draftScenario) {
        setScenarios((prev) => {
          if (prev.some((s) => s.id === draftScenario.id)) return prev
          return [...prev, draftScenario]
        })
        setActiveScenarioId(draftScenario.id)
      }
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
  }, [brief])

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
      updateLaneMode,
      shareProject,
      applyMergedNetwork,
      applyHubSpokeNetwork,
      productMix,
      setProductCatalog,
      setProductFilter,
      updateDemandProductShares,
      updateLaneProductGroups,
      updateFacilityProductCap,
      resetProductMix,
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
      updateLaneMode,
      shareProject,
      applyMergedNetwork,
      applyHubSpokeNetwork,
      productMix,
      setProductCatalog,
      setProductFilter,
      updateDemandProductShares,
      updateLaneProductGroups,
      updateFacilityProductCap,
      resetProductMix,
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
