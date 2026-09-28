import { useMemo, useState, type FormEvent } from 'react'
import {
  COST_DRIVERS,
  defaultDriverRanges,
} from '../data/costSensitivity'
import { SENSITIVITY_PRESETS } from '../data/sensitivity'
import { useFlowform } from '../state/FlowformContext'
import { EmptyState } from './ui/EmptyState'
import { RoomHeader } from './ui/RoomHeader'

export function ScenariosLibrary() {
  const {
    scenarios,
    activeScenarioId,
    setActiveScenarioId,
    deltas,
    composeScenario,
    applySensitivityPreset,
    runCostSensitivity,
    activeScenario,
    stochasticResult,
    stochasticStatus,
    runStochasticOptimize,
    exportStochasticToBrief,
  } = useFlowform()

  const [name, setName] = useState('')
  const [baseId, setBaseId] = useState('baseline')
  const [pickedDeltas, setPickedDeltas] = useState<string[]>([])
  const [status, setStatus] = useState<string | null>(null)
  const [robustObj, setRobustObj] = useState<'expected' | 'minimax' | 'cvar_lite'>(
    'expected',
  )
  const [robustBusy, setRobustBusy] = useState(false)

  const baselines = useMemo(
    () => scenarios.filter((s) => !s.deltaIds?.length || s.id === 'baseline'),
    [scenarios],
  )

  function toggleDelta(id: string) {
    setPickedDeltas((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    )
  }

  function handleCompose(e: FormEvent) {
    e.preventDefault()
    const created = composeScenario({
      name,
      baseId,
      deltaIds: pickedDeltas,
    })
    if (!created) {
      setStatus('Pick a name and at least one promoted delta.')
      return
    }
    setStatus(`Created scenario “${created.name}” and set it Active.`)
    setName('')
    setPickedDeltas([])
  }

  return (
    <div className="studio-room scenarios-library">
      <RoomHeader
        kicker="Scenarios"
        title="Library"
        tip="Browse what-ifs, apply sensitivity presets, and compose Baseline + deltas into a named Active scenario."
      />

      <section className="library-card sensitivity-card" aria-label="Sensitivity presets">
        <div className="library-card-head">
          <h2>Sensitivity presets</h2>
          <span className="muted tiny">from Active · {activeScenario.name}</span>
        </div>
        <p className="hint pad" style={{ paddingTop: 0 }}>
          One-click delta scenarios: fuel shock, demand shift, DC outage, or
          tariff/duty on MX inbound. Creates a new what-if from Active.
        </p>
        <div className="sensitivity-grid">
          {SENSITIVITY_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              className="btn ghost sensitivity-btn"
              onClick={() => {
                const created = applySensitivityPreset(p.id)
                if (created) {
                  setStatus(`Created “${created.name}” from Active and set it Active.`)
                }
              }}
            >
              <strong>{p.label}</strong>
              <span className="muted tiny">{p.description}</span>
            </button>
          ))}
        </div>

        <div className="sens-cost-panel">
          <div className="library-card-head" style={{ paddingTop: '0.35rem' }}>
            <h3 className="cts-side-h" style={{ margin: 0 }}>
              Cost tornado + Monte Carlo
            </h3>
            <span className="muted tiny">
              drivers · Compare → Sensitivity
            </span>
          </div>
          <p className="hint pad" style={{ paddingTop: 0, paddingBottom: '0.35rem' }}>
            One-at-a-time tornado and 300-trial MC on transport $/mi, fuel,
            tariff, demand, facility fixed, inventory holding (default ±%
            ranges). Full chart UI is under Compare → Sensitivity.
          </p>
          <ul className="sens-driver-chips" aria-label="Cost drivers">
            {COST_DRIVERS.map((d) => (
              <li key={d.id}>
                <strong>{d.label}</strong>
                <span className="muted tiny">±{defaultDriverRanges()[d.id]}%</span>
              </li>
            ))}
          </ul>
          <div className="sens-cost-actions">
            <button
              type="button"
              className="btn primary"
              onClick={() => {
                const r = runCostSensitivity({
                  trials: 300,
                  ranges: defaultDriverRanges(),
                  seed: 42,
                })
                if (r) {
                  setStatus(
                    `Cost sensitivity on “${activeScenario.name}”: P10 $${r.p10.toFixed(1)}M · P50 $${r.p50.toFixed(1)}M · P90 $${r.p90.toFixed(1)}M. See Compare → Sensitivity.`,
                  )
                }
              }}
            >
              Run on Active
            </button>
            {activeScenario.costSensitivity && (
              <span className="muted tiny">
                Last P50 ${activeScenario.costSensitivity.p50.toFixed(1)}M ·{' '}
                {activeScenario.costSensitivity.trials} trials
              </span>
            )}
          </div>
        </div>
      </section>


      <section className="library-card sensitivity-card" aria-label="Robust optimize">
        <div className="library-card-head">
          <h2>Robust optimize</h2>
          <span className="muted tiny">scenario-tree · Compare → Robust</span>
        </div>
        <p className="hint pad" style={{ paddingTop: 0 }}>
          Shared first-stage opens across demand shocks (Base / Soft −15% / Surge
          +25%, or selected library scenarios). Objectives: expected, minimax, or
          CVaR-lite. Full table under Compare → Robust.
        </p>
        <div className="sens-cost-actions">
          <label className="field">
            <span>Objective</span>
            <select
              value={robustObj}
              onChange={(e) =>
                setRobustObj(
                  e.target.value as 'expected' | 'minimax' | 'cvar_lite',
                )
              }
            >
              <option value="expected">Expected cost</option>
              <option value="minimax">Minimax</option>
              <option value="cvar_lite">CVaR-lite</option>
            </select>
          </label>
          <button
            type="button"
            className="btn primary"
            disabled={robustBusy || stochasticStatus.phase === 'running'}
            onClick={() => {
              void (async () => {
                setRobustBusy(true)
                const chips =
                  scenarios.length >= 2 ? scenarios.slice(0, 5) : undefined
                const r = await runStochasticOptimize({
                  objective: robustObj,
                  fromScenarioChips: chips,
                })
                setRobustBusy(false)
                if (r?.ok) {
                  setStatus(
                    `Robust ${robustObj}: E[cost] $${r.expectedCostM.toFixed(1)}M · opens ${r.firstStage.openIds.join(', ') || '—'} · EVPI $${r.evpi?.evpiGapM?.toFixed(2) ?? '—'}M. See Compare → Robust.`,
                  )
                } else {
                  setStatus(
                    stochasticStatus.message ||
                      'Robust optimize failed — is API on :5182?',
                  )
                }
              })()
            }}
          >
            {robustBusy || stochasticStatus.phase === 'running'
              ? 'Solving…'
              : 'Run robust optimize'}
          </button>
          <button
            type="button"
            className="btn ghost"
            disabled={!stochasticResult?.ok}
            onClick={() => {
              const ok = exportStochasticToBrief()
              setStatus(
                ok
                  ? 'Robust result exported to Decision Brief.'
                  : 'Nothing to export.',
              )
            }}
          >
            Export to Brief
          </button>
          {stochasticResult?.ok && (
            <span className="muted tiny">
              Last E[cost] ${stochasticResult.expectedCostM.toFixed(1)}M ·{' '}
              {stochasticResult.firstStage.openIds.length} opens
            </span>
          )}
        </div>
      </section>

      <div className="library-grid">
        <section className="library-card" aria-label="Network scenarios">
          <div className="library-card-head">
            <h2>Network scenarios</h2>
            <span className="muted">{scenarios.length}</span>
          </div>
          {scenarios.length === 0 ? (
            <EmptyState
              compact
              title="No scenarios yet"
              body="Compose a what-if from Baseline + deltas, or apply a sensitivity preset."
            />
          ) : (
            <ul className="scenario-list">
              {scenarios.map((s) => {
                const active = s.id === activeScenarioId
                return (
                  <li key={s.id} className={active ? 'active' : ''}>
                    <div className="scenario-list-main">
                      <strong>{s.name}</strong>
                      <span className="chip-tag">{s.tag}</span>
                      {s.deltaIds && s.deltaIds.length > 0 && (
                        <span className="muted tiny">
                          +{s.deltaIds.length} delta
                          {s.deltaIds.length === 1 ? '' : 's'}
                        </span>
                      )}
                    </div>
                    <div className="scenario-list-meta">
                      <span className="kpi-mini">
                        {s.kpis.cost.value} · {s.kpis.service.value}
                      </span>
                      <button
                        type="button"
                        className={active ? 'btn primary' : 'btn ghost'}
                        onClick={() => setActiveScenarioId(s.id)}
                        disabled={active}
                      >
                        {active ? 'Active' : 'Set Active'}
                      </button>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        <section className="library-card" aria-label="Delta items">
          <div className="library-card-head">
            <h2>Delta items</h2>
            <span className="muted">{deltas.length}</span>
          </div>
          {deltas.length === 0 ? (
            <EmptyState
              compact
              title="No promoted deltas"
              body="Run Greenfield Studio and Promote selected candidates to seed compose."
            />
          ) : (
            <ul className="delta-list">
              {deltas.map((d) => (
                <li key={d.id}>
                  <div>
                    <strong>{d.name}</strong>
                    <span className="chip-tag">Candidates</span>
                  </div>
                  <p className="muted tiny">
                    {d.candidates.length} sites ·{' '}
                    {new Date(d.createdAt).toLocaleString(undefined, {
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </p>
                  <ul className="delta-sites">
                    {d.candidates.map((c) => (
                      <li key={c.id}>
                        {c.name} · {c.region} · score {c.score}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="library-card compose-card" aria-label="Compose scenario">
          <div className="library-card-head">
            <h2>Compose</h2>
          </div>
          <form className="compose-form" onSubmit={handleCompose}>
            <label className="field">
              <span>Scenario name</span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Baseline + Midwest greenfield"
                required
              />
            </label>

            <label className="field">
              <span>Base</span>
              <select
                value={baseId}
                onChange={(e) => setBaseId(e.target.value)}
              >
                {baselines.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>

            <fieldset className="delta-pick">
              <legend>Promoted greenfield deltas</legend>
              {deltas.length === 0 ? (
                <p className="hint">Promote candidates from Greenfield first.</p>
              ) : (
                deltas.map((d) => (
                  <label key={d.id} className="toggle-row">
                    <input
                      type="checkbox"
                      checked={pickedDeltas.includes(d.id)}
                      onChange={() => toggleDelta(d.id)}
                    />
                    <span>
                      {d.name}{' '}
                      <span className="muted">({d.candidates.length})</span>
                    </span>
                  </label>
                ))
              )}
            </fieldset>

            <button
              type="submit"
              className="btn primary"
              disabled={deltas.length === 0}
            >
              Compose &amp; set Active
            </button>
            {status && <p className="status-line">{status}</p>}
          </form>
        </section>
      </div>
    </div>
  )
}
