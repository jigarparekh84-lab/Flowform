import { useEffect, useMemo, useState } from 'react'
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
import { useFlowform } from '../state/FlowformContext'

type ViewMode = 'matrix' | 'map' | 'waterfall'

const KPI_ROWS: { key: keyof KpiSnapshot; label: string }[] = [
  { key: 'cost', label: 'Cost' },
  { key: 'service', label: 'Service' },
  { key: 'capex', label: 'CapEx' },
  { key: 'co2', label: 'CO₂' },
  { key: 'risk', label: 'Risk' },
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
    deltas,
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

  return (
    <div className="studio-room compare-results">
      <header className="studio-header compare-header">
        <div>
          <p className="map-kicker">Compare</p>
          <h1>Results</h1>
          <p className="studio-sub">
            Multi-scenario KPI matrix, map opens/closes vs Reference, and a
            cost waterfall bridge. Defaults: Active + Baseline as Reference.
          </p>
        </div>
      </header>

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
    return <p className="hint pad">Select at least one scenario.</p>
  }

  return (
    <div className="compare-matrix-wrap">
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
          {KPI_ROWS.map(({ key, label }) => (
            <tr key={key}>
              <th scope="row">{label}</th>
              {selected.map((s) => {
                const cell = s.kpis[key]
                const isRef = s.id === reference.id
                const d = isRef
                  ? { text: '—', tone: 'neutral' as const }
                  : deltaVsReference(
                      cell.value,
                      reference.kpis[key].value,
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
