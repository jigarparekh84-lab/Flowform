import { useMemo, useState } from 'react'
import {
  applyTerritoryDesign,
  eligibleServingNodes,
  GAP_COLOR,
  OVERLAP_RING,
  previewTerritory,
  suggestServingIds,
  type TerritoryAssignMode,
} from '../data/serviceTerritory'
import { useFlowform } from '../state/FlowformContext'

const MODES: { id: TerritoryAssignMode; label: string; hint: string }[] = [
  {
    id: 'distance',
    label: 'Distance',
    hint: 'Nearest DC / plant by haversine miles',
  },
  {
    id: 'capacity',
    label: 'Capacity',
    hint: 'Largest demand first; prefer facilities with headroom',
  },
  {
    id: 'lanes',
    label: 'Current lanes',
    hint: 'Prefer existing inbound lanes (cheapest/fastest); distance fills gaps',
  },
]

export function TerritoryStudio() {
  const { network, activeScenario, applyTerritoryNetwork } = useFlowform()

  const eligible = useMemo(
    () => eligibleServingNodes(network.nodes),
    [network.nodes],
  )
  const demands = useMemo(
    () => network.nodes.filter((n) => n.kind === 'demand'),
    [network.nodes],
  )

  const [facilityIds, setFacilityIds] = useState<string[]>(() =>
    suggestServingIds(network.nodes),
  )
  const [mode, setMode] = useState<TerritoryAssignMode>('distance')
  const [coverageMiles, setCoverageMiles] = useState(400)
  const [coverageLeadDays, setCoverageLeadDays] = useState(3)
  const [laneMode, setLaneMode] = useState('Truck')
  const [scenarioName, setScenarioName] = useState('')
  const [status, setStatus] = useState<string | null>(null)

  const preview = useMemo(() => {
    if (facilityIds.length === 0) return null
    return previewTerritory(
      network,
      {
        facilityIds,
        mode,
        coverageMiles,
        coverageLeadDays,
        replaceDemandLanes: true,
        laneMode,
        scenarioName: scenarioName || undefined,
      },
      activeScenario.kpis,
    )
  }, [
    network,
    facilityIds,
    mode,
    coverageMiles,
    coverageLeadDays,
    laneMode,
    scenarioName,
    activeScenario.kpis,
  ])

  function toggleFacility(id: string) {
    setFacilityIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    )
  }

  function selectAll() {
    setFacilityIds(suggestServingIds(network.nodes))
    setStatus('All eligible DCs / plants selected.')
  }

  function handleApply() {
    if (facilityIds.length === 0) {
      setStatus('Select at least one serving facility.')
      return
    }
    const result = applyTerritoryDesign(
      network,
      {
        facilityIds,
        mode,
        coverageMiles,
        coverageLeadDays,
        replaceDemandLanes: true,
        laneMode,
        scenarioName: scenarioName || undefined,
      },
      activeScenario.kpis,
    )
    applyTerritoryNetwork(result.network, result.draftScenario)
    setStatus(
      `${result.preview.summary} Draft “${result.draftScenario.name}” is Active. Preferred demand lanes updated.`,
    )
  }

  return (
    <div className="studio-room territory-studio">
      <header className="studio-header">
        <div>
          <p className="map-kicker">Coverage</p>
          <h1>Service territory</h1>
          <p className="studio-sub">
            Assign demand to serving DCs / plants by distance, capacity, or
            current lanes. See coverage gaps and overlaps, then apply as a
            scenario that updates preferred demand-inbound lanes.
          </p>
        </div>
        <div className="projects-header-actions">
          <button type="button" className="btn ghost" onClick={selectAll}>
            Select all servers
          </button>
        </div>
      </header>

      <div className="studio-body">
        <aside className="wizard-panel" aria-label="Territory wizard">
          <h2>Wizard</h2>

          <div className="promote-block">
            <h3>Serving facilities ({facilityIds.length})</h3>
            <ul className="hub-check-list">
              {eligible.map((n) => (
                <li key={n.id}>
                  <label className="toggle-row">
                    <input
                      type="checkbox"
                      checked={facilityIds.includes(n.id)}
                      onChange={() => toggleFacility(n.id)}
                    />
                    <span>
                      {n.name}{' '}
                      <span className="muted">
                        ({n.kind} · {n.capacity})
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            {eligible.length === 0 && (
              <p className="hint">No DC / plant nodes to serve demand.</p>
            )}
          </div>

          <label className="field">
            <span>Assign by</span>
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as TerritoryAssignMode)}
            >
              {MODES.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <p className="hint">{MODES.find((m) => m.id === mode)?.hint}</p>

          <label className="field">
            <span>Coverage radius ({coverageMiles} mi)</span>
            <input
              type="range"
              min={100}
              max={1200}
              step={25}
              value={coverageMiles}
              onChange={(e) => setCoverageMiles(Number(e.target.value))}
            />
          </label>

          <label className="field">
            <span>Lead-time target ({coverageLeadDays} d)</span>
            <input
              type="range"
              min={1}
              max={14}
              step={1}
              value={coverageLeadDays}
              onChange={(e) => setCoverageLeadDays(Number(e.target.value))}
            />
          </label>

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

          <label className="field">
            <span>Draft scenario name</span>
            <input
              type="text"
              placeholder={`Territory (${mode} · ${coverageMiles} mi)`}
              value={scenarioName}
              onChange={(e) => setScenarioName(e.target.value)}
            />
          </label>

          <button
            type="button"
            className="btn primary wizard-run"
            disabled={facilityIds.length === 0}
            onClick={handleApply}
          >
            Apply as scenario + update preferred lanes
          </button>

          {status && <p className="status-line">{status}</p>}
        </aside>

        <div className="studio-main hubspoke-main">
          <div className="data-scores merge-scores hubspoke-kpis territory-kpis">
            <div className="score-card">
              <span className="score-label">Within {coverageMiles} mi</span>
              <strong className="score-value">
                {preview ? `${preview.metrics.pctCoveredWithinMiles}%` : '—'}
              </strong>
              <span className="score-sub">
                {preview
                  ? `${preview.metrics.assignedCount}/${demands.length} assigned · ${preview.metrics.gapCount} gaps`
                  : 'Select servers to preview'}
              </span>
            </div>
            <div className="score-card">
              <span className="score-label">Within {coverageLeadDays}d lead</span>
              <strong className="score-value">
                {preview ? `${preview.metrics.pctCoveredWithinLead}%` : '—'}
              </strong>
              <span className="score-sub">
                {preview
                  ? `Unassigned vol ${preview.metrics.unassignedVolume.toLocaleString()} · ${preview.metrics.overlapCount} overlaps`
                  : 'Lead-time coverage'}
              </span>
            </div>
            <div className="score-card">
              <span className="score-label">After KPIs (preview)</span>
              <strong className="score-value">
                {preview
                  ? `${preview.kpis.after.cost.value} · ${preview.kpis.after.service.value}`
                  : '—'}
              </strong>
              <span className="score-sub">
                {preview
                  ? `CO₂ ${preview.kpis.after.co2.value} · ${preview.kpis.after.service.delta} svc`
                  : 'Draft on apply'}
              </span>
            </div>
          </div>

          <TerritoryMiniMap
            facilities={eligible.filter((n) => facilityIds.includes(n.id))}
            assignments={preview?.assignments ?? []}
            colorByFacility={preview?.colorByFacility ?? {}}
            nodes={network.nodes}
            coverageMiles={coverageMiles}
          />

          <div className="hubspoke-tables">
            <div className="candidate-table">
              <div className="table-tabs">
                <span className="table-tabs-label">Territory load vs capacity</span>
                <span className="muted">{preview?.loads.length ?? 0} servers</span>
              </div>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th></th>
                      <th>Facility</th>
                      <th>Demand</th>
                      <th>Volume</th>
                      <th>Capacity</th>
                      <th>Util %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {!preview || preview.loads.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="empty-cell">
                          Select serving facilities.
                        </td>
                      </tr>
                    ) : (
                      preview.loads.map((h) => (
                        <tr
                          key={h.facilityId}
                          className={h.utilPct > 100 ? 'selected' : ''}
                        >
                          <td>
                            <i
                              className="terr-swatch"
                              style={{ background: h.color }}
                              aria-hidden
                            />
                          </td>
                          <td>{h.facilityName}</td>
                          <td>{h.demandCount}</td>
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
                <span className="table-tabs-label">Assignments</span>
                <span className="muted">
                  {preview?.assignments.length ?? 0} demand
                </span>
              </div>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Demand</th>
                      <th>Server</th>
                      <th>Miles</th>
                      <th>Lead</th>
                      <th>Volume</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {!preview || preview.assignments.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="empty-cell">
                          No assignments yet.
                        </td>
                      </tr>
                    ) : (
                      preview.assignments.map((a) => (
                        <tr
                          key={a.demandId}
                          className={
                            a.status === 'gap'
                              ? 'terr-row-gap'
                              : a.status === 'overlap'
                                ? 'terr-row-overlap'
                                : ''
                          }
                        >
                          <td>{a.demandName}</td>
                          <td>{a.facilityName ?? '—'}</td>
                          <td>{a.miles ?? '—'}</td>
                          <td>{a.leadDays != null ? `${a.leadDays}d` : '—'}</td>
                          <td>{a.volume.toLocaleString()}</td>
                          <td>
                            <span
                              className={
                                a.status === 'gap'
                                  ? 'util-bad'
                                  : a.status === 'overlap'
                                    ? 'util-warn'
                                    : a.withinMiles
                                      ? 'util-ok'
                                      : 'util-warn'
                              }
                            >
                              {a.status === 'gap'
                                ? 'Gap'
                                : a.status === 'overlap'
                                  ? 'Overlap'
                                  : a.withinMiles
                                    ? 'Covered'
                                    : 'Far'}
                            </span>
                          </td>
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
  facilities: { id: string; name: string; x: number; y: number }[]
  assignments: {
    demandId: string
    facilityId: string | null
    status: string
  }[]
  colorByFacility: Record<string, string>
  nodes: { id: string; name: string; kind: string; x: number; y: number }[]
  coverageMiles: number
}

function TerritoryMiniMap({
  facilities,
  assignments,
  colorByFacility,
  nodes,
}: MiniMapProps) {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const facSet = new Set(facilities.map((h) => h.id))
  const assignByDemand = new Map(assignments.map((a) => [a.demandId, a]))

  return (
    <div className="map-stage mini-map hubspoke-map territory-map">
      <svg
        className="network-svg"
        viewBox="0 0 100 100"
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label="Service territory mini-map"
      >
        <defs>
          <radialGradient id="terrGlow" cx="50%" cy="45%" r="55%">
            <stop offset="0%" stopColor="var(--ff-map-glow-0)" />
            <stop offset="100%" stopColor="var(--ff-map-glow-1)" />
          </radialGradient>
          <pattern
            id="terrGrid"
            width="5"
            height="5"
            patternUnits="userSpaceOnUse"
          >
            <path
              d="M 5 0 L 0 0 0 5"
              fill="none"
              stroke="var(--ff-map-grid)"
              strokeWidth="0.15"
            />
          </pattern>
        </defs>
        <rect width="100" height="100" fill="url(#terrGlow)" />
        <rect width="100" height="100" fill="url(#terrGrid)" />
        <path
          d="M12 40 C18 28, 30 24, 42 26 C52 22, 62 24, 72 30 C82 28, 90 34, 92 44 C94 55, 88 66, 78 70 C68 78, 52 80, 40 74 C28 78, 18 70, 14 58 Z"
          fill="var(--ff-map-land)"
          stroke="var(--ff-map-land-stroke)"
          strokeWidth="0.3"
        />

        {assignments.map((a) => {
          if (!a.facilityId) return null
          const hub = byId.get(a.facilityId)
          const spoke = byId.get(a.demandId)
          if (!hub || !spoke) return null
          const color = colorByFacility[a.facilityId] ?? '#38bdf8'
          return (
            <line
              key={`${a.facilityId}-${a.demandId}`}
              x1={hub.x}
              y1={hub.y}
              x2={spoke.x}
              y2={spoke.y}
              stroke={color}
              strokeWidth="0.4"
              strokeOpacity="0.55"
              strokeLinecap="round"
            />
          )
        })}

        {nodes.map((n) => {
          const isFac = facSet.has(n.id)
          const isDemand = n.kind === 'demand'
          const a = assignByDemand.get(n.id)
          const color = isFac
            ? colorByFacility[n.id] ?? '#38bdf8'
            : a?.facilityId
              ? colorByFacility[a.facilityId] ?? GAP_COLOR
              : isDemand
                ? GAP_COLOR
                : 'var(--ff-text-muted)'

          if (!isFac && !isDemand && n.kind !== 'plant' && n.kind !== 'dc') {
            return (
              <g
                key={n.id}
                transform={`translate(${n.x} ${n.y})`}
                opacity="0.3"
              >
                <circle
                  r="1.2"
                  fill="var(--ff-node-fill)"
                  stroke="var(--ff-text-muted)"
                  strokeWidth="0.3"
                />
              </g>
            )
          }

          return (
            <g key={n.id} transform={`translate(${n.x} ${n.y})`}>
              {a?.status === 'overlap' && (
                <circle
                  r="3.0"
                  fill="none"
                  stroke={OVERLAP_RING}
                  strokeWidth="0.35"
                  strokeDasharray="0.7 0.45"
                />
              )}
              {isFac && (
                <circle
                  r="3.2"
                  fill="none"
                  stroke={color}
                  strokeWidth="0.35"
                  strokeDasharray="0.9 0.5"
                />
              )}
              <circle
                r={isFac ? 2.2 : 1.6}
                fill="var(--ff-node-fill)"
                stroke={color}
                strokeWidth={isFac ? 0.5 : 0.35}
              />
              <circle r="0.5" fill={color} />
              <title>
                {n.name}
                {isFac ? ' (server)' : a?.facilityId ? '' : isDemand ? ' (gap)' : ''}
              </title>
            </g>
          )
        })}
      </svg>
      <div className="map-legend" aria-hidden>
        <span>
          <i className="dot dc" /> Server
        </span>
        <span>
          <i className="dot demand" /> Demand (by territory)
        </span>
        <span>
          <i className="dot util-high" /> Gap / overlap ring
        </span>
      </div>
    </div>
  )
}
