import { useMemo, useState, type FormEvent } from 'react'
import { SENSITIVITY_PRESETS } from '../data/sensitivity'
import { useFlowform } from '../state/FlowformContext'

export function ScenariosLibrary() {
  const {
    scenarios,
    activeScenarioId,
    setActiveScenarioId,
    deltas,
    composeScenario,
    applySensitivityPreset,
    activeScenario,
  } = useFlowform()

  const [name, setName] = useState('')
  const [baseId, setBaseId] = useState('baseline')
  const [pickedDeltas, setPickedDeltas] = useState<string[]>([])
  const [status, setStatus] = useState<string | null>(null)

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
      <header className="studio-header">
        <div>
          <p className="map-kicker">Scenarios</p>
          <h1>Library</h1>
          <p className="studio-sub">
            Browse network scenarios and promoted deltas. Compose Baseline +
            greenfield into a named what-if, then switch Active from here.
          </p>
        </div>
      </header>

      <section className="library-card sensitivity-card" aria-label="Sensitivity presets">
        <div className="library-card-head">
          <h2>Sensitivity presets</h2>
          <span className="muted tiny">from Active · {activeScenario.name}</span>
        </div>
        <p className="hint pad" style={{ paddingTop: 0 }}>
          One-click delta scenarios: fuel shock, demand shift, or DC outage.
          Creates a new what-if branched from Active and sets it Active.
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
      </section>

      <div className="library-grid">
        <section className="library-card" aria-label="Network scenarios">
          <div className="library-card-head">
            <h2>Network scenarios</h2>
            <span className="muted">{scenarios.length}</span>
          </div>
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
        </section>

        <section className="library-card" aria-label="Delta items">
          <div className="library-card-head">
            <h2>Delta items</h2>
            <span className="muted">{deltas.length}</span>
          </div>
          {deltas.length === 0 ? (
            <p className="hint pad">
              No deltas yet. Run Greenfield Studio and Promote selected
              candidates.
            </p>
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
