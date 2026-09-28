import { useMemo } from 'react'
import {
  buildBriefHtml,
  buildBriefMarkdown,
  downloadTextFile,
} from '../data/briefExport'
import {
  parseMoneyM,
  parsePercent,
  PROJECT_NAME,
  type Scenario,
} from '../data/sampleNetwork'
import { useFlowform } from '../state/FlowformContext'

type Props = {
  onHandoff?: () => void
}

export function DecisionBrief({ onHandoff }: Props) {
  const {
    scenarios,
    brief,
    updateBrief,
    sendBriefToHandoff,
    activeScenarioId,
    setActiveScenarioId,
    horizon,
  } = useFlowform()

  const reference =
    scenarios.find((s) => s.id === 'baseline') ?? scenarios[0]

  const cards = useMemo(() => {
    const ids = brief.comparedIds.length
      ? brief.comparedIds
      : [reference.id, activeScenarioId]
    const uniq = Array.from(new Set(ids)).slice(0, 4)
    return uniq
      .map((id) => scenarios.find((s) => s.id === id))
      .filter((s): s is Scenario => !!s)
  }, [brief.comparedIds, scenarios, reference.id, activeScenarioId])

  const recommended =
    scenarios.find((s) => s.id === brief.recommendedScenarioId) ??
    cards.find((s) => s.id !== reference.id) ??
    cards[0]

  function toggleAssumption(id: string) {
    updateBrief({
      assumptions: brief.assumptions.map((a) =>
        a.id === id ? { ...a, checked: !a.checked } : a,
      ),
    })
  }

  function toggleCompared(id: string) {
    const has = brief.comparedIds.includes(id)
    let next = has
      ? brief.comparedIds.filter((x) => x !== id)
      : [...brief.comparedIds, id]
    if (next.length < 2) {
      // keep at least reference + one
      next = Array.from(new Set([reference.id, id, ...brief.comparedIds])).slice(
        0,
        4,
      )
    }
    updateBrief({ comparedIds: next.slice(0, 4) })
  }

  function handleSend() {
    sendBriefToHandoff()
    onHandoff?.()
  }

  function exportMarkdown() {
    const body = buildBriefMarkdown({
      brief,
      scenarios,
      projectName: PROJECT_NAME,
      horizon,
    })
    downloadTextFile(
      `flowform-brief-${horizon}.md`,
      body,
      'text/markdown;charset=utf-8',
    )
  }

  function exportHtml() {
    const body = buildBriefHtml({
      brief,
      scenarios,
      projectName: PROJECT_NAME,
      horizon,
    })
    downloadTextFile(
      `flowform-brief-${horizon}.html`,
      body,
      'text/html;charset=utf-8',
    )
  }

  const bannerText = recommended
    ? recommendCopy(recommended, reference)
    : 'Select a recommended scenario to brief stakeholders.'

  return (
    <div className="studio-room brief-room">
      <header className="studio-header">
        <div>
          <p className="map-kicker">Brief</p>
          <h1>Decision Brief</h1>
          <p className="studio-sub">
            Recommendation vs Reference, scenario cards, and assumptions
            checklist — then send to Handoff for Ritara intake.
          </p>
        </div>
      </header>

      <div className="brief-layout">
        <div className="brief-banner" role="status">
          <div>
            <p className="map-kicker">Recommendation</p>
            <h2>{recommended?.name ?? '—'}</h2>
            <p>{bannerText}</p>
          </div>
          <div className="brief-banner-actions">
            <label className="field">
              <span>Recommended scenario</span>
              <select
                value={brief.recommendedScenarioId ?? ''}
                onChange={(e) => {
                  updateBrief({ recommendedScenarioId: e.target.value })
                  setActiveScenarioId(e.target.value)
                }}
              >
                {scenarios.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.tag})
                  </option>
                ))}
              </select>
            </label>
            <div className="brief-export-row">
              <button type="button" className="btn ghost" onClick={exportMarkdown}>
                Download Markdown
              </button>
              <button type="button" className="btn ghost" onClick={exportHtml}>
                Printable HTML
              </button>
              <button type="button" className="btn primary" onClick={handleSend}>
                Send to Handoff
              </button>
            </div>
            {brief.sentToHandoffAt && (
              <p className="status-line">
                Sent {new Date(brief.sentToHandoffAt).toLocaleString()}
              </p>
            )}
          </div>
        </div>

        <div className="brief-cards">
          {cards.map((s) => (
            <ScenarioBriefCard
              key={s.id}
              scenario={s}
              reference={reference}
              isRef={s.id === reference.id}
              isRec={s.id === recommended?.id}
            />
          ))}
        </div>

        <div className="brief-bottom">
          <section className="library-card">
            <h2>Scenarios in brief</h2>
            <ul className="brief-pick-list">
              {scenarios.map((s) => (
                <li key={s.id}>
                  <label className="toggle-row">
                    <input
                      type="checkbox"
                      checked={brief.comparedIds.includes(s.id)}
                      onChange={() => toggleCompared(s.id)}
                    />
                    <span>
                      {s.name}{' '}
                      <em className="tag-inline">{s.tag}</em>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </section>

          <section className="library-card">
            <h2>Assumptions checklist</h2>
            <ul className="brief-pick-list">
              {brief.assumptions.map((a) => (
                <li key={a.id}>
                  <label className="toggle-row">
                    <input
                      type="checkbox"
                      checked={a.checked}
                      onChange={() => toggleAssumption(a.id)}
                    />
                    <span>{a.label}</span>
                  </label>
                </li>
              ))}
            </ul>
          </section>

          <section className="library-card">
            <h2>Notes</h2>
            <label className="field">
              <span>Stakeholder narrative</span>
              <textarea
                className="brief-notes"
                rows={6}
                value={brief.notes}
                placeholder="Why this footprint, what we deferred, open risks…"
                onChange={(e) => updateBrief({ notes: e.target.value })}
              />
            </label>
          </section>
        </div>
      </div>
    </div>
  )
}

function ScenarioBriefCard({
  scenario,
  reference,
  isRef,
  isRec,
}: {
  scenario: Scenario
  reference: Scenario
  isRef: boolean
  isRec: boolean
}) {
  const costDelta =
    parseMoneyM(scenario.kpis.cost.value) -
    parseMoneyM(reference.kpis.cost.value)
  const serviceDelta =
    parsePercent(scenario.kpis.service.value) -
    parsePercent(reference.kpis.service.value)

  return (
    <article
      className={`brief-card${isRef ? ' is-ref' : ''}${isRec ? ' is-rec' : ''}`}
    >
      <header>
        <h3>{scenario.name}</h3>
        <span className="tag-inline">{scenario.tag}</span>
      </header>
      {isRef && <p className="brief-card-flag">Reference</p>}
      {isRec && !isRef && <p className="brief-card-flag rec">Recommended</p>}
      <dl className="brief-kpis">
        <div>
          <dt>Cost</dt>
          <dd>{scenario.kpis.cost.value}</dd>
        </div>
        <div>
          <dt>Service</dt>
          <dd>{scenario.kpis.service.value}</dd>
        </div>
        <div>
          <dt>CapEx</dt>
          <dd>{scenario.kpis.capex.value}</dd>
        </div>
        <div>
          <dt>CO₂</dt>
          <dd>{scenario.kpis.co2.value}</dd>
        </div>
      </dl>
      {!isRef && (
        <p className="brief-vs">
          vs {reference.name}:{' '}
          <span className={costDelta <= 0 ? 'delta-up' : 'delta-down'}>
            {costDelta <= 0 ? '−' : '+'}${Math.abs(costDelta).toFixed(1)}M cost
          </span>
          {' · '}
          <span className={serviceDelta >= 0 ? 'delta-up' : 'delta-down'}>
            {serviceDelta >= 0 ? '+' : '−'}
            {Math.abs(serviceDelta).toFixed(1)}pp service
          </span>
        </p>
      )}
      {scenario.optimizeMeta && (
        <p className="brief-meta">
          Heuristic {scenario.optimizeMeta.heuristic}: open{' '}
          {scenario.optimizeMeta.openedIds.length}, close{' '}
          {scenario.optimizeMeta.closedIds.length}
        </p>
      )}
    </article>
  )
}

function recommendCopy(rec: Scenario, ref: Scenario): string {
  const costDelta =
    parseMoneyM(rec.kpis.cost.value) - parseMoneyM(ref.kpis.cost.value)
  const serviceDelta =
    parsePercent(rec.kpis.service.value) - parsePercent(ref.kpis.service.value)
  const parts = [
    `Prefer “${rec.name}” over ${ref.name}`,
    costDelta <= 0
      ? `saving $${Math.abs(costDelta).toFixed(1)}M annualized cost`
      : `at +$${costDelta.toFixed(1)}M cost`,
    serviceDelta >= 0
      ? `with +${serviceDelta.toFixed(1)}pp service`
      : `with ${serviceDelta.toFixed(1)}pp service`,
  ]
  if (rec.optimizeMeta) {
    parts.push('(from Run optimize heuristic v1)')
  }
  return parts.join(' ') + '.'
}
