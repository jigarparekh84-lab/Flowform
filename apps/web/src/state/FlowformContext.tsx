import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import {
  HORIZON_OPTIONS,
  INITIAL_SCENARIOS,
  generateCandidates,
  kpisForComposedScenario,
  type CandidateSite,
  type DeltaItem,
  type GreenfieldParams,
  type Scenario,
} from '../data/sampleNetwork'

export type SelectKind = 'node' | 'lane'

export type SelectionState = {
  ids: string[]
  kind: SelectKind | null
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
  /** Click / table select. Pass additive=true for Shift-click multi-select. */
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

  const activeScenario = useMemo(
    () => scenarios.find((s) => s.id === activeScenarioId) ?? scenarios[0],
    [scenarios, activeScenarioId],
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
    ],
  )

  return (
    <FlowformContext.Provider value={value}>{children}</FlowformContext.Provider>
  )
}

export function useFlowform(): FlowformContextValue {
  const ctx = useContext(FlowformContext)
  if (!ctx) {
    throw new Error('useFlowform must be used within FlowformProvider')
  }
  return ctx
}
