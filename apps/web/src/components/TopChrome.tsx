import { HORIZON_OPTIONS, type Scenario } from '../data/sampleNetwork'
import { useFlowform } from '../state/FlowformContext'
import type { ThemeMode } from '../state/theme'

type Props = {
  activeScenario: Scenario
  horizon: (typeof HORIZON_OPTIONS)[number]
  onHorizon: (h: (typeof HORIZON_OPTIONS)[number]) => void
  onCompare?: () => void
  onOpenProjects?: () => void
  theme: ThemeMode
  onToggleTheme: () => void
}

export function TopChrome({
  activeScenario,
  horizon,
  onHorizon,
  onCompare,
  onOpenProjects,
  theme,
  onToggleTheme,
}: Props) {
  const { optimizeStatus, runOptimize, projectName } = useFlowform()
  const running = optimizeStatus.phase === 'running'

  return (
    <header className="top-chrome">
      <div className="chrome-left">
        <div className="logo" aria-label="Flowform">
          <svg width="28" height="28" viewBox="0 0 28 28" fill="none" aria-hidden>
            <rect width="28" height="28" rx="7" fill="url(#ffg)" />
            <path
              d="M7 18.5C7 14 10.5 11 14 11c2.2 0 3.5 1.2 4.2 2.4.4-.8 1.4-2.1 3.3-2.1v2.2c-1.1 0-1.6.6-1.9 1.3C18.8 17.2 17 19.5 14 19.5c-2.2 0-4.2-1.5-4.2-3.8 0-1.5.9-2.6 2.2-2.6 1 0 1.7.6 2.1 1.3.5-.9 1.5-1.6 2.8-1.6 2.1 0 3.4 1.7 3.4 3.9 0 3.4-2.8 5.8-6.3 5.8-4.2 0-7-2.9-7-6.5z"
              fill="var(--ff-bg-chrome)"
              opacity="0.95"
            />
            <defs>
              <linearGradient id="ffg" x1="0" y1="0" x2="28" y2="28">
                <stop stopColor="var(--ff-accent)" />
                <stop offset="1" stopColor="var(--ff-good)" />
              </linearGradient>
            </defs>
          </svg>
          <strong>Flowform</strong>
        </div>
        <span className="chrome-divider" aria-hidden />
        <button
          type="button"
          className="project-stub"
          title="Open Projects room"
          onClick={onOpenProjects}
        >
          <span className="project-label">Project</span>
          <span className="project-name">{projectName}</span>
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
        {optimizeStatus.phase !== 'idle' && (
          <div
            className={`run-status run-${optimizeStatus.phase}`}
            title={
              optimizeStatus.phase === 'done'
                ? optimizeStatus.log.join('\n')
                : optimizeStatus.message
            }
          >
            {optimizeStatus.phase === 'running' && (
              <span className="run-bar" style={{ width: `${optimizeStatus.progress}%` }} />
            )}
            <span className="run-msg">
              {optimizeStatus.phase === 'running' &&
                `Run ${optimizeStatus.progress}% · ${optimizeStatus.message}`}
              {optimizeStatus.phase === 'done' && optimizeStatus.message}
              {optimizeStatus.phase === 'error' && optimizeStatus.message}
            </span>
          </div>
        )}
      </div>

      <div className="chrome-right">
        <button
          type="button"
          className="theme-toggle"
          onClick={onToggleTheme}
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          <span className="theme-icon" aria-hidden>
            {theme === 'dark' ? '☀' : '☾'}
          </span>
          <span>{theme === 'dark' ? 'Light' : 'Dark'}</span>
        </button>
        <button
          type="button"
          className="btn ghost"
          disabled={running}
          onClick={() => void runOptimize()}
          title="Calls optimize API (PuLP MIP) when available; else client heuristic v1"
        >
          {running ? 'Running…' : 'Run'}
        </button>
        <button type="button" className="btn primary" onClick={onCompare}>
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
