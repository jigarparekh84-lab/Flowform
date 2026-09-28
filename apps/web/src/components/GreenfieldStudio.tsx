import { useMemo, useState } from 'react'
import {
  DEMAND_SETS,
  NODES,
  type CandidateSite,
  type GreenfieldParams,
} from '../data/sampleNetwork'
import { useFlowform } from '../state/FlowformContext'

const DEFAULT_PARAMS: GreenfieldParams = {
  demandSetId: DEMAND_SETS[0].id,
  siteCount: 3,
  serviceMiles: 250,
  euclidean: true,
  lockExisting: true,
}

export function GreenfieldStudio() {
  const { runGreenfield, lastCandidates, promoteCandidates } = useFlowform()
  const [params, setParams] = useState<GreenfieldParams>(DEFAULT_PARAMS)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [promoteName, setPromoteName] = useState('')
  const [status, setStatus] = useState<string | null>(null)

  const demand = useMemo(
    () => NODES.filter((n) => n.kind === 'demand'),
    [],
  )
  const existing = useMemo(
    () => NODES.filter((n) => n.kind === 'dc' || n.kind === 'plant'),
    [],
  )

  function handleRun() {
    const sites = runGreenfield(params)
    setSelectedIds(sites.map((s) => s.id))
    setStatus(`Generated ${sites.length} candidate sites (mock heuristic).`)
  }

  function toggleCandidate(id: string, additive: boolean) {
    setSelectedIds((prev) => {
      if (additive) {
        return prev.includes(id)
          ? prev.filter((x) => x !== id)
          : [...prev, id]
      }
      return prev.includes(id) && prev.length === 1 ? [] : [id]
    })
  }

  function handlePromote() {
    const item = promoteCandidates(
      selectedIds,
      promoteName || undefined,
    )
    if (!item) {
      setStatus('Select at least one candidate to promote.')
      return
    }
    setStatus(
      `Promoted “${item.name}” → delta library (${item.candidates.length} sites). Open Scenarios to compose.`,
    )
    setPromoteName('')
  }

  return (
    <div className="studio-room greenfield-studio">
      <header className="studio-header">
        <div>
          <p className="map-kicker">Greenfield</p>
          <h1>Studio</h1>
          <p className="studio-sub">
            Place mock candidate DCs near demand clusters. Promote a selection
            into the delta library for scenario compose.
          </p>
        </div>
      </header>

      <div className="studio-body">
        <aside className="wizard-panel" aria-label="Greenfield wizard">
          <h2>Wizard</h2>

          <label className="field">
            <span>Demand set</span>
            <select
              value={params.demandSetId}
              onChange={(e) =>
                setParams((p) => ({ ...p, demandSetId: e.target.value }))
              }
            >
              {DEMAND_SETS.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span># of sites ({params.siteCount})</span>
            <input
              type="range"
              min={2}
              max={6}
              value={params.siteCount}
              onChange={(e) =>
                setParams((p) => ({
                  ...p,
                  siteCount: Number(e.target.value),
                }))
              }
            />
          </label>

          <label className="field">
            <span>Service distance (miles)</span>
            <input
              type="number"
              min={50}
              max={800}
              step={25}
              value={params.serviceMiles}
              onChange={(e) =>
                setParams((p) => ({
                  ...p,
                  serviceMiles: Number(e.target.value) || 50,
                }))
              }
            />
          </label>

          <label className="toggle-row">
            <input
              type="checkbox"
              checked={params.euclidean}
              onChange={(e) =>
                setParams((p) => ({ ...p, euclidean: e.target.checked }))
              }
            />
            <span>Euclidean distance</span>
          </label>

          <label className="toggle-row">
            <input
              type="checkbox"
              checked={params.lockExisting}
              onChange={(e) =>
                setParams((p) => ({ ...p, lockExisting: e.target.checked }))
              }
            />
            <span>Lock existing sites</span>
          </label>

          <button type="button" className="btn primary wizard-run" onClick={handleRun}>
            Run
          </button>

          <div className="promote-block">
            <h3>Promote selection</h3>
            <label className="field">
              <span>Delta name</span>
              <input
                type="text"
                placeholder={`Greenfield +${selectedIds.length || params.siteCount} sites`}
                value={promoteName}
                onChange={(e) => setPromoteName(e.target.value)}
              />
            </label>
            <button
              type="button"
              className="btn ghost"
              disabled={selectedIds.length === 0}
              onClick={handlePromote}
            >
              Promote → Candidates delta
            </button>
          </div>

          {status && <p className="status-line">{status}</p>}
        </aside>

        <div className="studio-main">
          <MiniMap
            demand={demand}
            existing={params.lockExisting ? existing : []}
            candidates={lastCandidates}
            selectedIds={selectedIds}
            serviceMiles={params.serviceMiles}
            showRadii={params.euclidean}
            onSelect={toggleCandidate}
          />

          <div className="candidate-table">
            <div className="table-tabs">
              <span className="table-tabs-label">Candidates</span>
              <span className="muted">
                {lastCandidates.length === 0
                  ? 'Run the wizard to generate pins'
                  : `${selectedIds.length} / ${lastCandidates.length} selected`}
              </span>
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th />
                    <th>Name</th>
                    <th>Region</th>
                    <th>Score</th>
                    <th>Reach</th>
                  </tr>
                </thead>
                <tbody>
                  {lastCandidates.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="empty-cell">
                        No candidates yet.
                      </td>
                    </tr>
                  ) : (
                    lastCandidates.map((c) => (
                      <tr
                        key={c.id}
                        className={
                          selectedIds.includes(c.id) ? 'selected' : ''
                        }
                        onClick={(e) => toggleCandidate(c.id, e.shiftKey)}
                      >
                        <td>
                          <input
                            type="checkbox"
                            checked={selectedIds.includes(c.id)}
                            onChange={() => toggleCandidate(c.id, true)}
                            onClick={(e) => e.stopPropagation()}
                          />
                        </td>
                        <td>{c.name}</td>
                        <td>{c.region}</td>
                        <td>{c.score}</td>
                        <td>{c.serviceMiles} mi</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

type MiniMapProps = {
  demand: { id: string; name: string; x: number; y: number }[]
  existing: { id: string; name: string; x: number; y: number; kind: string }[]
  candidates: CandidateSite[]
  selectedIds: string[]
  serviceMiles: number
  showRadii: boolean
  onSelect: (id: string, additive: boolean) => void
}

function MiniMap({
  demand,
  existing,
  candidates,
  selectedIds,
  serviceMiles,
  showRadii,
  onSelect,
}: MiniMapProps) {
  const selectedSet = new Set(selectedIds)
  // Rough: 1 map unit ≈ 12 miles for radius viz
  const radiusUnits = Math.min(18, serviceMiles / 12)

  return (
    <div className="map-stage mini-map">
      <svg
        className="network-svg"
        viewBox="0 0 100 100"
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label="Greenfield mini-map"
      >
        <defs>
          <radialGradient id="gfGlow" cx="50%" cy="45%" r="55%">
            <stop offset="0%" stopColor="#12203a" />
            <stop offset="100%" stopColor="#060b14" />
          </radialGradient>
          <pattern id="gfGrid" width="5" height="5" patternUnits="userSpaceOnUse">
            <path
              d="M 5 0 L 0 0 0 5"
              fill="none"
              stroke="rgba(56,189,248,0.07)"
              strokeWidth="0.15"
            />
          </pattern>
        </defs>
        <rect width="100" height="100" fill="url(#gfGlow)" />
        <rect width="100" height="100" fill="url(#gfGrid)" />
        <path
          d="M12 40 C18 28, 30 24, 42 26 C52 22, 62 24, 72 30 C82 28, 90 34, 92 44 C94 55, 88 66, 78 70 C68 78, 52 80, 40 74 C28 78, 18 70, 14 58 Z"
          fill="rgba(30,58,95,0.35)"
          stroke="rgba(56,189,248,0.12)"
          strokeWidth="0.3"
        />

        {showRadii &&
          candidates.map((c) => (
            <circle
              key={`r-${c.id}`}
              cx={c.x}
              cy={c.y}
              r={radiusUnits}
              fill="rgba(251,113,133,0.06)"
              stroke="rgba(251,113,133,0.25)"
              strokeWidth="0.25"
              strokeDasharray="1 0.8"
            />
          ))}

        {existing.map((n) => (
          <g key={n.id} transform={`translate(${n.x} ${n.y})`} opacity="0.55">
            <circle r="1.5" fill="#0b1220" stroke="#64748b" strokeWidth="0.35" />
            <title>{n.name} (locked)</title>
          </g>
        ))}

        {demand.map((n) => (
          <g key={n.id} transform={`translate(${n.x} ${n.y})`}>
            <circle r="1.7" fill="#0b1220" stroke="#fbbf24" strokeWidth="0.4" />
            <circle r="0.55" fill="#fbbf24" />
            <title>{n.name}</title>
          </g>
        ))}

        {candidates.map((c) => {
          const selected = selectedSet.has(c.id)
          return (
            <g
              key={c.id}
              className={`map-node${selected ? ' is-selected' : ''}`}
              transform={`translate(${c.x} ${c.y})`}
              onClick={(e) => {
                e.stopPropagation()
                onSelect(c.id, e.shiftKey)
              }}
              style={{ cursor: 'pointer' }}
            >
              {selected && (
                <circle
                  r="3.4"
                  fill="none"
                  stroke="#fda4af"
                  strokeWidth="0.4"
                />
              )}
              <rect
                x="-1.6"
                y="-1.6"
                width="3.2"
                height="3.2"
                rx="0.4"
                fill="#0b1220"
                stroke="#fb7185"
                strokeWidth={selected ? 0.55 : 0.4}
                transform="rotate(45)"
              />
              <circle r="0.55" fill="#fb7185" />
              <text
                y="4.2"
                textAnchor="middle"
                className="node-label"
                fill="#fda4af"
                fontSize="2"
              >
                {c.name.replace('Candidate DC ', '')}
              </text>
              <title>
                {c.name} · score {c.score}
              </title>
            </g>
          )
        })}
      </svg>
      <div className="map-legend" aria-hidden>
        <span>
          <i className="dot demand" /> Demand
        </span>
        <span>
          <i className="dot candidate" /> Candidate
        </span>
        <span>
          <i className="dot locked" /> Locked
        </span>
      </div>
    </div>
  )
}
