import { useMemo, useState, type FormEvent } from 'react'
import {
  addCapexEvent,
  eventKindLabel,
  formatMultiPeriodBriefSection,
  formatRoadmapBriefSection,
  roadmapYearSummaries,
  type CapexEventKind,
  yearLabelFor,
} from '../data/capexRoadmap'
import type { MultiPeriodMode } from '../data/optimizeApi'
import { useFlowform } from '../state/FlowformContext'
import { EmptyState } from './ui/EmptyState'
import { RoomHeader } from './ui/RoomHeader'

const KINDS: CapexEventKind[] = ['open', 'expand', 'close']

export function RoadmapStudio() {
  const {
    network,
    constraints,
    activeScenario,
    capexRoadmap,
    setCapexRoadmap,
    updateCapexEvent,
    removeCapexEvent,
    resetCapexRoadmap,
    applyRoadmapYearSlice,
    exportRoadmapToBrief,
    multiPeriodResult,
    multiPeriodStatus,
    runMultiPeriodOptimize,
    exportMultiPeriodToBrief,
    clearMultiPeriodResult,
  } = useFlowform()

  const summaries = useMemo(
    () => roadmapYearSummaries(capexRoadmap, network),
    [capexRoadmap, network],
  )

  const maxCumCapex = Math.max(
    1,
    ...summaries.map((s) => s.cumulativeCapexM),
  )
  const maxCapUnits = Math.max(
    1,
    ...summaries.map((s) => s.totalCapacityUnits),
  )

  const [applyYear, setApplyYear] = useState(
    Math.min(2, capexRoadmap.yearCount - 1),
  )
  const [scenarioName, setScenarioName] = useState('')
  const [status, setStatus] = useState<string | null>(null)

  const [draftName, setDraftName] = useState('')
  const [draftKind, setDraftKind] = useState<CapexEventKind>('expand')
  const [draftYear, setDraftYear] = useState(1)
  const [draftNodeId, setDraftNodeId] = useState('')
  const [draftCapex, setDraftCapex] = useState(5)
  const [draftCapDelta, setDraftCapDelta] = useState(4)
  const [optMode, setOptMode] = useState<MultiPeriodMode>('choose_timing')
  const [discountRatePct, setDiscountRatePct] = useState(10)
  const [optBusy, setOptBusy] = useState(false)

  const facilities = useMemo(
    () =>
      network.nodes.filter(
        (n) =>
          n.kind === 'dc' ||
          n.kind === 'plant' ||
          n.kind === 'candidate',
      ),
    [network.nodes],
  )

  const sortedEvents = useMemo(
    () =>
      [...capexRoadmap.events].sort(
        (a, b) => a.year - b.year || a.name.localeCompare(b.name),
      ),
    [capexRoadmap.events],
  )

  function handleAdd(e: FormEvent) {
    e.preventDefault()
    const fac = facilities.find((n) => n.id === draftNodeId)
    const name =
      draftName.trim() ||
      `${eventKindLabel(draftKind)} ${fac?.name ?? 'facility'}`
    setCapexRoadmap(
      addCapexEvent(capexRoadmap, {
        name,
        kind: draftKind,
        year: draftYear,
        nodeId:
          draftKind === 'open' && !draftNodeId
            ? `roadmap-new-${Date.now().toString(36)}`
            : draftNodeId || facilities[0]?.id || 'n-new',
        nodeName: fac?.name ?? (draftKind === 'open' ? 'New DC' : name),
        capexM: draftCapex,
        capacityDelta:
          draftKind === 'close' ? -Math.abs(draftCapDelta) : draftCapDelta,
        region: fac?.region,
        facilityKind: draftKind === 'open' ? 'dc' : undefined,
      }),
    )
    setStatus(`Added “${name}” in Y${draftYear}.`)
    setDraftName('')
  }

  function handleApply() {
    const result = applyRoadmapYearSlice(
      applyYear,
      scenarioName.trim() || undefined,
    )
    if (!result) {
      setStatus('Could not apply year slice.')
      return
    }
    setStatus(
      `Applied ${result.summary.label} (${result.summary.yearLabel}): $${result.summary.cumulativeCapexM}M cum CapEx · ${result.appliedEvents.length} events · draft “${result.draftScenario.name}” is Active.`,
    )
  }

  function handleExportBrief() {
    const ok = exportRoadmapToBrief()
    setStatus(
      ok
        ? 'Roadmap summary appended to Decision Brief notes (and CapEx overnight assumption unchecked).'
        : 'Brief export failed.',
    )
  }

  async function handleOptimizeTiming() {
    setOptBusy(true)
    setStatus('Running multi-period CapEx NPV optimize…')
    try {
      const result = await runMultiPeriodOptimize({
        mode: optMode,
        discountRate: discountRatePct / 100,
        applyTimingToRoadmap: true,
      })
      if (!result) {
        setStatus(
          multiPeriodStatus.message ||
            'Multi-period optimize failed (is the API on :5182?).',
        )
        return
      }
      if (!result.ok) {
        setStatus(`Infeasible / ${result.status}. See results panel.`)
        return
      }
      setStatus(
        `NPV $${result.npv.totalM.toFixed(2)}M · mode ${result.mode} · r=${discountRatePct}% · timing applied to roadmap events.`,
      )
    } finally {
      setOptBusy(false)
    }
  }

  function handleExportNpvBrief() {
    const ok = exportMultiPeriodToBrief()
    setStatus(
      ok
        ? 'NPV plan + roadmap appended to Decision Brief notes.'
        : 'Run Optimize timing first, then export.',
    )
  }

  return (
    <div className="studio-room roadmap-studio">
      <RoomHeader
        kicker="CapEx"
        title="Multi-year roadmap"
        tip={`Phase open / close / expand across Y0–${capexRoadmap.yearCount - 1}. Optimize timing minimizes CapEx+OpEx+transport NPV, or apply a year slice / export to Brief.`}
        actions={
          <>
            <button
              type="button"
              className="btn ghost"
              onClick={() => {
                resetCapexRoadmap()
                clearMultiPeriodResult()
                setStatus('Reset to sample CapEx roadmap.')
              }}
            >
              Reset sample
            </button>
            <button type="button" className="btn ghost" onClick={handleExportBrief}>
              Export to Brief
            </button>
            <button
              type="button"
              className="btn ghost"
              onClick={handleExportNpvBrief}
              disabled={!multiPeriodResult?.ok}
            >
              Export NPV to Brief
            </button>
          </>
        }
      />

      <div className="roadmap-kpi-strip" aria-label="Roadmap totals">
        {summaries.length > 0 && (
          <>
            <div className="library-card roadmap-kpi">
              <span className="muted tiny">Cum CapEx (Y{capexRoadmap.yearCount - 1})</span>
              <strong>${summaries[summaries.length - 1]!.cumulativeCapexM}M</strong>
            </div>
            <div className="library-card roadmap-kpi">
              <span className="muted tiny">Capacity units</span>
              <strong>{summaries[summaries.length - 1]!.totalCapacityUnits}</strong>
            </div>
            <div className="library-card roadmap-kpi">
              <span className="muted tiny">Events</span>
              <strong>{capexRoadmap.events.length}</strong>
            </div>
            <div className="library-card roadmap-kpi">
              <span className="muted tiny">Open facilities (end)</span>
              <strong>{summaries[summaries.length - 1]!.openFacilityCount}</strong>
            </div>
          </>
        )}
      </div>

      <div className="studio-body roadmap-body">
        <aside className="wizard-panel" aria-label="Roadmap controls">
          <h2>Base year</h2>
          <label className="field">
            <span>Y0 label</span>
            <input
              type="text"
              value={capexRoadmap.baseYearLabel}
              onChange={(e) =>
                setCapexRoadmap({
                  ...capexRoadmap,
                  baseYearLabel: e.target.value || 'FY26',
                })
              }
            />
          </label>
          <label className="field">
            <span>Years (2–8)</span>
            <input
              type="number"
              min={2}
              max={8}
              value={capexRoadmap.yearCount}
              onChange={(e) => {
                const yearCount = Math.max(
                  2,
                  Math.min(8, Number(e.target.value) || 6),
                )
                setCapexRoadmap({
                  ...capexRoadmap,
                  yearCount,
                  events: capexRoadmap.events.map((ev) => ({
                    ...ev,
                    year: Math.min(ev.year, yearCount - 1),
                  })),
                })
              }}
            />
          </label>

          <div className="promote-block">
            <h3>Add event</h3>
            <form className="compose-form" onSubmit={handleAdd}>
              <label className="field">
                <span>Kind</span>
                <select
                  value={draftKind}
                  onChange={(e) =>
                    setDraftKind(e.target.value as CapexEventKind)
                  }
                >
                  {KINDS.map((k) => (
                    <option key={k} value={k}>
                      {eventKindLabel(k)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Year</span>
                <select
                  value={draftYear}
                  onChange={(e) => setDraftYear(Number(e.target.value))}
                >
                  {Array.from({ length: capexRoadmap.yearCount }, (_, i) => (
                    <option key={i} value={i}>
                      Y{i} · {yearLabelFor(capexRoadmap.baseYearLabel, i)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Facility</span>
                <select
                  value={draftNodeId}
                  onChange={(e) => setDraftNodeId(e.target.value)}
                >
                  <option value="">
                    {draftKind === 'open' ? '— New node —' : 'Select…'}
                  </option>
                  {facilities.map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.name} ({n.kind})
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Name</span>
                <input
                  type="text"
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  placeholder="Optional label"
                />
              </label>
              <label className="field">
                <span>CapEx $M</span>
                <input
                  type="number"
                  step={0.1}
                  value={draftCapex}
                  onChange={(e) => setDraftCapex(Number(e.target.value))}
                />
              </label>
              <label className="field">
                <span>Capacity Δ</span>
                <input
                  type="number"
                  step={0.5}
                  value={draftCapDelta}
                  onChange={(e) => setDraftCapDelta(Number(e.target.value))}
                />
              </label>
              <button type="submit" className="btn primary">
                Add event
              </button>
            </form>
          </div>

          <div className="promote-block">
            <h3>Optimize timing</h3>
            <p className="hint">
              Call API <code>/optimize/multi-period</code> to minimize NPV of
              CapEx + OpEx + transport. Choose timing shifts event years within
              Y0–Y{capexRoadmap.yearCount - 1}; force timeline keeps stated years.
            </p>
            <label className="field">
              <span>Mode</span>
              <select
                value={optMode}
                onChange={(e) =>
                  setOptMode(e.target.value as MultiPeriodMode)
                }
              >
                <option value="choose_timing">Choose timing (NPV)</option>
                <option value="force_timeline">Force timeline</option>
              </select>
            </label>
            <label className="field">
              <span>Discount rate %</span>
              <input
                type="number"
                min={0}
                max={50}
                step={0.5}
                value={discountRatePct}
                onChange={(e) =>
                  setDiscountRatePct(Number(e.target.value) || 0)
                }
              />
            </label>
            <button
              type="button"
              className="btn primary"
              disabled={optBusy || multiPeriodStatus.phase === 'running'}
              onClick={() => void handleOptimizeTiming()}
            >
              {optBusy ? 'Optimizing…' : 'Optimize timing'}
            </button>
            {multiPeriodStatus.phase !== 'idle' && multiPeriodStatus.message && (
              <p className="muted tiny">{multiPeriodStatus.message}</p>
            )}
          </div>

          <div className="promote-block">
            <h3>Apply year slice</h3>
            <p className="hint">
              Materialize network state through the selected year as an Active
              scenario (opens / closes / expands applied). Constraints CapEx
              budget grows with cumulative spend.
            </p>
            <label className="field">
              <span>Through year</span>
              <select
                value={applyYear}
                onChange={(e) => setApplyYear(Number(e.target.value))}
              >
                {summaries.map((s) => (
                  <option key={s.year} value={s.year}>
                    {s.label} · {s.yearLabel} · ${s.cumulativeCapexM}M cum
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Scenario name</span>
              <input
                type="text"
                value={scenarioName}
                onChange={(e) => setScenarioName(e.target.value)}
                placeholder={`Roadmap Y${applyYear}…`}
              />
            </label>
            <button type="button" className="btn primary" onClick={handleApply}>
              Apply as scenario
            </button>
            <p className="muted tiny">
              Active: {activeScenario.name} · sites{' '}
              {constraints.facilities.filter((f) => f.status === 'open').length}{' '}
              open
            </p>
          </div>

          {status && <p className="status-line">{status}</p>}
        </aside>

        <div className="roadmap-main">
          <section className="library-card" aria-label="Gantt timeline">
            <div className="library-card-head">
              <h2>Timeline (Gantt-lite)</h2>
              <span className="muted tiny">
                {capexRoadmap.baseYearLabel} →{' '}
                {yearLabelFor(
                  capexRoadmap.baseYearLabel,
                  capexRoadmap.yearCount - 1,
                )}
              </span>
            </div>
            <div className="gantt-wrap">
              <div
                className="gantt-head"
                style={{
                  gridTemplateColumns: `10rem repeat(${capexRoadmap.yearCount}, minmax(3.5rem, 1fr))`,
                }}
              >
                <span className="muted tiny">Event</span>
                {summaries.map((s) => (
                  <span key={s.year} className="gantt-year-h">
                    {s.label}
                    <em>{s.yearLabel}</em>
                  </span>
                ))}
              </div>
              {sortedEvents.length === 0 ? (
                <EmptyState
                  compact
                  title="No CapEx events"
                  body="Add an open / expand / close event, or reset the sample roadmap."
                  action={
                    <button
                      type="button"
                      className="btn ghost"
                      onClick={() => {
                        resetCapexRoadmap()
                        setStatus('Reset to sample CapEx roadmap.')
                      }}
                    >
                      Reset sample
                    </button>
                  }
                />
              ) : (
                <ul className="gantt-rows">
                  {sortedEvents.map((ev) => (
                    <li
                      key={ev.id}
                      className="gantt-row"
                      style={{
                        gridTemplateColumns: `10rem repeat(${capexRoadmap.yearCount}, minmax(3.5rem, 1fr))`,
                      }}
                    >
                      <div className="gantt-label">
                        <strong>{ev.name}</strong>
                        <span className={`chip-tag kind-${ev.kind}`}>
                          {eventKindLabel(ev.kind)}
                        </span>
                      </div>
                      {summaries.map((s) => (
                        <div key={s.year} className="gantt-cell">
                          {ev.year === s.year && (
                            <div
                              className={`gantt-bar kind-${ev.kind}`}
                              title={`$${ev.capexM}M · cap ${ev.capacityDelta >= 0 ? '+' : ''}${ev.capacityDelta}`}
                            >
                              ${ev.capexM}M
                            </div>
                          )}
                        </div>
                      ))}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          <section className="library-card" aria-label="Cumulative KPIs">
            <div className="library-card-head">
              <h2>Cumulative CapEx &amp; capacity</h2>
            </div>
            <div className="roadmap-bars">
              {summaries.map((s) => (
                <div key={s.year} className="roadmap-bar-col">
                  <div className="roadmap-bar-stack">
                    <div
                      className="roadmap-bar capex"
                      style={{
                        height: `${Math.max(8, (s.cumulativeCapexM / maxCumCapex) * 100)}%`,
                      }}
                      title={`Cum CapEx $${s.cumulativeCapexM}M`}
                    />
                    <div
                      className="roadmap-bar capacity"
                      style={{
                        height: `${Math.max(8, (s.totalCapacityUnits / maxCapUnits) * 100)}%`,
                      }}
                      title={`Capacity ${s.totalCapacityUnits}`}
                    />
                  </div>
                  <span className="muted tiny">
                    {s.label}
                    <br />
                    ${s.cumulativeCapexM}M
                  </span>
                </div>
              ))}
            </div>
            <p className="hint pad" style={{ paddingTop: 0 }}>
              <span className="roadmap-legend capex" /> Cum CapEx ·{' '}
              <span className="roadmap-legend capacity" /> Capacity units
            </p>
            <div className="table-scroll">
              <table className="data-table roadmap-table">
                <thead>
                  <tr>
                    <th>Year</th>
                    <th>Label</th>
                    <th>Events</th>
                    <th>CapEx $M</th>
                    <th>Cum CapEx</th>
                    <th>Cap Δ</th>
                    <th>Capacity</th>
                    <th>Open</th>
                  </tr>
                </thead>
                <tbody>
                  {summaries.map((s) => (
                    <tr
                      key={s.year}
                      className={s.year === applyYear ? 'is-focus' : undefined}
                    >
                      <td>{s.label}</td>
                      <td>{s.yearLabel}</td>
                      <td>{s.eventsThisYear.length}</td>
                      <td>{s.capexThisYearM}</td>
                      <td>
                        <strong>{s.cumulativeCapexM}</strong>
                      </td>
                      <td>
                        {s.capacityDeltaThisYear >= 0 ? '+' : ''}
                        {s.capacityDeltaThisYear}
                      </td>
                      <td>{s.totalCapacityUnits}</td>
                      <td>{s.openFacilityCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {multiPeriodResult && (
            <section className="library-card" aria-label="Multi-period NPV results">
              <div className="library-card-head">
                <h2>Multi-period NPV results</h2>
                <span className="muted tiny">
                  {multiPeriodResult.mode} · r=
                  {(multiPeriodResult.discountRate * 100).toFixed(1)}%
                  {multiPeriodResult.solveSeconds != null
                    ? ` · ${multiPeriodResult.solveSeconds}s`
                    : ''}
                </span>
              </div>
              <div className="roadmap-kpi-strip npv-strip">
                <div className="library-card roadmap-kpi">
                  <span className="muted tiny">NPV total</span>
                  <strong>${multiPeriodResult.npv.totalM.toFixed(2)}M</strong>
                </div>
                <div className="library-card roadmap-kpi">
                  <span className="muted tiny">CapEx NPV</span>
                  <strong>${multiPeriodResult.npv.capexNpvM.toFixed(2)}M</strong>
                </div>
                <div className="library-card roadmap-kpi">
                  <span className="muted tiny">OpEx NPV</span>
                  <strong>${multiPeriodResult.npv.opexNpvM.toFixed(2)}M</strong>
                </div>
                <div className="library-card roadmap-kpi">
                  <span className="muted tiny">Transport NPV</span>
                  <strong>
                    ${multiPeriodResult.npv.transportNpvM.toFixed(2)}M
                  </strong>
                </div>
              </div>
              <div className="table-scroll">
                <table className="data-table roadmap-table">
                  <thead>
                    <tr>
                      <th>Year</th>
                      <th>Open</th>
                      <th>CapEx</th>
                      <th>OpEx</th>
                      <th>Transport</th>
                      <th>NPV contrib</th>
                      <th>Service</th>
                      <th>Flows</th>
                    </tr>
                  </thead>
                  <tbody>
                    {multiPeriodResult.years.map((y) => (
                      <tr key={y.year}>
                        <td>{y.label}</td>
                        <td title={y.openIds.join(', ')}>{y.openIds.length}</td>
                        <td>${y.capexM.toFixed(2)}M</td>
                        <td>${y.opexM.toFixed(2)}M</td>
                        <td>${y.transportM.toFixed(2)}M</td>
                        <td>${y.npvContributionM.toFixed(2)}M</td>
                        <td>{y.servicePct.toFixed(1)}%</td>
                        <td>
                          {y.flowsSummary
                            ? `${y.flowsSummary.arcCount} arcs / ${Math.round(y.flowsSummary.totalVolume)} u`
                            : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {multiPeriodResult.eventTiming.length > 0 && (
                <ul className="roadmap-event-list npv-timing">
                  {multiPeriodResult.eventTiming.map((e) => (
                    <li key={e.eventId}>
                      <div className="roadmap-event-main">
                        <strong>{e.name}</strong>
                        <span className={`chip-tag kind-${e.kind}`}>
                          {eventKindLabel(e.kind as CapexEventKind)}
                        </span>
                        <span className="muted tiny">
                          → Y{e.year}
                          {e.preferredYear != null &&
                          e.preferredYear !== e.year
                            ? ` (was Y${e.preferredYear})`
                            : ''}
                          · ${e.capexM}M
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          <section className="library-card" aria-label="Event list">
            <div className="library-card-head">
              <h2>Events</h2>
              <span className="muted">{sortedEvents.length}</span>
            </div>
            {sortedEvents.length === 0 ? (
              <EmptyState
                compact
                title="No CapEx events"
                body="Add events in the form, or reset the sample roadmap to explore the timeline."
              />
            ) : (
              <ul className="roadmap-event-list">
                {sortedEvents.map((ev) => (
                  <li key={ev.id}>
                    <div className="roadmap-event-main">
                      <strong>{ev.name}</strong>
                      <span className={`chip-tag kind-${ev.kind}`}>
                        {eventKindLabel(ev.kind)}
                      </span>
                      <span className="muted tiny">
                        Y{ev.year} · {yearLabelFor(capexRoadmap.baseYearLabel, ev.year)}
                      </span>
                    </div>
                    <div className="roadmap-event-edits">
                      <label className="field compact">
                        <span>Year</span>
                        <select
                          value={ev.year}
                          onChange={(e) =>
                            updateCapexEvent(ev.id, {
                              year: Number(e.target.value),
                            })
                          }
                        >
                          {Array.from(
                            { length: capexRoadmap.yearCount },
                            (_, i) => (
                              <option key={i} value={i}>
                                Y{i}
                              </option>
                            ),
                          )}
                        </select>
                      </label>
                      <label className="field compact">
                        <span>CapEx $M</span>
                        <input
                          type="number"
                          step={0.1}
                          value={ev.capexM}
                          onChange={(e) =>
                            updateCapexEvent(ev.id, {
                              capexM: Number(e.target.value),
                            })
                          }
                        />
                      </label>
                      <label className="field compact">
                        <span>Cap Δ</span>
                        <input
                          type="number"
                          step={0.5}
                          value={ev.capacityDelta}
                          onChange={(e) =>
                            updateCapexEvent(ev.id, {
                              capacityDelta: Number(e.target.value),
                            })
                          }
                        />
                      </label>
                      <button
                        type="button"
                        className="btn ghost"
                        onClick={() => {
                          removeCapexEvent(ev.id)
                          setStatus(`Removed “${ev.name}”.`)
                        }}
                      >
                        Remove
                      </button>
                    </div>
                    {ev.notes && <p className="muted tiny">{ev.notes}</p>}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <details className="library-card roadmap-preview">
            <summary>Brief markdown preview</summary>
            <pre className="roadmap-md">
              {[
                formatRoadmapBriefSection(capexRoadmap, network),
                multiPeriodResult?.ok
                  ? formatMultiPeriodBriefSection(multiPeriodResult)
                  : null,
              ]
                .filter(Boolean)
                .join('\n\n')}
            </pre>
          </details>
        </div>
      </div>
    </div>
  )
}
