import { PROJECT_NAME, HORIZON_OPTIONS, type Scenario } from '../data/sampleNetwork'

type Props = {
  activeScenario: Scenario
  horizon: (typeof HORIZON_OPTIONS)[number]
  onHorizon: (h: (typeof HORIZON_OPTIONS)[number]) => void
}

export function TopChrome({ activeScenario, horizon, onHorizon }: Props) {
  return (
    <header className="top-chrome">
      <div className="chrome-left">
        <div className="logo" aria-label="Flowform">
          <svg width="28" height="28" viewBox="0 0 28 28" fill="none" aria-hidden>
            <rect width="28" height="28" rx="7" fill="url(#ffg)" />
            <path
              d="M7 18.5C7 14 10.5 11 14 11c2.2 0 3.5 1.2 4.2 2.4.4-.8 1.4-2.1 3.3-2.1v2.2c-1.1 0-1.6.6-1.9 1.3C18.8 17.2 17 19.5 14 19.5c-2.2 0-4.2-1.5-4.2-3.8 0-1.5.9-2.6 2.2-2.6 1 0 1.7.6 2.1 1.3.5-.9 1.5-1.6 2.8-1.6 2.1 0 3.4 1.7 3.4 3.9 0 3.4-2.8 5.8-6.3 5.8-4.2 0-7-2.9-7-6.5z"
              fill="#0b1220"
              opacity="0.9"
            />
            <defs>
              <linearGradient id="ffg" x1="0" y1="0" x2="28" y2="28">
                <stop stopColor="#38bdf8" />
                <stop offset="1" stopColor="#34d399" />
              </linearGradient>
            </defs>
          </svg>
          <strong>Flowform</strong>
        </div>
        <span className="chrome-divider" aria-hidden />
        <button type="button" className="project-stub" title="Project (stub)">
          <span className="project-label">Project</span>
          <span className="project-name">{PROJECT_NAME}</span>
          <span className="chev" aria-hidden>
            ▾
          </span>
        </button>
      </div>

      <div className="chrome-center">
        <span className="active-chip">
          <span className="chip-dot" aria-hidden />
          Active · {activeScenario.name}
        </span>
        <label className="horizon">
          <span>Horizon</span>
          <select
            value={horizon}
            onChange={(e) => onHorizon(e.target.value as (typeof HORIZON_OPTIONS)[number])}
          >
            {HORIZON_OPTIONS.map((h) => (
              <option key={h} value={h}>
                {h}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="chrome-right">
        <button type="button" className="btn ghost">
          Run
        </button>
        <button type="button" className="btn primary">
          Compare
        </button>
        <button type="button" className="cmdk" title="Command palette (stub)">
          <span>Search</span>
          <kbd>⌘K</kbd>
        </button>
      </div>
    </header>
  )
}
