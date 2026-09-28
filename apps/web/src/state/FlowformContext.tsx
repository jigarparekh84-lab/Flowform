import {
  createContext,
  useCallback,
  useContext,
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

export type SelectKind = 'node' | 'lane'

export type SelectionState = {
  ids: string[]
  kind: SelectKind | null
}

const DEFAULT_ASSUMPTIONS: AssumptionItem[] = [
  { id: 'a1', label: 'Demand is FY27 steady-state (no promotional spikes)', checked: true },
  { id: 'a2', label: 'Service radius uses Euclidean miles on canvas map', checked: true },
  { id: 'a3', label: 'CapEx is overnight build — no phased construction', checked: true },
  { id: 'a4', label: 'Optimize is heuristic v1 (greedy), not a full MIP', checked: true },
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

  /** Active network (sample or uploaded). */
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
  /** Network CO₂ (kt) from lane miles × mode factors when distances present. */
  computedCo2Kt: number

  applySensitivityPreset: (presetId: SensitivityPresetId) => Scenario | null
}

const FlowformContext = createContext<FlowformContextValue | null>(null)

function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

export function FlowformProvider({ children }: { children: ReactNode }) {
  const [horizon, setHorizon] =
    useState<(typeof HORIZON_OPTIONS)[number]>('FY27')
  const [scenarios, setScenarios] = useState<Scenario[]>(INITIAL_SCENARIOS)
  const [activeScenarioId, setActiveScenarioId] = useState(
    INITIAL_SCENARIOS[0].id,
  )
  const [deltas, setDeltas] = useState<DeltaItem[]>([])
  const [selection, setSelection] = useState<SelectionState>({
    ids: [],
    kind: null,
  })
  const [lastCandidates, setLastCandidates] = useState<CandidateSite[]>([])
  const [lastParams, setLastParams] = useState<GreenfieldParams | null>(null)

  const initialNet = useMemo(() => sampleUploadedNetwork(), [])
  const [network, setNetwork] = useState<UploadedNetwork>(initialNet)
  const [constraints, setConstraints] = useState<NetworkConstraints>(() =>
    defaultConstraintsFromNetwork(initialNet),
  )
  const [optimizeStatus, setOptimizeStatus] = useState<OptimizeRunStatus>({
    phase: 'idle',
  })
  const [brief, setBrief] = useState<BriefState>(() =>
    defaultBrief(INITIAL_SCENARIOS),
  )
  const [handoffPayload, setHandoffPayload] = useState<BriefState | null>(null)
  const [emissionFactors, setEmissionFactors] = useState<EmissionFactor[]>(
    DEFAULT_EMISSION_FACTORS,
  )
  const optimizeLock = useRef(false)

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

      // Register candidates into network + constraints so Optimize can open them
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
    setSelection({ ids: [], kind: null })
  }, [])

  const resetToSampleNetwork = useCallback(() => {
    const sample = sampleUploadedNetwork()
    setNetwork(sample)
    setConstraints(defaultConstraintsFromNetwork(sample))
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
        mode: lane.mode,
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
      // Lightly adjust CO₂ KPI from factors when fuel preset
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

  const runOptimize = useCallback(async (): Promise<Scenario | null> => {
    if (optimizeLock.current) return null
    optimizeLock.current = true
    try {
      setOptimizeStatus({
        phase: 'running',
        progress: 8,
        message: 'Heuristic v1 — seeding open facilities…',
      })
      await sleep(280)
      setOptimizeStatus({
        phase: 'running',
        progress: 32,
        message: 'Scoring candidates under CapEx + service radius…',
      })
      await sleep(320)
      setOptimizeStatus({
        phase: 'running',
        progress: 58,
        message: 'Greedy open / soft-close pass…',
      })
      await sleep(300)

      const reference =
        scenarios.find((s) => s.id === 'baseline') ?? scenarios[0]
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
      await sleep(220)

      const scenario: Scenario = {
        id: uid('opt'),
        name: result.scenario.name,
        tag: result.scenario.tag,
        baseId: result.scenario.baseId,
        kpis: result.scenario.kpis,
        optimizeMeta: result.scenario.optimizeMeta,
      }

      // Apply open/close to constraints for map fidelity
      setConstraints((prev) => ({
        ...prev,
        facilities: prev.facilities.map((f) => {
          if (result.openedIds.includes(f.nodeId)) {
            return { ...f, status: 'open' as const }
          }
          if (result.closedIds.includes(f.nodeId)) {
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
        message: `Optimize complete · ${scenario.name} · service ${result.servicePct.toFixed(1)}%`,
        log: result.log,
      })
      return scenario
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Optimize failed unexpectedly'
      setOptimizeStatus({ phase: 'error', message })
      return null
    } finally {
      optimizeLock.current = false
    }
  }, [scenarios, network, constraints])

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
    ],
  )

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
