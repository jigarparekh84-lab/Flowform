import { useState } from 'react'
import './App.css'

const NAV = [
  'Projects',
  'Network',
  'Greenfield',
  'Scenarios',
  'Compare',
  'Brief',
  'Data',
  'Handoff',
] as const

type NavItem = (typeof NAV)[number]

function App() {
  const [active, setActive] = useState<NavItem>('Network')

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden />
          <div>
            <strong>Flowform</strong>
            <span className="brand-sub">network / footprint design studio</span>
          </div>
        </div>
        <nav className="ia" aria-label="Primary">
          {NAV.map((item) => (
            <button
              key={item}
              type="button"
              className={active === item ? 'ia-item active' : 'ia-item'}
              onClick={() => setActive(item)}
            >
              {item}
            </button>
          ))}
        </nav>
      </header>

      <div className="workspace">
        <aside className="rail" aria-label="Scenarios">
          <h2>Scenarios</h2>
          <ul>
            <li className="scenario active">Baseline</li>
            <li className="scenario muted">+ New scenario (stub)</li>
          </ul>
          <p className="hint">Branch what-ifs without leaving the map.</p>
        </aside>

        <main className="canvas" aria-label="Network Canvas">
          <div className="canvas-chrome">
            <h1>Flowform</h1>
            <p className="canvas-title">Network Canvas · {active}</p>
          </div>

          <div className="map-stage">
            <div className="map-grid" aria-hidden />
            <div className="map-placeholder">
              <p className="map-kicker">Map-primary stage</p>
              <p>
                Placeholder canvas for nodes, sites, and lanes.
                <br />
                Greenfield, scenarios, and compare attach here — not a separate planner nav.
              </p>
              <div className="node-demo" aria-hidden>
                <span className="node plant">Plant</span>
                <span className="lane" />
                <span className="node dc">DC</span>
                <span className="lane" />
                <span className="node demand">Demand</span>
              </div>
            </div>
          </div>
        </main>

        <aside className="inspector" aria-label="Inspector">
          <h2>Inspector</h2>
          <p className="hint">Select a node or lane on the canvas.</p>
          <dl className="stub-fields">
            <div>
              <dt>Area</dt>
              <dd>{active}</dd>
            </div>
            <div>
              <dt>Selection</dt>
              <dd>None</dd>
            </div>
            <div>
              <dt>Handoff</dt>
              <dd>Ritara (stub)</dd>
            </div>
          </dl>
        </aside>
      </div>
    </div>
  )
}

export default App
