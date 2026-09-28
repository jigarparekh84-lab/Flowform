import { useMemo, useState } from 'react'
import {
  applyHubSpokeDesign,
  eligibleHubNodes,
  previewHubSpoke,
  suggestHubIds,
  type SpokeAssignMode,
} from '../data/hubSpoke'
import { useFlowform } from '../state/FlowformContext'
import { EmptyState } from './ui/EmptyState'
import { RoomHeader } from './ui/RoomHeader'

const MODES: { id: SpokeAssignMode; label: string; hint: string }[] = [
  {
    id: 'distance',
    label: 'Distance',
    hint: 'Nearest hub by haversine miles',
  },
  {
    id: 'volume',
    label: 'Volume / capacity',
    hint: 'Largest demand first; prefer hubs with headroom',
  },
  {
    id: 'balanced',
    label: 'Balanced',
    hint: 'Blend distance with capacity pressure',
  },
]

export function HubSpokeStudio() {
  const {
    network,
    activeScenario,
    applyHubSpokeNetwork,
  } = useFlowform()

  const eligible = useMemo(() => eligibleHubNodes(network.nodes), [network.nodes])
  const demands = useMemo(
    () => network.nodes.filter((n) => n.kind === 'demand'),
    [network.nodes],
  )

  const [hubIds, setHubIds] = useState<string[]>(() =>
    suggestHubIds(network.nodes, 2),
  )
  const [mode, setMode] = useState<SpokeAssignMode>('balanced')
  const [volumeWeight, setVolumeWeight] = useState(0.45)
  const [replaceDemandLanes, setReplaceDemandLanes] = useState(true)
  const [laneMode, setLaneMode] = useState('Truck')
  const [scenarioName, setScenarioName] = useState('')
  const [status, setStatus] = useState<string | null>(null)

  const preview = useMemo(() => {
    if (hubIds.length === 0) return null
    return previewHubSpoke(
      network,
      {
        hubIds,
        mode,
        volumeWeight,
        replaceDemandLanes,
        laneMode,
        scenarioName: scenarioName || undefined,
      },
      activeScenario.kpis,
    )
  }, [
    network,
    hubIds,
    mode,
    volumeWeight,
    replaceDemandLanes,
    laneMode,
    scenarioName,
    activeScenario.kpis,
  ])

  function toggleHub(id: string) {
    setHubIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    )
  }

  function suggest(n: number) {
    setHubIds(suggestHubIds(network.nodes, n))
    setStatus(`Suggested top ${n} hubs by capacity.`)
  }

  function handleApply() {
    if (hubIds.length === 0) {
      setStatus('Designate at least one hub.')
      return
    }
    const result = applyHubSpokeDesign(
      network,
      {
        hubIds,
        mode,
        volumeWeight,
        replaceDemandLanes,
        laneMode,
        scenarioName: scenarioName || undefined,
      },
      activeScenario.kpis,
    )
    applyHubSpokeNetwork(result.network, result.draftScenario)
    setStatus(
      `${result.preview.summary} Draft “${result.draftScenario.name}” is Active.`,
    )
  }

  return (
    <div className="studio-room hubspoke-studio">
      <RoomHeader
        kicker="Topology"
        title="Hub & spoke studio"
        tip="Designate hubs, auto-assign demand spokes, generate lanes, and draft a before/after scenario."
        actions={
          <>
            <button type="button" className="btn ghost" onClick={() => suggest(2)}>
              Suggest 2 hubs
            </button>
            <button type="button" className="btn ghost" onClick={() => suggest(3)}>
              Suggest 3 hubs
            </button>
          </>
        }
      />

      <div className="studio-body">
        <aside className="wizard-panel" aria-label="Hub-spoke wizard">
          <h2>Wizard</h2>

          <div className="promote-block">
            <h3>Hubs ({hubIds.length})</h3>
            <ul className="hub-check-list">
              {eligible.map((n) => (
                <li key={n.id}>
                  <label className="toggle-row">
                    <input
                      type="checkbox"
                      checked={hubIds.includes(n.id)}
                      onChange={() => toggleHub(n.id)}
                    />
                    <span>
                      {n.name}{' '}
                      <span className="muted">({n.kind} · {n.capacity})</span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            {eligible.length === 0 && (
              <EmptyState
                compact
                title="No hub candidates"
                body="Load a network with DC or plant nodes in Data, then return here."
              />
            )}
          </div>

          <label className="field">
            <span>Assign spokes by</span>
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as SpokeAssignMode)}
            >
              {MODES.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <p className="hint">
            {MODES.find((m) => m.id === mode)?.hint}
          </p>

          {mode === 'balanced' && (
            <label className="field">
              <span>Volume weight ({volumeWeight.toFixed(2)})</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={volumeWeight}
                onChange={(e) => setVolumeWeight(Number(e.target.value))}
              />
            </label>
          )}

          <label className="field">
            <span>New lane mode</span>
            <select
              value={laneMode}
              onChange={(e) => setLaneMode(e.target.value)}
            >
              {['Truck', 'Rail', 'Intermodal', 'Road'].map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>

          <label className="toggle-row">
            <input
              type="checkbox"
              checked={replaceDemandLanes}
              onChange={(e) => setReplaceDemandLanes(e.target.checked)}
            />
            <span>Replace existing demand-inbound lanes</span>
          </label>

          <label className="field">
            <span>Draft scenario name</span>
            <input
              type="text"
              placeholder={`Hub-spoke (${hubIds.length} hubs · ${mode})`}
              value={scenarioName}
              onChange={(e) => setScenarioName(e.target.value)}
            />
          </label>

          <button
            type="button"
            className="btn primary wizard-run"
            disabled={hubIds.length === 0}
            onClick={handleApply}
          >
            Apply + draft scenario
          </button>

          {status && <p className="status-line">{status}</p>}
        </aside>

        <div className="studio-main hubspoke-main">
          <div className="data-scores merge-scores hubspoke-kpis">
            <div className="score-card">
              <span className="score-label">Before (Active)</span>
              <strong className="score-value">
                {activeScenario.kpis.cost.value} ·{' '}
                {activeScenario.kpis.service.value}
              </strong>
              <span className="score-sub">
                CO₂ {activeScenario.kpis.co2.value} · Risk{' '}
                {activeScenario.kpis.risk.value}
              </span>
            </div>
            <div className="score-card">
              <span className="score-label">After (preview)</span>
              <strong className="score-value">
                {preview
                  ? `${preview.kpis.after.cost.value} · ${preview.kpis.after.service.value}`
                  : '—'}
              </strong>
              <span className="score-sub">
                {preview
                  ? `CO₂ ${preview.kpis.after.co2.value} · ${preview.kpis.after.cost.delta} cost · ${preview.kpis.after.service.delta} svc`
                  : 'Designate hubs to preview'}
              </span>
            </div>
            <div className="score-card">
              <span className="score-label">Topology</span>
              <strong className="score-value">
                {preview
                  ? `${hubIds.length} hubs · ${preview.assignments.length}/${demands.length} spokes`
                  : `${hubIds.length} hubs · ${demands.length} spokes`}
              </strong>
              <span className="score-sub">
                {preview
                  ? `${preview.newLanes.length} new lanes · ${preview.hubLoads.filter((h) => h.utilPct > 100).length} overloaded`
                  : 'Live preview as you change hubs'}
              </span>
            </div>
          </div>

          <HubMiniMap
            hubs={eligible.filter((n) => hubIds.includes(n.id))}
            assignments={preview?.assignments ?? []}
            nodes={network.nodes}
          />

          <div className="hubspoke-tables">
            <div className="candidate-table">
              <div className="table-tabs">
                <span className="table-tabs-label">Hub loads</span>
                <span className="muted">
                  {preview?.hubLoads.length ?? 0} hubs
                </span>
              </div>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Hub</th>
                      <th>Spokes</th>
                      <th>Volume</th>
                      <th>Capacity</th>
                      <th>Util %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {!preview || preview.hubLoads.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="empty-cell">
                          <EmptyState
                            compact
                            title="No hubs selected"
                            body="Check hubs or use Suggest 2 hubs to preview utilization."
                          />
                        </td>
                      </tr>
                    ) : (
                      preview.hubLoads.map((h) => (
                        <tr
                          key={h.hubId}
                          className={h.utilPct > 100 ? 'selected' : ''}
                        >
                          <td>{h.hubName}</td>
                          <td>{h.spokeCount}</td>
                          <td>{h.assignedVolume.toLocaleString()}</td>
                          <td>{h.capacity.toLocaleString()}</td>
                          <td>
                            <span
                              className={
                                h.utilPct > 100
                                  ? 'util-bad'
                                  : h.utilPct > 85
                                    ? 'util-warn'
                                    : 'util-ok'
                              }
                            >
                              {h.utilPct.toFixed(1)}%
                            </span>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="candidate-table">
              <div className="table-tabs">
                <span className="table-tabs-label">Spoke assignments</span>
                <span className="muted">
                  {preview?.assignments.length ?? 0} links
                </span>
              </div>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Spoke</th>
                      <th>Hub</th>
                      <th>Miles</th>
                      <th>Volume</th>
                    </tr>
                  </thead>
                  <tbody>
                    {!preview || preview.assignments.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="empty-cell">
                          <EmptyState
                            compact
                            title="No assignments yet"
                            body="Select at least one hub to assign demand spokes."
                          />
                        </td>
                      </tr>
                    ) : (
                      preview.assignments.map((a) => (
                        <tr key={`${a.hubId}-${a.spokeId}`}>
                          <td>{a.spokeName}</td>
                          <td>{a.hubName}</td>
                          <td>{a.miles}</td>
                          <td>{a.volume.toLocaleString()}</td>
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
    </div>
  )
}

type MiniMapProps = {
  hubs: { id: string; name: string; x: number; y: number }[]
  assignments: { spokeId: string; hubId: string }[]
  nodes: { id: string; name: string; kind: string; x: number; y: number }[]
}

function HubMiniMap({ hubs, assignments, nodes }: MiniMapProps) {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const hubSet = new Set(hubs.map((h) => h.id))

  return (
    <div className="map-stage mini-map hubspoke-map">
      <svg
        className="network-svg"
        viewBox="0 0 100 100"
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label="Hub and spoke mini-map"
      >
        <defs>
          <radialGradient id="hsGlow" cx="50%" cy="45%" r="55%">
            <stop offset="0%" stopColor="var(--ff-map-glow-0)" />
            <stop offset="100%" stopColor="var(--ff-map-glow-1)" />
          </radialGradient>
          <pattern id="hsGrid" width="5" height="5" patternUnits="userSpaceOnUse">
            <path
              d="M 5 0 L 0 0 0 5"
              fill="none"
              stroke="var(--ff-map-grid)"
              strokeWidth="0.15"
            />
          </pattern>
        </defs>
        <rect width="100" height="100" fill="url(#hsGlow)" />
        <rect width="100" height="100" fill="url(#hsGrid)" />
        <path
          d="M12 40 C18 28, 30 24, 42 26 C52 22, 62 24, 72 30 C82 28, 90 34, 92 44 C94 55, 88 66, 78 70 C68 78, 52 80, 40 74 C28 78, 18 70, 14 58 Z"
          fill="var(--ff-map-land)"
          stroke="var(--ff-map-land-stroke)"
          strokeWidth="0.3"
        />

        {assignments.map((a) => {
          const hub = byId.get(a.hubId)
          const spoke = byId.get(a.spokeId)
          if (!hub || !spoke) return null
          return (
            <line
              key={`${a.hubId}-${a.spokeId}`}
              x1={hub.x}
              y1={hub.y}
              x2={spoke.x}
              y2={spoke.y}
              stroke="rgba(56,189,248,0.55)"
              strokeWidth="0.35"
              strokeLinecap="round"
            />
          )
        })}

        {nodes.map((n) => {
          const isHub = hubSet.has(n.id)
          const isDemand = n.kind === 'demand'
          if (!isHub && !isDemand && n.kind !== 'plant' && n.kind !== 'dc') {
            return (
              <g key={n.id} transform={`translate(${n.x} ${n.y})`} opacity="0.35">
                <circle r="1.2" fill="var(--ff-node-fill)" stroke="var(--ff-text-muted)" strokeWidth="0.3" />
              </g>
            )
          }
          return (
            <g key={n.id} transform={`translate(${n.x} ${n.y})`}>
              {isHub && (
                <circle
                  r="3.2"
                  fill="none"
                  stroke="#38bdf8"
                  strokeWidth="0.35"
                  strokeDasharray="0.9 0.5"
                />
              )}
              <circle
                r={isHub ? 2.2 : 1.6}
                fill="var(--ff-node-fill)"
                stroke={isHub ? '#38bdf8' : isDemand ? 'var(--ff-warn)' : 'var(--ff-text-muted)'}
                strokeWidth={isHub ? 0.5 : 0.35}
              />
              <circle
                r="0.5"
                fill={isHub ? '#38bdf8' : isDemand ? 'var(--ff-warn)' : 'var(--ff-text-muted)'}
              />
              <title>
                {n.name}
                {isHub ? ' (hub)' : ''}
              </title>
            </g>
          )
        })}
      </svg>
      <div className="map-legend" aria-hidden>
        <span>
          <i className="dot dc" /> Hub
        </span>
        <span>
          <i className="dot demand" /> Spoke
        </span>
      </div>
    </div>
  )
}
