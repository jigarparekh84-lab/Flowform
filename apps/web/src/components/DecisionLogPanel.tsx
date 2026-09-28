import { useMemo, useState } from 'react'
import {
  DECISION_ACTION_LABELS,
  DECISION_ACTION_TYPES,
  downloadDecisionLogJson,
  filterDecisionLog,
  formatDecisionWhen,
  type DecisionActionType,
} from '../data/decisionLog'
import { useFlowform } from '../state/FlowformContext'

type Props = {
  compact?: boolean
  /** Limit visible rows (newest first). */
  limit?: number
}

export function DecisionLogPanel({ compact, limit = 80 }: Props) {
  const {
    decisionLog,
    clearDecisionLog,
    projectName,
    activeProjectId,
    scenarios,
  } = useFlowform()

  const [filter, setFilter] = useState<DecisionActionType | 'all'>('all')

  const rows = useMemo(() => {
    const list = filterDecisionLog(decisionLog, filter)
    return list.slice(0, limit)
  }, [decisionLog, filter, limit])

  const scenarioName = (id?: string) => {
    if (!id) return null
    return scenarios.find((s) => s.id === id)?.name ?? id
  }

  function handleClear() {
    if (decisionLog.length === 0) return
    if (
      !confirm(
        `Clear ${decisionLog.length} decision log entr${decisionLog.length === 1 ? 'y' : 'ies'}? This cannot be undone.`,
      )
    ) {
      return
    }
    clearDecisionLog()
  }

  function handleExport() {
    downloadDecisionLogJson(decisionLog, {
      projectId: activeProjectId ?? undefined,
      projectName,
    })
  }

  return (
    <section
      className={compact ? 'decision-log-panel compact' : 'decision-log-panel'}
      aria-label="Decision log"
    >
      <div className="decision-log-head">
        <div>
          <h2>Decision log</h2>
          <p className="muted tiny">
            Append-only audit of meaningful actions ({decisionLog.length} total)
          </p>
        </div>
        <div className="decision-log-actions">
          <label className="field inline-field">
            <span>Filter</span>
            <select
              value={filter}
              onChange={(e) =>
                setFilter(e.target.value as DecisionActionType | 'all')
              }
            >
              <option value="all">All types</option>
              {DECISION_ACTION_TYPES.map((t) => (
                <option key={t} value={t}>
                  {DECISION_ACTION_LABELS[t]}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn ghost sm"
            onClick={handleExport}
            disabled={decisionLog.length === 0}
          >
            Export JSON
          </button>
          <button
            type="button"
            className="btn ghost sm danger"
            onClick={handleClear}
            disabled={decisionLog.length === 0}
          >
            Clear
          </button>
        </div>
      </div>

      <ul className="decision-log-list">
        {rows.length === 0 && (
          <li className="muted tiny">
            No decisions logged yet. Create/activate scenarios, run optimize,
            apply hub/territory/roadmap/BOM/bids/sensitivity, share, or export
            handoff to append entries.
          </li>
        )}
        {rows.map((e) => {
          const scen = scenarioName(e.scenarioId)
          return (
            <li key={e.id} className="decision-log-item">
              <div className="decision-log-meta">
                <span className="decision-log-type">
                  {DECISION_ACTION_LABELS[e.action]}
                </span>
                <span className="muted tiny">{formatDecisionWhen(e.at)}</span>
                <span className="muted tiny decision-log-actor">
                  {e.actor.name}
                </span>
              </div>
              <p>{e.summary}</p>
              {scen && (
                <p className="muted tiny decision-log-scenario">
                  Scenario · {scen}
                </p>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
