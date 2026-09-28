import { useEffect, useMemo, useState } from 'react'
import { CommentsPanel } from './CommentsPanel'
import { DecisionLogPanel } from './DecisionLogPanel'
import { EmptyState } from './ui/EmptyState'
import { RoomHeader } from './ui/RoomHeader'
import {
  computeCostToServe,
  ctsByRegion,
  type CtsRow,
} from '../data/costToServe'
import { summarizeModeMix } from '../data/modeMix'
import {
  bidCompareRollup,
  strategyLabel,
  summarizeLaneBids,
  type BidStrategy,
} from '../data/laneRates'
import {
  computeInventoryRollup,
  formatInvDollars,
  formatInvUnits,
  type SafetyStockFormula,
} from '../data/inventoryPolicy'
import {
  scoreResilience,
  type CriticalNode,
  type ResilienceResult,
} from '../data/resilience'
import {
  LANES,
  NODES,
  mapDiffForScenario,
  parseMoneyM,
  waterfallForScenario,
  type KpiSnapshot,
  type MapDiffMark,
  type Scenario,
  type WaterfallStep,
} from '../data/sampleNetwork'
import {
  catalogLabel,
  rollupByProductGroup,
} from '../data/productGroups'
import {
  bomRollup,
  componentKindLabel,
  deriveEchelonFlows,
  deriveImpliedRmDemand,
  previewBomInboundLanes,
} from '../data/bom'
import {
  applyTerritoryDesign,
  previewTerritory,
  suggestServingIds,
  type TerritoryAssignMode,
} from '../data/serviceTerritory'
import {
  COST_DRIVERS,
  defaultDriverRanges,
  rangesFromPresetHint,
  type CostDriverId,
  type CostSensitivityResult,
} from '../data/costSensitivity'
import { useFlowform } from '../state/FlowformContext'

type ViewMode =
  | 'matrix'
  | 'map'
  | 'waterfall'
  | 'cts'
  | 'des'
  | 'sensitivity'
  | 'inventory'
  | 'resilience'
  | 'modes'
  | 'products'
  | 'bids'
  | 'bom'
  | 'territory'

const KPI_ROWS: { key: keyof KpiSnapshot; label: string }[] = [
  { key: 'cost', label: 'Cost' },
  { key: 'service', label: 'Service' },
  { key: 'capex', label: 'CapEx' },
  { key: 'co2', label: 'CO₂' },
  { key: 'risk', label: 'Risk' },
  { key: 'inventory', label: 'Inv $' },
  { key: 'invUnits', label: 'Inv units' },
]

const MAX_SCENARIOS = 5

function defaultSelection(
  scenarios: Scenario[],
  activeId: string,
): string[] {
  const ids: string[] = []
  const active = scenarios.find((s) => s.id === activeId)
  const baseline = scenarios.find((s) => s.id === 'baseline')
  if (baseline) ids.push(baseline.id)
  if (active && active.id !== 'baseline') ids.push(active.id)
  if (ids.length < 2) {
    for (const s of scenarios) {
      if (!ids.includes(s.id)) {
        ids.push(s.id)
        if (ids.length >= 2) break
      }
    }
  }
  return ids.slice(0, MAX_SCENARIOS)
}

function deltaVsReference(
  value: string,
  refValue: string,
  key: keyof KpiSnapshot,
  better: boolean,
): { text: string; tone: 'up' | 'down' | 'neutral' } {
  if (value === refValue) return { text: '—', tone: 'neutral' }

  if (key === 'risk') {
    return {
      text: better ? '↓ vs ref' : '↑ vs ref',
      tone: better ? 'up' : 'down',
    }
  }

  if (key === 'cost' || key === 'capex' || key === 'co2') {
    const a = parseMoneyM(value)
    const b = parseMoneyM(refValue)
    // co2 uses "kt" — parseMoneyM still extracts the number
    const diff = a - b
    if (Math.abs(diff) < 0.05) return { text: '—', tone: 'neutral' }
    const sign = diff > 0 ? '+' : '−'
    const unit = key === 'co2' ? ' kt' : 'M'
    const abs = Math.abs(diff).toFixed(1)
    const prefix = key === 'co2' ? '' : key === 'capex' || key === 'cost' ? '$' : ''
    return {
      text: `${sign}${prefix}${abs}${unit}`,
      tone: better ? 'up' : 'down',
    }
  }

  // service %
  const a = parseFloat(value)
  const b = parseFloat(refValue)
  const diff = a - b
  if (Number.isNaN(diff) || Math.abs(diff) < 0.05) {
    return { text: '—', tone: 'neutral' }
  }
  const sign = diff > 0 ? '+' : '−'
  return {
    text: `${sign}${Math.abs(diff).toFixed(1)}pp`,
    tone: better ? 'up' : 'down',
  }
}

function bezier(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): string {
  const mx = (x1 + x2) / 2
  const my = (y1 + y2) / 2
  const dx = x2 - x1
  const dy = y2 - y1
  const cx = mx - dy * 0.18
  const cy = my + dx * 0.18
  return `M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`
}

export function CompareResults() {
  const {
    scenarios,
    activeScenarioId,
    activeScenario,
    deltas,
    nodes,
    lanes,
    network,
    constraints,
    runDesLite,
    runCostSensitivity,
    inventoryPolicies,
    setInventoryFormula,
    updateInventoryNode,
    resetInventoryPolicies,
    applyInventoryToActive,
    runResilience,
    emissionFactors,
    productMix,
    setProductFilter,
    laneRates,
    setLaneRatesStrategy,
    applyWinningBids,
    applyRateBid,
    bom,
    applyBomInboundScenario,
    applyTerritoryNetwork,
  } = useFlowform()

  const [selectedIds, setSelectedIds] = useState<string[]>(() =>
    defaultSelection(scenarios, activeScenarioId),
  )
  const [referenceId, setReferenceId] = useState('baseline')
  const [view, setView] = useState<ViewMode>('matrix')
  const [focusId, setFocusId] = useState<string>(activeScenarioId)

  // Keep selection in sync when scenarios / active change (e.g. composed).
  useEffect(() => {
    setSelectedIds((prev) => {
      const still = prev.filter((id) => scenarios.some((s) => s.id === id))
      if (still.length >= 2) return still
      return defaultSelection(scenarios, activeScenarioId)
    })
  }, [scenarios, activeScenarioId])

  useEffect(() => {
    if (!scenarios.some((s) => s.id === referenceId)) {
      setReferenceId(
        scenarios.find((s) => s.id === 'baseline')?.id ?? scenarios[0]?.id ?? '',
      )
    }
  }, [scenarios, referenceId])

  useEffect(() => {
    if (!selectedIds.includes(focusId)) {
      const alt = selectedIds.find((id) => id !== referenceId) ?? selectedIds[0]
      if (alt) setFocusId(alt)
    }
  }, [selectedIds, focusId, referenceId])

  const selected = useMemo(
    () =>
      selectedIds
        .map((id) => scenarios.find((s) => s.id === id))
        .filter((s): s is Scenario => !!s),
    [selectedIds, scenarios],
  )

  const reference =
    scenarios.find((s) => s.id === referenceId) ?? scenarios[0]

  const focus =
    scenarios.find((s) => s.id === focusId) ??
    selected.find((s) => s.id !== referenceId) ??
    selected[0]

  function toggleScenario(id: string) {
    setSelectedIds((prev) => {
      if (prev.includes(id)) {
        if (prev.length <= 1) return prev
        return prev.filter((x) => x !== id)
      }
      if (prev.length >= MAX_SCENARIOS) return prev
      return [...prev, id]
    })
  }

  const marks: MapDiffMark[] = useMemo(() => {
    if (!focus || !reference) return []
    return mapDiffForScenario(focus, deltas, reference.id)
  }, [focus, deltas, reference])

  const waterfall: WaterfallStep[] = useMemo(() => {
    if (!focus || !reference) return []
    return waterfallForScenario(focus, reference)
  }, [focus, reference])

  const cts = useMemo(() => {
    if (!focus) return null
    return computeCostToServe({
      scenario: focus,
      nodes: nodes.length ? nodes : NODES,
      lanes: lanes.length ? lanes : LANES,
      demandVolume: network.demandVolume,
    })
  }, [focus, nodes, lanes, network.demandVolume])

  const modeMix = useMemo(
    () =>
      summarizeModeMix(
        lanes.length ? lanes : LANES,
        nodes.length ? nodes : NODES,
        emissionFactors,
      ),
    [lanes, nodes, emissionFactors],
  )

  return (
    <div className="studio-room compare-results">
      <RoomHeader
        className="compare-header"
        kicker="Compare"
        title="Results"
        tip="Side-by-side KPIs, map diffs, and sensitivity vs a Reference scenario (defaults: Active + Baseline)."
      />

      {scenarios.length < 2 ? (
        <EmptyState
          title="Need another scenario"
          body="Compose or promote a what-if in Scenarios, then return here to compare against Baseline."
        />
      ) : null}

      <div className="compare-toolbar">
        <div className="compare-picks" aria-label="Scenarios to compare">
          <span className="toolbar-label">Scenarios</span>
          <div className="scenario-chips">
            {scenarios.map((s) => {
              const on = selectedIds.includes(s.id)
              const isRef = s.id === referenceId
              const isActive = s.id === activeScenarioId
              return (
                <button
                  key={s.id}
                  type="button"
                  className={`scenario-chip${on ? ' on' : ''}${isRef ? ' ref' : ''}`}
                  onClick={() => toggleScenario(s.id)}
                  title={
                    on
                      ? 'Remove from compare'
                      : selectedIds.length >= MAX_SCENARIOS
                        ? `Max ${MAX_SCENARIOS}`
                        : 'Add to compare'
                  }
                  disabled={!on && selectedIds.length >= MAX_SCENARIOS}
                >
                  {s.name}
                  {isActive && <em>Active</em>}
                  {isRef && <em className="ref-tag">Ref</em>}
                </button>
              )
            })}
          </div>
          <span className="muted tiny">
            {selectedIds.length}/{MAX_SCENARIOS}
          </span>
        </div>

        <label className="field compare-ref">
          <span>Reference</span>
          <select
            value={referenceId}
            onChange={(e) => setReferenceId(e.target.value)}
          >
            {scenarios.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>

        <div className="view-tabs" role="tablist" aria-label="Compare view">
          {(
            [
              ['matrix', 'Matrix'],
              ['map', 'Map diff'],
              ['waterfall', 'Waterfall'],
              ['cts', 'Cost-to-serve'],
              ['des', 'DES-lite'],
              ['sensitivity', 'Sensitivity'],
              ['inventory', 'Inventory'],
              ['resilience', 'Resilience'],
              ['modes', 'Mode mix'],
              ['products', 'Products'],
              ['bids', 'Bids'],
              ['bom', 'BOM'],
              ['territory', 'Territory'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={view === id}
              className={view === id ? 'view-tab on' : 'view-tab'}
              onClick={() => setView(id)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="compare-body">
        {view === 'matrix' && reference && (
          <MatrixView
            selected={selected}
            reference={reference}
          />
        )}
        {view === 'map' && focus && reference && (
          <MapDiffView
            focus={focus}
            reference={reference}
            selected={selected}
            focusId={focusId}
            onFocus={setFocusId}
            marks={marks}
          />
        )}
        {view === 'waterfall' && focus && reference && (
          <WaterfallView
            focus={focus}
            reference={reference}
            selected={selected}
            focusId={focusId}
            onFocus={setFocusId}
            steps={waterfall}
          />
        )}
        {view === 'cts' && focus && cts && (
          <CtsView
            focus={focus}
            selected={selected}
            focusId={focusId}
            onFocus={setFocusId}
            rows={cts.rows}
            steps={cts.waterfall}
            totalM={cts.totalM}
          />
        )}
        {view === 'des' && (
          <DesLiteView
            active={activeScenario}
            selected={selected}
            onRun={() => runDesLite()}
          />
        )}
        {view === 'sensitivity' && (
          <CostSensitivityView
            active={activeScenario}
            selected={selected}
            onRun={(params) => runCostSensitivity(params)}
          />
        )}
        {view === 'inventory' && (
          <InventoryView
            active={activeScenario}
            formula={inventoryPolicies.formula}
            onFormula={setInventoryFormula}
            onUpdateNode={updateInventoryNode}
            onReset={resetInventoryPolicies}
            onApply={() => applyInventoryToActive()}
            rollup={computeInventoryRollup(inventoryPolicies, network)}
          />
        )}
        {view === 'resilience' && (
          <ResilienceView
            active={activeScenario}
            onRun={(thr) => runResilience(thr)}
            thresholdDefault={constraints.serviceTargetPct}
            liveResult={
              activeScenario.resilience
                ? scoreResilience({
                    network,
                    constraints,
                    scenario: activeScenario,
                    thresholdPct: activeScenario.resilience.thresholdPct,
                  })
                : null
            }
          />
        )}
        {view === 'modes' && (
          <ModeMixView rows={modeMix} />
        )}
        {view === 'products' && (
          <ProductsView
            productMix={productMix}
            network={network}
            kpis={focus?.kpis ?? activeScenario.kpis}
            onFilter={setProductFilter}
          />
        )}
        {view === 'bids' && (
          <BidsView
            network={network}
            laneRates={laneRates}
            onStrategy={setLaneRatesStrategy}
            onApplyAll={() => applyWinningBids()}
            onApplyBid={applyRateBid}
          />
        )}
        {view === 'bom' && (
          <BomView
            bom={bom}
            network={network}
            kpis={focus?.kpis ?? activeScenario.kpis}
            onDraftInbound={() => applyBomInboundScenario()}
          />
        )}
        {view === 'territory' && (
          <TerritoryView
            network={network}
            kpis={focus?.kpis ?? activeScenario.kpis}
            applyTerritoryNetwork={applyTerritoryNetwork}
          />
        )}
      </div>

      <div className="compare-comments-wrap">
        <CommentsPanel scenarioId={focus?.id ?? activeScenarioId} compact />
        <DecisionLogPanel compact />
      </div>
    </div>
  )
}

function MatrixView({
  selected,
  reference,
}: {
  selected: Scenario[]
  reference: Scenario
}) {
  if (selected.length === 0) {
    return (
      <EmptyState
        title="No scenarios selected"
        body="Pick at least one scenario chip above to populate the KPI matrix."
      />
    )
  }

  const withBreakdown = selected.filter((s) => s.optimizeMeta?.objectiveBreakdown)

  return (
    <div className="compare-matrix-wrap">
      {withBreakdown.length > 0 && (
        <section className="library-card" aria-label="MIP objective breakdown" style={{ marginBottom: '1rem' }}>
          <h2>Optimize objective breakdown</h2>
          <p className="muted tiny">
            Fixed-charge multi-echelon MIP cost stack (transport + CapEx + OpEx + uncovered penalty).
          </p>
          <table className="compare-matrix modes-table">
            <thead>
              <tr>
                <th scope="col">Scenario</th>
                <th scope="col">Total</th>
                <th scope="col">Transport</th>
                <th scope="col">CapEx</th>
                <th scope="col">OpEx</th>
                <th scope="col">Uncovered pen.</th>
                <th scope="col">Open sites</th>
                <th scope="col">Model</th>
              </tr>
            </thead>
            <tbody>
              {withBreakdown.map((s) => {
                const bd = s.optimizeMeta!.objectiveBreakdown!
                const keptHint = s.optimizeMeta
                  ? `${(s.optimizeMeta.openFacilities ?? []).length || '—'} fac`
                  : '—'
                return (
                  <tr key={s.id}>
                    <td>
                      <strong>{s.name}</strong>
                    </td>
                    <td>${bd.totalM.toFixed(2)}M</td>
                    <td>${bd.transportM.toFixed(2)}M</td>
                    <td>${bd.fixedCapexM.toFixed(1)}M</td>
                    <td>${bd.fixedOpexM.toFixed(1)}M</td>
                    <td>${bd.uncoveredPenaltyM.toFixed(2)}M</td>
                    <td>{keptHint}</td>
                    <td className="muted tiny">
                      {s.optimizeMeta?.model ?? s.optimizeMeta?.heuristic ?? '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {withBreakdown.some((s) => (s.optimizeMeta?.shadowPrices ?? []).some((p) => p.binding)) && (
            <p className="muted tiny" style={{ marginTop: '0.5rem' }}>
              Binding capacity duals:{' '}
              {withBreakdown
                .flatMap((s) =>
                  (s.optimizeMeta?.shadowPrices ?? [])
                    .filter((p) => p.binding)
                    .map(
                      (p) =>
                        `${p.facilityId} (π=${p.shadowPrice.toFixed(4)})`,
                    ),
                )
                .slice(0, 8)
                .join(' · ') || '—'}
            </p>
          )}
        </section>
      )}
      <table className="compare-matrix">
        <thead>
          <tr>
            <th scope="col">KPI</th>
            {selected.map((s) => (
              <th
                key={s.id}
                scope="col"
                className={s.id === reference.id ? 'is-ref' : undefined}
              >
                {s.name}
                {s.id === reference.id && (
                  <span className="th-tag">Reference</span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {KPI_ROWS.filter((row) =>
            selected.some((s) => s.kpis[row.key] != null) ||
            reference.kpis[row.key] != null ||
            (row.key !== 'inventory' && row.key !== 'invUnits'),
          ).map(({ key, label }) => (
            <tr key={key}>
              <th scope="row">{label}</th>
              {selected.map((s) => {
                const cell = s.kpis[key]
                const isRef = s.id === reference.id
                if (!cell) {
                  return (
                    <td key={s.id} className={isRef ? 'is-ref' : undefined}>
                      <div className="matrix-cell">
                        <strong className="muted">—</strong>
                        <span className="kpi-delta neutral">—</span>
                      </div>
                    </td>
                  )
                }
                const refCell = reference.kpis[key]
                const d = isRef || !refCell
                  ? { text: '—', tone: 'neutral' as const }
                  : deltaVsReference(
                      cell.value,
                      refCell.value,
                      key,
                      cell.better,
                    )
                return (
                  <td key={s.id} className={isRef ? 'is-ref' : undefined}>
                    <div className="matrix-cell">
                      <strong>{cell.value}</strong>
                      <span className={`kpi-delta ${d.tone}`}>{d.text}</span>
                    </div>
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted tiny matrix-footnote">
        Deltas are computed vs Reference ({reference.name}). Green = better
        direction for that KPI; red = worse.
      </p>
    </div>
  )
}

function MapDiffView({
  focus,
  reference,
  selected,
  focusId,
  onFocus,
  marks,
}: {
  focus: Scenario
  reference: Scenario
  selected: Scenario[]
  focusId: string
  onFocus: (id: string) => void
  marks: MapDiffMark[]
}) {
  const nodeMap = useMemo(() => new Map(NODES.map((n) => [n.id, n])), [])

  return (
    <div className="compare-map-layout">
      <aside className="compare-side">
        <h2>Focus scenario</h2>
        <div className="focus-list">
          {selected.map((s) => (
            <button
              key={s.id}
              type="button"
              className={
                s.id === focusId ? 'btn primary focus-btn' : 'btn ghost focus-btn'
              }
              onClick={() => onFocus(s.id)}
            >
              {s.name}
            </button>
          ))}
        </div>
        <p className="hint">
          Showing opens / closes / flow accents for{' '}
          <strong>{focus.name}</strong> vs <strong>{reference.name}</strong>.
        </p>
        <ul className="diff-legend">
          <li>
            <i className="lg open" /> Open (promoted / new site)
          </li>
          <li>
            <i className="lg close" /> Close / at-risk
          </li>
          <li>
            <i className="lg flow-up" /> Flow +
          </li>
          <li>
            <i className="lg flow-down" /> Flow −
          </li>
        </ul>
        <ul className="diff-list">
          {marks.length === 0 ? (
            <li className="muted">No diff vs Reference (same scenario).</li>
          ) : (
            marks.map((m) => (
              <li key={m.id}>
                <span className={`diff-kind ${m.kind}`}>{m.kind}</span>
                {m.label}
              </li>
            ))
          )}
        </ul>
      </aside>

      <div className="map-stage compare-map-stage">
        <svg
          className="network-svg"
          viewBox="0 0 100 100"
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label={`Map diff ${focus.name} vs ${reference.name}`}
        >
          <defs>
            <radialGradient id="cmpGlow" cx="50%" cy="45%" r="55%">
              <stop offset="0%" stopColor="var(--ff-map-glow-0)" />
              <stop offset="100%" stopColor="var(--ff-map-glow-1)" />
            </radialGradient>
            <pattern
              id="cmpGrid"
              width="5"
              height="5"
              patternUnits="userSpaceOnUse"
            >
              <path
                d="M 5 0 L 0 0 0 5"
                fill="none"
                stroke="var(--ff-map-grid)"
                strokeWidth="0.15"
              />
            </pattern>
          </defs>
          <rect width="100" height="100" fill="url(#cmpGlow)" />
          <rect width="100" height="100" fill="url(#cmpGrid)" />
          <path
            d="M12 40 C18 28, 30 24, 42 26 C52 22, 62 24, 72 30 C82 28, 90 34, 92 44 C94 55, 88 66, 78 70 C68 78, 52 80, 40 74 C28 78, 18 70, 14 58 Z"
            fill="var(--ff-map-land)"
            stroke="var(--ff-map-land-stroke)"
            strokeWidth="0.3"
          />

          {LANES.map((lane) => {
            const a = nodeMap.get(lane.from)
            const b = nodeMap.get(lane.to)
            if (!a || !b) return null
            return (
              <path
                key={lane.id}
                d={bezier(a.x, a.y, b.x, b.y)}
                fill="none"
                stroke="var(--ff-lane-dim)"
                strokeWidth="0.3"
                strokeLinecap="round"
              />
            )
          })}

          {NODES.map((node) => (
            <g
              key={node.id}
              transform={`translate(${node.x} ${node.y})`}
              opacity="0.55"
            >
              <circle
                r="1.6"
                fill="var(--ff-node-fill)"
                stroke="var(--ff-text-muted)"
                strokeWidth="0.35"
              />
              <text
                y="3.4"
                textAnchor="middle"
                fill="var(--ff-text-muted)"
                fontSize="1.8"
              >
                {node.name.split(' ')[0]}
              </text>
            </g>
          ))}

          {marks
            .filter((m) => m.kind === 'flow-up' || m.kind === 'flow-down')
            .map((m) => {
              if (m.x2 == null || m.y2 == null) return null
              const up = m.kind === 'flow-up'
              return (
                <path
                  key={m.id}
                  d={bezier(m.x, m.y, m.x2, m.y2)}
                  fill="none"
                  stroke={up ? 'var(--ff-good)' : 'var(--ff-bad)'}
                  strokeWidth="0.55"
                  strokeLinecap="round"
                  strokeDasharray={up ? undefined : '1.2 0.8'}
                  opacity="0.9"
                >
                  <title>{m.label}</title>
                </path>
              )
            })}

          {marks
            .filter((m) => m.kind === 'open' || m.kind === 'close')
            .map((m) => {
              const open = m.kind === 'open'
              return (
                <g
                  key={m.id}
                  transform={`translate(${m.x} ${m.y})`}
                  className="diff-mark"
                >
                  <circle
                    r="3.4"
                    fill="none"
                    stroke={open ? 'var(--ff-good)' : 'var(--ff-bad)'}
                    strokeWidth="0.4"
                    opacity="0.7"
                  />
                  <circle
                    r="2.2"
                    fill="var(--ff-node-fill)"
                    stroke={open ? 'var(--ff-good)' : 'var(--ff-bad)'}
                    strokeWidth="0.55"
                  />
                  <text
                    textAnchor="middle"
                    dominantBaseline="central"
                    fill={open ? 'var(--ff-good)' : 'var(--ff-bad)'}
                    fontSize="2.4"
                    fontWeight="700"
                  >
                    {open ? '+' : '−'}
                  </text>
                  <text
                    y="4.6"
                    textAnchor="middle"
                    fill="var(--ff-text)"
                    fontSize="1.9"
                  >
                    {m.label.split(' ')[0]}
                  </text>
                  <title>{m.label}</title>
                </g>
              )
            })}
        </svg>
        <div className="map-legend" aria-hidden>
          <span>
            <i className="dot plant" /> Baseline nodes
          </span>
          <span>
            <i className="dot" style={{ background: 'var(--ff-good)' }} /> Open
          </span>
          <span>
            <i className="dot" style={{ background: 'var(--ff-bad)' }} /> Close
          </span>
        </div>
      </div>
    </div>
  )
}

function WaterfallView({
  focus,
  reference,
  selected,
  focusId,
  onFocus,
  steps,
}: {
  focus: Scenario
  reference: Scenario
  selected: Scenario[]
  focusId: string
  onFocus: (id: string) => void
  steps: WaterfallStep[]
}) {
  const chart = useMemo(() => layoutWaterfall(steps), [steps])

  return (
    <div className="compare-waterfall-layout">
      <aside className="compare-side">
        <h2>Focus scenario</h2>
        <div className="focus-list">
          {selected.map((s) => (
            <button
              key={s.id}
              type="button"
              className={
                s.id === focusId ? 'btn primary focus-btn' : 'btn ghost focus-btn'
              }
              onClick={() => onFocus(s.id)}
            >
              {s.name}
            </button>
          ))}
        </div>
        <p className="hint">
          Cost bridge from <strong>{reference.name}</strong> →{' '}
          <strong>{focus.name}</strong> (mock drivers from KPI deltas).
        </p>
        <ul className="waterfall-legend">
          {steps.map((s) => (
            <li key={s.id}>
              <span className={`wf-kind ${s.kind}`}>{s.kind}</span>
              {s.label}
              <strong>
                {s.kind === 'driver' && s.amount > 0 ? '+' : ''}
                {s.kind === 'driver' && s.amount < 0 ? '−' : ''}
                {s.kind === 'driver' ? `$${Math.abs(s.amount).toFixed(1)}M` : `$${s.amount.toFixed(1)}M`}
              </strong>
            </li>
          ))}
        </ul>
      </aside>

      <div className="waterfall-stage">
        <svg
          className="waterfall-svg"
          viewBox={`0 0 ${chart.width} ${chart.height}`}
          role="img"
          aria-label="Cost waterfall"
        >
          {chart.bars.map((b) => (
            <g key={b.id}>
              <rect
                x={b.x}
                y={b.y}
                width={b.w}
                height={b.h}
                rx="4"
                fill={b.fill}
                opacity="0.92"
              />
              {b.connector != null && (
                <line
                  x1={b.connector.x1}
                  y1={b.connector.y}
                  x2={b.connector.x2}
                  y2={b.connector.y}
                  stroke="var(--ff-border-soft)"
                  strokeWidth="1.5"
                  strokeDasharray="3 3"
                />
              )}
              <text
                x={b.x + b.w / 2}
                y={b.y - 8}
                textAnchor="middle"
                fill="var(--ff-text)"
                fontSize="11"
                fontWeight="600"
              >
                {b.valueLabel}
              </text>
              <text
                x={b.x + b.w / 2}
                y={chart.height - 16}
                textAnchor="middle"
                fill="var(--ff-text-secondary)"
                fontSize="11"
              >
                {b.label}
              </text>
            </g>
          ))}
          {/* zero / axis guide */}
          <line
            x1="40"
            y1={chart.zeroY}
            x2={chart.width - 20}
            y2={chart.zeroY}
            stroke="var(--ff-border)"
            strokeWidth="1"
          />
        </svg>
      </div>
    </div>
  )
}


function CtsView({
  focus,
  selected,
  focusId,
  onFocus,
  rows,
  steps,
  totalM,
}: {
  focus: Scenario
  selected: Scenario[]
  focusId: string
  onFocus: (id: string) => void
  rows: CtsRow[]
  steps: WaterfallStep[]
  totalM: number
}) {
  const regions = useMemo(() => ctsByRegion(rows), [rows])
  const chart = useMemo(() => layoutWaterfall(steps), [steps])

  return (
    <div className="compare-cts-layout">
      <aside className="compare-side">
        <h2>Focus scenario</h2>
        <div className="focus-list">
          {selected.map((s) => (
            <button
              key={s.id}
              type="button"
              className={
                s.id === focusId ? 'btn primary focus-btn' : 'btn ghost focus-btn'
              }
              onClick={() => onFocus(s.id)}
            >
              {s.name}
            </button>
          ))}
        </div>
        <p className="hint">
          Cost-to-serve for <strong>{focus.name}</strong> — mock allocation from
          active network lanes + demand volumes (total ${totalM.toFixed(1)}M).
        </p>
        <h3 className="cts-side-h">By region</h3>
        <ul className="cts-region-list">
          {regions.map((r) => (
            <li key={r.region}>
              <strong>{r.region}</strong>
              <span>${r.totalM.toFixed(1)}M</span>
              <span className="muted tiny">${r.ctsPerUnit.toFixed(2)}/u</span>
            </li>
          ))}
        </ul>
      </aside>

      <div className="cts-main">
        <div className="table-scroll data-table cts-table">
          <table>
            <thead>
              <tr>
                <th>Customer</th>
                <th>Region</th>
                <th>Volume</th>
                <th>Transport</th>
                <th>Handling</th>
                <th>Facility</th>
                <th>Total</th>
                <th>$/unit</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{r.customer}</td>
                  <td>{r.region}</td>
                  <td className="mono">{r.volume.toLocaleString()}</td>
                  <td className="mono">${r.transportM.toFixed(2)}M</td>
                  <td className="mono">${r.handlingM.toFixed(2)}M</td>
                  <td className="mono">${r.facilityM.toFixed(2)}M</td>
                  <td className="mono"><strong>${r.totalM.toFixed(2)}M</strong></td>
                  <td className="mono">${r.ctsPerUnit.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="waterfall-stage cts-waterfall">
          <p className="map-kicker">CTS stack</p>
          <svg
            className="waterfall-svg"
            viewBox={`0 0 ${chart.width} ${chart.height}`}
            role="img"
            aria-label="Cost-to-serve waterfall"
          >
            {chart.bars.map((b) => (
              <g key={b.id}>
                <rect
                  x={b.x}
                  y={b.y}
                  width={b.w}
                  height={b.h}
                  rx="4"
                  fill={b.fill}
                  opacity="0.92"
                />
                <text
                  x={b.x + b.w / 2}
                  y={b.y - 8}
                  textAnchor="middle"
                  fill="var(--ff-text)"
                  fontSize="11"
                  fontWeight="600"
                >
                  {b.valueLabel}
                </text>
                <text
                  x={b.x + b.w / 2}
                  y={chart.height - 16}
                  textAnchor="middle"
                  fill="var(--ff-text-secondary)"
                  fontSize="11"
                >
                  {b.label}
                </text>
              </g>
            ))}
          </svg>
        </div>
      </div>
    </div>
  )
}

type BarLayout = {
  id: string
  x: number
  y: number
  w: number
  h: number
  fill: string
  label: string
  valueLabel: string
  connector: { x1: number; x2: number; y: number } | null
}

function layoutWaterfall(steps: WaterfallStep[]): {
  width: number
  height: number
  zeroY: number
  bars: BarLayout[]
} {
  const width = 720
  const height = 320
  const padTop = 36
  const padBottom = 48
  const padX = 48
  const barW = 72
  const gap = 28
  const plotH = height - padTop - padBottom

  const values: number[] = []
  let running = 0
  for (const s of steps) {
    if (s.kind === 'start') {
      running = s.amount
      values.push(running)
    } else if (s.kind === 'driver') {
      running += s.amount
      values.push(running)
    } else {
      values.push(s.amount)
      running = s.amount
    }
  }
  const absMax = Math.max(...values.map(Math.abs), 1)
  const minV = Math.min(0, ...values)
  const maxV = Math.max(...values, absMax * 0.05)
  const span = Math.max(maxV - minV, 1)

  const yAt = (v: number) =>
    padTop + ((maxV - v) / span) * plotH

  const bars: BarLayout[] = []
  running = 0
  steps.forEach((s, i) => {
    const x = padX + i * (barW + gap)
    let top: number
    let bottom: number
    let fill: string
    let valueLabel: string

    if (s.kind === 'start' || s.kind === 'total') {
      const v = s.amount
      top = yAt(Math.max(v, 0))
      bottom = yAt(Math.min(v, 0))
      if (v >= 0) {
        top = yAt(v)
        bottom = yAt(0)
      } else {
        top = yAt(0)
        bottom = yAt(v)
      }
      fill = s.kind === 'start' ? 'var(--ff-accent)' : 'var(--ff-purple)'
      valueLabel = `$${v.toFixed(1)}M`
      running = v
    } else {
      const before = running
      const after = running + s.amount
      top = yAt(Math.max(before, after))
      bottom = yAt(Math.min(before, after))
      fill = s.amount < 0 ? 'var(--ff-good)' : 'var(--ff-bad)'
      valueLabel =
        (s.amount > 0 ? '+' : '−') + `$${Math.abs(s.amount).toFixed(1)}M`
      running = after
    }

    const h = Math.max(4, bottom - top)
    let connector: BarLayout['connector'] = null
    if (i > 0) {
      const prev = bars[i - 1]
      const y = s.kind === 'driver' ? (s.amount < 0 ? top : bottom) : top
      // Connect from previous bar top/end
      const prevEndY =
        steps[i - 1].kind === 'driver' && steps[i - 1].amount < 0
          ? prev.y
          : prev.y
      void prevEndY
      connector = {
        x1: prev.x + prev.w,
        x2: x,
        y: steps[i - 1].kind === 'total' || steps[i - 1].kind === 'start'
          ? prev.y
          : steps[i - 1].amount < 0
            ? prev.y
            : prev.y + prev.h,
      }
      // For floating waterfall, connector at the running total level before this step
      const levelBefore =
        s.kind === 'driver'
          ? yAt(running - (s.kind === 'driver' ? s.amount : 0))
          : y
      // recompute level before driver
      if (s.kind === 'driver') {
        const beforeVal = running - s.amount
        connector = {
          x1: prev.x + prev.w,
          x2: x,
          y: yAt(beforeVal),
        }
      } else if (s.kind === 'total') {
        connector = {
          x1: prev.x + prev.w,
          x2: x,
          y: yAt(s.amount),
        }
      }
      void levelBefore
    }

    bars.push({
      id: s.id,
      x,
      y: top,
      w: barW,
      h,
      fill,
      label: s.label.length > 16 ? s.label.slice(0, 14) + '…' : s.label,
      valueLabel,
      connector,
    })
  })

  return { width, height, zeroY: yAt(0), bars }
}

function DesLiteView({
  active,
  selected,
  onRun,
}: {
  active: Scenario
  selected: Scenario[]
  onRun: () => void
}) {
  const result = active.desLite
  const maxBin = result
    ? Math.max(1, ...result.fillRateBins.map((b) => b.count))
    : 1

  return (
    <div className="compare-des-layout">
      <aside className="compare-side">
        <h2>Active scenario</h2>
        <p className="des-active-name">{active.name}</p>
        <p className="muted tiny">
          Monte Carlo service-level sim: demand noise + lead-time noise → fill
          rate and late demand %. Results store on the scenario.
        </p>
        <button type="button" className="btn primary des-run-btn" onClick={onRun}>
          Run DES-lite
        </button>
        <h3 className="cts-side-h">Compared</h3>
        <ul className="des-scenario-list">
          {selected.map((s) => (
            <li key={s.id}>
              <strong>{s.name}</strong>
              {s.desLite ? (
                <span className="muted tiny">
                  fill {s.desLite.fillRatePct.toFixed(1)}% · late{' '}
                  {s.desLite.lateDemandPct.toFixed(1)}%
                </span>
              ) : (
                <span className="muted tiny">no sim yet</span>
              )}
            </li>
          ))}
        </ul>
      </aside>

      <div className="des-main">
        {!result ? (
          <div className="des-empty">
            <p>
              No DES-lite result on <strong>{active.name}</strong> yet. Run the
              sim to estimate fill rate under lead-time and demand noise.
            </p>
            <button type="button" className="btn primary" onClick={onRun}>
              Run DES-lite (200 trials)
            </button>
          </div>
        ) : (
          <>
            <div className="des-kpi-row" aria-label="DES-lite KPIs">
              <div className="des-kpi">
                <span className="des-kpi-label">Fill rate</span>
                <strong>{result.fillRatePct.toFixed(1)}%</strong>
              </div>
              <div className="des-kpi">
                <span className="des-kpi-label">Late demand</span>
                <strong>{result.lateDemandPct.toFixed(1)}%</strong>
              </div>
              <div className="des-kpi">
                <span className="des-kpi-label">Mean lead</span>
                <strong>{result.meanLeadDays.toFixed(2)} d</strong>
              </div>
              <div className="des-kpi">
                <span className="des-kpi-label">P95 lead</span>
                <strong>{result.p95LeadDays.toFixed(2)} d</strong>
              </div>
            </div>

            <p className="muted tiny des-meta">
              {result.trials} trials · demand noise ±{result.demandNoisePct}% ·
              lead noise ±{result.leadNoisePct}% · late if lead &gt;{' '}
              {result.serviceTargetDays}d · seed {result.seed} ·{' '}
              {new Date(result.runAt).toLocaleString()}
            </p>

            <h3 className="cts-side-h">Fill-rate distribution (trials)</h3>
            <div className="des-hist" role="img" aria-label="Fill rate histogram">
              {result.fillRateBins.map((b) => (
                <div key={b.label} className="des-hist-col">
                  <div
                    className="des-hist-bar"
                    style={{ height: `${(b.count / maxBin) * 100}%` }}
                    title={`${b.count} trials`}
                  />
                  <span className="des-hist-label">{b.label}</span>
                  <span className="muted tiny">{b.count}</span>
                </div>
              ))}
            </div>

            <button type="button" className="btn ghost des-rerun" onClick={onRun}>
              Re-run DES-lite
            </button>
          </>
        )}
      </div>
    </div>
  )
}


function InventoryView({
  active,
  formula,
  onFormula,
  onUpdateNode,
  onReset,
  onApply,
  rollup,
}: {
  active: Scenario
  formula: SafetyStockFormula
  onFormula: (f: SafetyStockFormula) => void
  onUpdateNode: (
    nodeId: string,
    patch: Partial<{
      serviceTargetPct: number
      leadTimeDays: number
      demandSigma: number
      meanDemandPerDay: number
      leadTimeSigma: number
      holdingCostPerUnit: number
    }>,
  ) => void
  onReset: () => void
  onApply: () => void
  rollup: ReturnType<typeof computeInventoryRollup>
}) {
  return (
    <div className="compare-inv-layout">
      <aside className="compare-side">
        <h2>Inventory policy</h2>
        <p className="des-active-name">{active.name}</p>
        <p className="muted tiny">
          Multi-echelon lite: per DC/plant service target, lead time, demand σ,
          holding cost. Safety stock via simple z·σ·√LT or ASCM combined
          uncertainty. Apply attaches Inv $ / units to Active KPIs.
        </p>
        <label className="field">
          <span>Formula</span>
          <select
            value={formula}
            onChange={(e) => onFormula(e.target.value as SafetyStockFormula)}
          >
            <option value="ascm-combined">ASCM combined (LT + σ_LT)</option>
            <option value="simple">Simple z · σ · √LT</option>
          </select>
        </label>
        <div className="des-kpi-row inv-rollup-kpis" aria-label="Inventory rollup">
          <div className="des-kpi">
            <span className="des-kpi-label">Network Inv $</span>
            <strong>{formatInvDollars(rollup.totalDollars)}</strong>
          </div>
          <div className="des-kpi">
            <span className="des-kpi-label">Safety stock</span>
            <strong>{formatInvUnits(rollup.totalUnits)}</strong>
          </div>
        </div>
        <div className="inv-actions">
          <button type="button" className="btn primary" onClick={onApply}>
            Apply to Active KPIs
          </button>
          <button type="button" className="btn ghost" onClick={onReset}>
            Reset defaults
          </button>
        </div>
        {active.inventoryRollup && (
          <p className="muted tiny">
            Last applied {new Date(active.inventoryRollup.appliedAt).toLocaleString()}{' '}
            · {active.inventoryRollup.formula}
          </p>
        )}
      </aside>

      <div className="inv-main">
        <div className="table-scroll data-table inv-table">
          <table>
            <thead>
              <tr>
                <th>Site</th>
                <th>Kind</th>
                <th>Svc %</th>
                <th>LT d</th>
                <th>σ_d</th>
                <th>d̄/d</th>
                <th>σ_LT</th>
                <th>$/u</th>
                <th>z</th>
                <th>SS u</th>
                <th>Inv $</th>
              </tr>
            </thead>
            <tbody>
              {rollup.nodes.map((r) => (
                <tr key={r.nodeId}>
                  <td>
                    <strong>{r.name}</strong>
                    <div className="muted tiny">{r.region}</div>
                  </td>
                  <td>{r.kind}</td>
                  <td>
                    <input
                      className="inv-input"
                      type="number"
                      min={50}
                      max={99.9}
                      step={0.5}
                      value={r.serviceTargetPct}
                      onChange={(e) =>
                        onUpdateNode(r.nodeId, {
                          serviceTargetPct: Number(e.target.value),
                        })
                      }
                    />
                  </td>
                  <td>
                    <input
                      className="inv-input"
                      type="number"
                      min={0}
                      step={0.5}
                      value={r.leadTimeDays}
                      onChange={(e) =>
                        onUpdateNode(r.nodeId, {
                          leadTimeDays: Number(e.target.value),
                        })
                      }
                    />
                  </td>
                  <td>
                    <input
                      className="inv-input"
                      type="number"
                      min={0}
                      step={1}
                      value={r.demandSigma}
                      onChange={(e) =>
                        onUpdateNode(r.nodeId, {
                          demandSigma: Number(e.target.value),
                        })
                      }
                    />
                  </td>
                  <td>
                    <input
                      className="inv-input"
                      type="number"
                      min={0}
                      step={1}
                      value={r.meanDemandPerDay}
                      onChange={(e) =>
                        onUpdateNode(r.nodeId, {
                          meanDemandPerDay: Number(e.target.value),
                        })
                      }
                    />
                  </td>
                  <td>
                    <input
                      className="inv-input"
                      type="number"
                      min={0}
                      step={0.1}
                      value={r.leadTimeSigma}
                      onChange={(e) =>
                        onUpdateNode(r.nodeId, {
                          leadTimeSigma: Number(e.target.value),
                        })
                      }
                    />
                  </td>
                  <td>
                    <input
                      className="inv-input"
                      type="number"
                      min={0}
                      step={1}
                      value={r.holdingCostPerUnit}
                      onChange={(e) =>
                        onUpdateNode(r.nodeId, {
                          holdingCostPerUnit: Number(e.target.value),
                        })
                      }
                    />
                  </td>
                  <td className="mono">{r.z.toFixed(2)}</td>
                  <td className="mono">{r.safetyStockUnits.toLocaleString()}</td>
                  <td className="mono">
                    ${r.inventoryDollars.toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted tiny matrix-footnote">
          {formula === 'simple'
            ? 'SS = z · σ_d · √LT'
            : 'SS = z · √(LT · σ_d² + d̄² · σ_LT²) (ASCM combined uncertainty)'}
          . z from service target via Φ⁻¹.
        </p>
      </div>
    </div>
  )
}

function ResilienceView({
  active,
  onRun,
  thresholdDefault,
  liveResult,
}: {
  active: Scenario
  onRun: (thresholdPct?: number) => ResilienceResult | null
  thresholdDefault: number
  liveResult: ResilienceResult | null
}) {
  const [threshold, setThreshold] = useState(thresholdDefault)
  const [local, setLocal] = useState<ResilienceResult | null>(null)

  useEffect(() => {
    setThreshold(thresholdDefault)
  }, [thresholdDefault])

  const result = local ?? liveResult
  const stored = active.resilience

  function handleRun() {
    const r = onRun(threshold)
    if (r) setLocal(r)
  }

  const critical: CriticalNode[] = result?.critical ?? []
  const ranked: CriticalNode[] = result?.ranked ?? []

  return (
    <div className="compare-res-layout">
      <aside className="compare-side">
        <h2>Resilience</h2>
        <p className="des-active-name">{active.name}</p>
        <p className="muted tiny">
          Single points of failure: nodes whose removal drops service below the
          threshold. Builds on the same coverage heuristic as node-outage
          sensitivity.
        </p>
        <label className="field">
          <span>Service threshold (%)</span>
          <input
            type="number"
            min={50}
            max={100}
            step={0.5}
            value={threshold}
            onChange={(e) => setThreshold(Number(e.target.value))}
          />
        </label>
        <button type="button" className="btn primary des-run-btn" onClick={handleRun}>
          Score resilience
        </button>
        {(result || stored) && (
          <div className="des-kpi-row" aria-label="Resilience score">
            <div className="des-kpi">
              <span className="des-kpi-label">Score</span>
              <strong>{(result?.score ?? stored?.score ?? 0).toFixed(0)}</strong>
            </div>
            <div className="des-kpi">
              <span className="des-kpi-label">Critical</span>
              <strong>
                {(result?.critical.length ?? stored?.criticalNodeIds.length ?? 0)}
              </strong>
            </div>
            <div className="des-kpi">
              <span className="des-kpi-label">Baseline svc</span>
              <strong>
                {(
                  result?.baselineServicePct ??
                  stored?.baselineServicePct ??
                  0
                ).toFixed(1)}
                %
              </strong>
            </div>
          </div>
        )}
      </aside>

      <div className="res-main">
        {!result && !stored ? (
          <div className="des-empty">
            <p>
              No resilience score on <strong>{active.name}</strong> yet. Run to
              list critical nodes (SPOFs).
            </p>
            <button type="button" className="btn primary" onClick={handleRun}>
              Score resilience
            </button>
          </div>
        ) : (
          <>
            <h3 className="cts-side-h">Critical nodes (SPOF)</h3>
            {critical.length === 0 && (result?.critical.length === 0 || (stored && stored.criticalNodeIds.length === 0 && !result)) ? (
              <p className="hint pad">
                No single points of failure at {threshold}% service threshold.
                {(stored?.criticalNames?.length ?? 0) > 0 && !result
                  ? ` Stored: ${stored!.criticalNames.join(', ')}`
                  : ''}
              </p>
            ) : (
              <ul className="res-critical-list">
                {(critical.length
                  ? critical
                  : (stored?.criticalNames ?? []).map((name, i) => ({
                      nodeId: stored!.criticalNodeIds[i] ?? `c-${i}`,
                      name,
                      kind: '—',
                      region: '—',
                      serviceAfterPct: 0,
                      dropPp: 0,
                      coveredVolume: 0,
                    }))
                ).map((c) => (
                  <li key={c.nodeId} className="res-critical-item">
                    <div>
                      <strong>{c.name}</strong>
                      <span className="chip-tag">{c.kind}</span>
                      <span className="muted tiny">{c.region}</span>
                    </div>
                    <div className="res-critical-meta">
                      {c.dropPp > 0 && (
                        <span className="kpi-delta down">−{c.dropPp.toFixed(1)}pp</span>
                      )}
                      {c.serviceAfterPct > 0 && (
                        <span className="mono">
                          svc after {c.serviceAfterPct.toFixed(1)}%
                        </span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {ranked.length > 0 && (
              <>
                <h3 className="cts-side-h">All open facilities (by impact)</h3>
                <div className="table-scroll data-table">
                  <table>
                    <thead>
                      <tr>
                        <th>Node</th>
                        <th>Kind</th>
                        <th>Drop</th>
                        <th>Svc after</th>
                        <th>Covered vol</th>
                        <th>Critical?</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ranked.map((r) => {
                        const isCrit = critical.some((c) => c.nodeId === r.nodeId)
                        return (
                          <tr key={r.nodeId} className={isCrit ? 'res-row-crit' : undefined}>
                            <td>{r.name}</td>
                            <td>{r.kind}</td>
                            <td className="mono">−{r.dropPp.toFixed(1)}pp</td>
                            <td className="mono">{r.serviceAfterPct.toFixed(1)}%</td>
                            <td className="mono">{Math.round(r.coveredVolume).toLocaleString()}</td>
                            <td>{isCrit ? 'Yes' : '—'}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}


function ProductsView({
  productMix,
  network,
  kpis,
  onFilter,
}: {
  productMix: import('../data/productGroups').ProductMixState
  network: import('../data/csvParsers').UploadedNetwork
  kpis: KpiSnapshot
  onFilter: (id: string | null) => void
}) {
  const rows = rollupByProductGroup(productMix, network, kpis)
  return (
    <div className="compare-modes-layout">
      <section className="library-card" aria-label="Product groups">
        <h2>Product / commodity mix</h2>
        <p className="muted tiny">
          Catalog <strong>{catalogLabel(productMix.catalog)}</strong>. Demand
          volume and KPI cost / CO₂ allocated by demand share. Filter the
          Network map from here or the Inspector.
        </p>
        <div className="product-chip-row wrap" style={{ marginBottom: '0.75rem' }}>
          <button
            type="button"
            className={
              productMix.filterGroupId == null ? 'product-chip on' : 'product-chip'
            }
            onClick={() => onFilter(null)}
          >
            All
          </button>
          {productMix.groups.map((g) => (
            <button
              key={g.id}
              type="button"
              className={
                productMix.filterGroupId === g.id
                  ? 'product-chip on'
                  : 'product-chip'
              }
              style={{ ['--pg-color' as string]: g.color }}
              onClick={() =>
                onFilter(
                  productMix.filterGroupId === g.id ? null : g.id,
                )
              }
            >
              <span className="product-chip-dot" aria-hidden />
              {g.code}
            </button>
          ))}
        </div>
        <div className="modes-bars" aria-hidden>
          {rows.map((r) => (
            <div key={r.groupId} className="mode-bar-row">
              <span className="mode-bar-label">{r.code}</span>
              <div className="mode-bar-track">
                <div
                  className="mode-bar-fill"
                  style={{
                    width: `${Math.max(2, r.demandSharePct)}%`,
                    background: r.color,
                  }}
                />
              </div>
              <span className="mode-bar-pct">{r.demandSharePct}%</span>
            </div>
          ))}
        </div>
        <div className="table-scroll">
          <table className="compare-matrix modes-table">
            <thead>
              <tr>
                <th>Group</th>
                <th>Demand u</th>
                <th>Share</th>
                <th>Cost $M</th>
                <th>CO₂ kt</th>
                <th>Service</th>
                <th>Capable sites</th>
                <th>Lanes</th>
                <th>Cap units</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.groupId}
                  className={
                    productMix.filterGroupId === r.groupId ? 'selected' : ''
                  }
                  onClick={() =>
                    onFilter(
                      productMix.filterGroupId === r.groupId
                        ? null
                        : r.groupId,
                    )
                  }
                  style={{ cursor: 'pointer' }}
                >
                  <td>
                    <span
                      className="product-chip-dot inline"
                      style={{ background: r.color }}
                      aria-hidden
                    />{' '}
                    {r.name}{' '}
                    <span className="mono muted">({r.code})</span>
                  </td>
                  <td>{r.demandVolume.toLocaleString()}</td>
                  <td>{r.demandSharePct}%</td>
                  <td>${r.costM.toFixed(1)}M</td>
                  <td>{r.co2Kt.toFixed(1)}</td>
                  <td>{r.servicePct.toFixed(1)}%</td>
                  <td>{r.capableFacilities}</td>
                  <td>{r.taggedLanes}</td>
                  <td>{r.capacityUnits.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="hint">
          Click a row to filter Network by that product group. Edit mix in Data
          room or Network Inspector.
        </p>
      </section>
    </div>
  )
}

function ModeMixView({
  rows,
}: {
  rows: ReturnType<typeof summarizeModeMix>
}) {
  if (rows.length === 0) {
    return <p className="hint pad">No lanes in the active network.</p>
  }
  return (
    <div className="compare-modes-layout">
      <section className="library-card modes-summary" aria-label="Mode mix">
        <h2>Transport mode mix</h2>
        <p className="muted tiny">
          Lane share, ton-miles, and CO₂ by mode. Cost relatives and kg/ton-mile
          come from the same planning factors used by optimize / CO₂.
        </p>
        <div className="modes-bars" aria-hidden>
          {rows.map((r) => (
            <div key={r.mode} className="mode-bar-row">
              <span className="mode-bar-label">{r.mode}</span>
              <div className="mode-bar-track">
                <div
                  className="mode-bar-fill"
                  style={{ width: `${Math.max(2, r.lanePct)}%` }}
                />
              </div>
              <span className="mode-bar-pct">{r.lanePct}%</span>
            </div>
          ))}
        </div>
        <div className="table-scroll">
          <table className="compare-matrix modes-table">
            <thead>
              <tr>
                <th>Mode</th>
                <th>Lanes</th>
                <th>Lane %</th>
                <th>Ton-mi %</th>
                <th>CO₂ %</th>
                <th>Avg $/u</th>
                <th>Cost rel.</th>
                <th>kg/ton-mi</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.mode}>
                  <td>{r.mode}</td>
                  <td>{r.laneCount}</td>
                  <td>{r.lanePct}%</td>
                  <td>{r.tonMilePct}%</td>
                  <td>{r.co2Pct}%</td>
                  <td>${r.avgCostPerUnit.toFixed(2)}</td>
                  <td>{r.costRelative.toFixed(2)}×</td>
                  <td>{r.kgPerTonMile}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

function BidsView({
  network,
  laneRates,
  onStrategy,
  onApplyAll,
  onApplyBid,
}: {
  network: import('../data/csvParsers').UploadedNetwork
  laneRates: import('../data/laneRates').LaneRatesState
  onStrategy: (s: BidStrategy) => void
  onApplyAll: () => number
  onApplyBid: (laneId: string, bidId: string) => void
}) {
  const summaries = summarizeLaneBids(laneRates, network)
  const rollup = bidCompareRollup(summaries)
  const [status, setStatus] = useState<string | null>(null)

  return (
    <div className="compare-modes-layout">
      <section className="library-card" aria-label="Lane bid comparison">
        <div className="library-card-head">
          <h2>Lane rate bid comparison</h2>
          <div className="product-chip-row">
            <button
              type="button"
              className="btn primary btn-tiny"
              onClick={() => {
                const n = onApplyAll()
                setStatus(
                  `Applied ${strategyLabel(laneRates.compareStrategy)} winners on ${n} lanes.`,
                )
              }}
            >
              Apply all winners
            </button>
          </div>
        </div>
        <p className="muted tiny">
          Carrier bids ranked by strategy. Apply writes $/unit and transit onto
          the active network. Edit sample rates in Data room.
        </p>
        <label className="field" style={{ maxWidth: '16rem' }}>
          <span>Strategy</span>
          <select
            value={laneRates.compareStrategy}
            onChange={(e) => onStrategy(e.target.value as BidStrategy)}
          >
            <option value="cheapest">Cheapest</option>
            <option value="fastest">Fastest</option>
            <option value="balanced">Balanced</option>
          </select>
        </label>
        {status && <p className="status-line">{status}</p>}
        <div className="data-scores" style={{ marginTop: '0.75rem' }}>
          <div className="score-card">
            <span className="score-label">Lanes / bids</span>
            <strong className="score-value">
              {rollup.laneCount} / {rollup.bidCount}
            </strong>
            <span className="score-sub">
              {strategyLabel(laneRates.compareStrategy)}
            </span>
          </div>
          <div className="score-card tone-good">
            <span className="score-label">Avg winner $/u</span>
            <strong className="score-value">
              ${rollup.avgWinnerCost.toFixed(2)}
            </strong>
            <span className="score-sub">
              vs ${rollup.avgCurrentCost.toFixed(2)} current
            </span>
          </div>
          <div
            className={`score-card${rollup.totalSavingsPerUnit > 0 ? ' tone-good' : ' tone-warn'}`}
          >
            <span className="score-label">Σ savings $/u</span>
            <strong className="score-value">
              ${rollup.totalSavingsPerUnit.toFixed(2)}
            </strong>
            <span className="score-sub">
              {rollup.lanesWithSavings} lanes cheaper
            </span>
          </div>
        </div>
        <div className="table-scroll" style={{ marginTop: '0.85rem' }}>
          <table className="compare-matrix modes-table">
            <thead>
              <tr>
                <th>Corridor</th>
                <th>Current</th>
                <th>Winner</th>
                <th>$/unit</th>
                <th>Transit</th>
                <th>Δ vs current</th>
                <th>Bids</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {summaries.map((s) => {
                const w = s.winner
                return (
                  <tr key={s.laneId}>
                    <td>{s.corridorLabel}</td>
                    <td className="mono">
                      ${s.currentCost.toFixed(2)} · {s.currentLeadDays}d
                    </td>
                    <td>{w?.bid.carrier ?? '—'}</td>
                    <td className="mono">
                      {w ? `$${w.effectiveCostPerUnit.toFixed(2)}` : '—'}
                    </td>
                    <td>{w ? `${w.bid.transitDays}d` : '—'}</td>
                    <td
                      className={
                        s.savingsPerUnit > 0
                          ? 'delta-up'
                          : s.savingsPerUnit < 0
                            ? 'delta-down'
                            : ''
                      }
                    >
                      {s.savingsPerUnit === 0
                        ? '—'
                        : `${s.savingsPerUnit > 0 ? '−' : '+'}$${Math.abs(s.savingsPerUnit).toFixed(2)}`}
                    </td>
                    <td>{s.bids.length}</td>
                    <td>
                      {w && (
                        <button
                          type="button"
                          className="btn ghost btn-tiny"
                          onClick={() => {
                            onApplyBid(s.laneId, w.bid.id)
                            setStatus(`Applied ${w.bid.carrier} → ${s.corridorLabel}`)
                          }}
                        >
                          Apply
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

function BomView({
  bom,
  network,
  kpis,
  onDraftInbound,
}: {
  bom: import('../data/bom').BomState
  network: import('../data/csvParsers').UploadedNetwork
  kpis: KpiSnapshot
  onDraftInbound: () => { addedLanes: number; scenarioId: string }
}) {
  const roll = bomRollup(bom, network)
  const implied = deriveImpliedRmDemand(bom, network)
  const flows = deriveEchelonFlows(bom, network)
  const plantFlows = flows.filter((f) => f.echelon === 'plant←supplier')
  const matFlows = flows.filter((f) => f.echelon === 'fg←rm')
  const preview = previewBomInboundLanes(bom, network, kpis)

  return (
    <div className="compare-modes-layout">
      <section className="library-card" aria-label="BOM echelon flows">
        <div className="library-card-head">
          <h2>BOM / multi-echelon flows</h2>
          <button
            type="button"
            className="btn primary btn-tiny"
            onClick={() => {
              const r = onDraftInbound()
              // status surfaces via scenario switch
              void r
            }}
          >
            Draft inbound scenario
            {preview.newLanes.length > 0
              ? ` (+${preview.newLanes.length})`
              : ''}
          </button>
        </div>
        <p className="muted tiny">
          Implied RM from FG demand × BOM qty. Echelon view: Plant←Supplier
          (network lanes) and FG←RM (material). Optional scenario adds missing
          inbound Supplier→Plant lanes.
        </p>
        <div className="data-scores" style={{ marginBottom: '0.85rem' }}>
          <div className="score-card">
            <span className="score-label">BOM rows</span>
            <strong className="score-value">{roll.bomRows}</strong>
            <span className="score-sub">{roll.fgCount} finished goods</span>
          </div>
          <div className="score-card">
            <span className="score-label">Implied RM qty</span>
            <strong className="score-value">
              {roll.totalRmQty.toLocaleString()}
            </strong>
            <span className="score-sub">{roll.componentCount} components</span>
          </div>
          <div
            className={`score-card${roll.impliedLaneGaps > 0 ? ' tone-warn' : ' tone-good'}`}
          >
            <span className="score-label">Lane coverage</span>
            <strong className="score-value">
              {roll.coveredLanePairs}/{roll.plantSupplierFlows}
            </strong>
            <span className="score-sub">
              {roll.impliedLaneGaps} implied gap
              {roll.impliedLaneGaps === 1 ? '' : 's'}
            </span>
          </div>
        </div>

        <h3 className="data-subhead">Implied RM demand</h3>
        <div className="table-scroll">
          <table className="compare-matrix modes-table">
            <thead>
              <tr>
                <th>Component</th>
                <th>Kind</th>
                <th>Qty needed</th>
                <th>Supplier</th>
                <th>FG sources</th>
              </tr>
            </thead>
            <tbody>
              {implied.map((i) => (
                <tr key={i.componentId}>
                  <td>{i.componentName}</td>
                  <td>{componentKindLabel(i.componentKind)}</td>
                  <td>{i.qtyNeeded.toLocaleString()}</td>
                  <td>{i.preferredSupplierName ?? '—'}</td>
                  <td className="muted tiny">
                    {i.sources
                      .map((s) => `${s.finishedGoodName} ×${s.qtyPerUnit}`)
                      .join(', ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h3 className="data-subhead">Plant←Supplier (network)</h3>
        <div className="table-scroll">
          <table className="compare-matrix modes-table">
            <thead>
              <tr>
                <th>Supplier</th>
                <th>Plant</th>
                <th>Material</th>
                <th>Volume</th>
                <th>Lane</th>
              </tr>
            </thead>
            <tbody>
              {plantFlows.map((f) => (
                <tr
                  key={f.id}
                  className={f.implied ? 'bom-implied' : undefined}
                >
                  <td>{f.fromName}</td>
                  <td>{f.toName}</td>
                  <td>{f.materialName}</td>
                  <td>{f.volume.toLocaleString()}</td>
                  <td>
                    {f.implied ? (
                      <em className="bom-gap">implied gap</em>
                    ) : (
                      f.laneId
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h3 className="data-subhead">FG←RM (material)</h3>
        <div className="table-scroll">
          <table className="compare-matrix modes-table">
            <thead>
              <tr>
                <th>Component / RM</th>
                <th>Finished good</th>
                <th>Volume</th>
                <th>Kind</th>
              </tr>
            </thead>
            <tbody>
              {matFlows.map((f) => (
                <tr key={f.id}>
                  <td>{f.fromName}</td>
                  <td>{f.toName}</td>
                  <td>{f.volume.toLocaleString()}</td>
                  <td>{f.fromKind}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="hint">{preview.summary}. Edit BOM in Data room.</p>
      </section>
    </div>
  )
}

function TerritoryView({
  network,
  kpis,
  applyTerritoryNetwork,
}: {
  network: import('../data/csvParsers').UploadedNetwork
  kpis: KpiSnapshot
  applyTerritoryNetwork: (
    net: import('../data/csvParsers').UploadedNetwork,
    draftScenario?: Scenario,
  ) => void
}) {
  const [mode, setMode] = useState<TerritoryAssignMode>('distance')
  const [coverageMiles, setCoverageMiles] = useState(400)
  const [coverageLeadDays, setCoverageLeadDays] = useState(3)
  const [status, setStatus] = useState<string | null>(null)

  const preview = useMemo(
    () =>
      previewTerritory(
        network,
        {
          facilityIds: suggestServingIds(network.nodes),
          mode,
          coverageMiles,
          coverageLeadDays,
          replaceDemandLanes: true,
          laneMode: 'Truck',
        },
        kpis,
      ),
    [network, mode, coverageMiles, coverageLeadDays, kpis],
  )

  function handleApply() {
    const result = applyTerritoryDesign(
      network,
      {
        facilityIds: suggestServingIds(network.nodes),
        mode,
        coverageMiles,
        coverageLeadDays,
        replaceDemandLanes: true,
        laneMode: 'Truck',
      },
      kpis,
    )
    applyTerritoryNetwork(result.network, result.draftScenario)
    setStatus(
      `${result.preview.summary} Draft “${result.draftScenario.name}” Active.`,
    )
  }

  const m = preview.metrics

  return (
    <div className="compare-panel territory-compare">
      <section className="library-card" aria-label="Service territory">
        <div className="products-head">
          <h2>Service territory / coverage</h2>
          <div className="products-actions">
            <label className="field inline-field">
              <span>Assign</span>
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value as TerritoryAssignMode)}
              >
                <option value="distance">Distance</option>
                <option value="capacity">Capacity</option>
                <option value="lanes">Current lanes</option>
              </select>
            </label>
            <label className="field inline-field">
              <span>Miles</span>
              <input
                type="number"
                min={50}
                max={2000}
                step={25}
                value={coverageMiles}
                onChange={(e) => setCoverageMiles(Number(e.target.value) || 400)}
              />
            </label>
            <label className="field inline-field">
              <span>Lead days</span>
              <input
                type="number"
                min={1}
                max={21}
                value={coverageLeadDays}
                onChange={(e) =>
                  setCoverageLeadDays(Number(e.target.value) || 3)
                }
              />
            </label>
            <button type="button" className="btn primary" onClick={handleApply}>
              Apply scenario + preferred lanes
            </button>
          </div>
        </div>
        <p className="hint">
          Full studio: Territory room. Network Layers → Territory for map
          coloring. {preview.summary}
        </p>
        {status && <p className="status-line">{status}</p>}

        <div className="data-scores merge-scores hubspoke-kpis">
          <div className="score-card">
            <span className="score-label">Within {coverageMiles} mi</span>
            <strong className="score-value">{m.pctCoveredWithinMiles}%</strong>
            <span className="score-sub">
              {m.assignedCount}/{m.demandCount} assigned · {m.gapCount} gaps
            </span>
          </div>
          <div className="score-card">
            <span className="score-label">Within {coverageLeadDays}d lead</span>
            <strong className="score-value">{m.pctCoveredWithinLead}%</strong>
            <span className="score-sub">
              Unassigned {m.unassignedVolume.toLocaleString()} · {m.overlapCount}{' '}
              overlaps
            </span>
          </div>
          <div className="score-card">
            <span className="score-label">Territory load</span>
            <strong className="score-value">
              {preview.loads.filter((l) => l.utilPct > 100).length} overloaded
            </strong>
            <span className="score-sub">
              {preview.loads.length} servers · after svc{' '}
              {preview.kpis.after.service.value}
            </span>
          </div>
        </div>

        <div className="hubspoke-tables" style={{ marginTop: '0.75rem' }}>
          <div className="candidate-table">
            <div className="table-tabs">
              <span className="table-tabs-label">Load vs capacity</span>
            </div>
            <div className="table-scroll">
              <table className="compare-matrix">
                <thead>
                  <tr>
                    <th>Facility</th>
                    <th>Demand</th>
                    <th>Volume</th>
                    <th>Capacity</th>
                    <th>Util %</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.loads.map((h) => (
                    <tr key={h.facilityId}>
                      <td>
                        <i
                          className="terr-swatch"
                          style={{ background: h.color }}
                          aria-hidden
                        />{' '}
                        {h.facilityName}
                      </td>
                      <td>{h.demandCount}</td>
                      <td>{h.assignedVolume.toLocaleString()}</td>
                      <td>{h.capacity.toLocaleString()}</td>
                      <td>
                        <span
                          className={
                            h.utilPct > 100
                              ? 'util-bad'
                              : h.utilPct > 85
                                ? 'util-warn'
                                : 'util-ok'
                          }
                        >
                          {h.utilPct.toFixed(1)}%
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className="candidate-table">
            <div className="table-tabs">
              <span className="table-tabs-label">Assignments</span>
            </div>
            <div className="table-scroll">
              <table className="compare-matrix">
                <thead>
                  <tr>
                    <th>Demand</th>
                    <th>Server</th>
                    <th>Miles</th>
                    <th>Lead</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.assignments.map((a) => (
                    <tr key={a.demandId}>
                      <td>{a.demandName}</td>
                      <td>{a.facilityName ?? '—'}</td>
                      <td>{a.miles ?? '—'}</td>
                      <td>{a.leadDays != null ? `${a.leadDays}d` : '—'}</td>
                      <td>
                        <span
                          className={
                            a.status === 'gap'
                              ? 'util-bad'
                              : a.status === 'overlap'
                                ? 'util-warn'
                                : 'util-ok'
                          }
                        >
                          {a.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}


function CostSensitivityView({
  active,
  selected,
  onRun,
}: {
  active: Scenario
  selected: Scenario[]
  onRun: (
    params?: import('../data/costSensitivity').CostSensitivityParams,
  ) => CostSensitivityResult | null
}) {
  const [ranges, setRanges] = useState<Record<CostDriverId, number>>(() =>
    defaultDriverRanges(),
  )
  const [trials, setTrials] = useState(300)
  const [local, setLocal] = useState<CostSensitivityResult | null>(null)

  const result = local ?? active.costSensitivity ?? null
  const maxSwing = result
    ? Math.max(0.01, ...result.tornado.map((b) => b.swingM))
    : 1
  const maxBin = result
    ? Math.max(1, ...result.histogram.map((b) => b.count))
    : 1

  function setRange(id: CostDriverId, value: number) {
    setRanges((prev) => ({
      ...prev,
      [id]: Math.max(1, Math.min(80, value)),
    }))
  }

  function handleRun() {
    const r = onRun({ trials, ranges, seed: 42 })
    if (r) setLocal(r)
  }

  function applyHint(
    hint: 'fuel-20' | 'tariff-duty' | 'demand-shift' | 'balanced',
  ) {
    setRanges((prev) => {
      const next = { ...prev }
      const patch = rangesFromPresetHint(hint)
      for (const [k, v] of Object.entries(patch)) {
        if (v != null) next[k as CostDriverId] = v
      }
      return next
    })
  }

  // Sync local when active scenario changes externally
  useEffect(() => {
    setLocal(null)
  }, [active.id])

  return (
    <div className="compare-des-layout compare-sens-layout">
      <aside className="compare-side">
        <h2>Cost sensitivity</h2>
        <p className="des-active-name">{active.name}</p>
        <p className="muted tiny">
          Tornado (one-at-a-time low/high) and Monte Carlo on cost drivers vs
          Active cost KPI. Ranges reuse Scenarios sensitivity presets where
          helpful (fuel, tariff, demand).
        </p>

        <label className="field">
          <span>MC trials</span>
          <input
            type="number"
            min={50}
            max={2000}
            step={50}
            value={trials}
            onChange={(e) => setTrials(Number(e.target.value) || 300)}
          />
        </label>

        <div className="sens-preset-hints" role="group" aria-label="Range presets">
          <button
            type="button"
            className="btn ghost btn-tiny"
            onClick={() => applyHint('balanced')}
          >
            Defaults
          </button>
          <button
            type="button"
            className="btn ghost btn-tiny"
            onClick={() => applyHint('fuel-20')}
          >
            Fuel +20%
          </button>
          <button
            type="button"
            className="btn ghost btn-tiny"
            onClick={() => applyHint('tariff-duty')}
          >
            Tariff
          </button>
          <button
            type="button"
            className="btn ghost btn-tiny"
            onClick={() => applyHint('demand-shift')}
          >
            Demand
          </button>
        </div>

        <div className="sens-driver-list">
          {COST_DRIVERS.map((d) => (
            <label key={d.id} className="field sens-driver-field">
              <span>
                {d.label} <em className="muted">±%</em>
              </span>
              <input
                type="number"
                min={1}
                max={80}
                step={1}
                value={ranges[d.id]}
                onChange={(e) => setRange(d.id, Number(e.target.value) || 1)}
                title={d.description}
              />
            </label>
          ))}
        </div>

        <button
          type="button"
          className="btn primary des-run-btn"
          onClick={handleRun}
        >
          Run tornado + MC
        </button>

        <h3 className="cts-side-h">Compared</h3>
        <ul className="des-scenario-list">
          {selected.map((s) => (
            <li key={s.id}>
              <strong>{s.name}</strong>
              {s.costSensitivity ? (
                <span className="muted tiny">
                  P50 ${s.costSensitivity.p50.toFixed(1)}M · swing max $
                  {Math.max(
                    ...s.costSensitivity.tornado.map((b) => b.swingM),
                  ).toFixed(1)}
                  M
                </span>
              ) : (
                <span className="muted tiny">no run yet</span>
              )}
            </li>
          ))}
        </ul>
      </aside>

      <div className="des-main sens-main">
        {!result ? (
          <div className="des-empty">
            <p>
              No cost sensitivity on <strong>{active.name}</strong> yet. Set
              driver ±% ranges and run tornado + Monte Carlo (default{' '}
              {trials} trials).
            </p>
            <button type="button" className="btn primary" onClick={handleRun}>
              Run tornado + MC
            </button>
          </div>
        ) : (
          <>
            <div className="des-kpi-row" aria-label="Cost sensitivity KPIs">
              <div className="des-kpi">
                <span className="des-kpi-label">Baseline</span>
                <strong>${result.baselineCostM.toFixed(1)}M</strong>
              </div>
              <div className="des-kpi">
                <span className="des-kpi-label">P10</span>
                <strong>${result.p10.toFixed(1)}M</strong>
              </div>
              <div className="des-kpi">
                <span className="des-kpi-label">P50</span>
                <strong>${result.p50.toFixed(1)}M</strong>
              </div>
              <div className="des-kpi">
                <span className="des-kpi-label">P90</span>
                <strong>${result.p90.toFixed(1)}M</strong>
              </div>
              <div className="des-kpi">
                <span className="des-kpi-label">Mean</span>
                <strong>${result.mean.toFixed(1)}M</strong>
              </div>
            </div>
            <p className="muted tiny des-meta">
              {result.trials} trials · seed {result.seed} ·{' '}
              {new Date(result.runAt).toLocaleString()} · range $
              {result.min.toFixed(1)}–{result.max.toFixed(1)}M
            </p>

            <h3 className="cts-side-h">Tornado (OAT low / high vs baseline)</h3>
            <div
              className="tornado-chart"
              role="img"
              aria-label="Cost driver tornado chart"
            >
              {result.tornado.map((b) => {
                const lowW = (Math.abs(b.lowDeltaM) / maxSwing) * 50
                const highW = (Math.abs(b.highDeltaM) / maxSwing) * 50
                return (
                  <div key={b.driverId} className="tornado-row">
                    <span className="tornado-label" title={`±${b.rangePct}%`}>
                      {b.label}
                    </span>
                    <div className="tornado-bars">
                      <div className="tornado-half left">
                        <div
                          className="tornado-bar low"
                          style={{ width: `${Math.max(2, lowW)}%` }}
                          title={`Low $${b.lowCostM.toFixed(1)}M (${b.lowDeltaM >= 0 ? '+' : ''}${b.lowDeltaM.toFixed(1)}M)`}
                        />
                      </div>
                      <div className="tornado-center" title="Baseline" />
                      <div className="tornado-half right">
                        <div
                          className="tornado-bar high"
                          style={{ width: `${Math.max(2, highW)}%` }}
                          title={`High $${b.highCostM.toFixed(1)}M (${b.highDeltaM >= 0 ? '+' : ''}${b.highDeltaM.toFixed(1)}M)`}
                        />
                      </div>
                    </div>
                    <span className="tornado-swing mono">
                      ±${(b.swingM / 2).toFixed(1)}M
                    </span>
                  </div>
                )
              })}
            </div>
            <p className="muted tiny matrix-footnote">
              Blue = low (−range); coral = high (+range). Sorted by absolute
              swing. Center line = baseline ${result.baselineCostM.toFixed(1)}M.
            </p>

            <h3 className="cts-side-h">Monte Carlo cost distribution</h3>
            <div
              className="des-hist sens-hist"
              role="img"
              aria-label="Cost Monte Carlo histogram"
            >
              {result.histogram.map((b) => (
                <div key={b.label} className="des-hist-col">
                  <div
                    className="des-hist-bar"
                    style={{ height: `${(b.count / maxBin) * 100}%` }}
                    title={`${b.count} trials`}
                  />
                  <span className="des-hist-label">{b.label}</span>
                  <span className="muted tiny">{b.count}</span>
                </div>
              ))}
            </div>

            <button
              type="button"
              className="btn ghost des-rerun"
              onClick={handleRun}
            >
              Re-run tornado + MC
            </button>
          </>
        )}
      </div>
    </div>
  )
}
