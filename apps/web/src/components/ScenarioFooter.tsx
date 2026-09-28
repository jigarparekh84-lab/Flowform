import type { Scenario } from '../data/sampleNetwork'

type Props = {
  scenarios: Scenario[]
  activeId: string
  onSelect: (id: string) => void
}

export function ScenarioFooter({ scenarios, activeId, onSelect }: Props) {
  return (
    <footer className="scenario-footer" aria-label="Scenarios">
      <span className="footer-label">Scenarios</span>
      <div className="scenario-chips">
        {scenarios.map((s) => (
          <button
            key={s.id}
            type="button"
            className={s.id === activeId ? 'scenario-chip active' : 'scenario-chip'}
            onClick={() => onSelect(s.id)}
          >
            <span className="chip-name">{s.name}</span>
            <span className="chip-tag">{s.tag}</span>
          </button>
        ))}
        <button type="button" className="scenario-chip add" disabled title="Stub">
          + New
        </button>
      </div>
    </footer>
  )
}
