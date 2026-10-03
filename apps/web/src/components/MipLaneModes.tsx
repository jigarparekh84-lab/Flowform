import {
  formatPi,
  laneCapLabel,
  modeColor,
} from '../data/laneMip'
import type { Scenario } from '../data/sampleNetwork'

/**
 * Depth 7 — optimized flows by transport mode + lane utilization + binding
 * lane capacity chips (with LP shadow prices) from the fixed-charge MIP.
 */
export function MipLaneModePanel({
  scenarios,
  title = 'Optimized flows by mode · lane capacity',
}: {
  scenarios: Scenario[]
  title?: string
}) {
  const rows = scenarios.filter(
    (s) =>
      (s.optimizeMeta?.objectiveBreakdown?.modeMix?.length ?? 0) > 0 ||
      (s.optimizeMeta?.laneCapacity?.length ?? 0) > 0,
  )
  if (rows.length === 0) return null
  return (
    <section
      className="library-card mip-lanes-card"
      aria-label="MIP mode mix and lane capacity"
      style={{ marginBottom: '1rem' }}
    >
      <h2>{title}</h2>
      <p className="muted tiny">
        From the fixed-charge MIP: transport mode chosen per lane (rate, transit
        vs max lead time, CO₂, capacity, fixed charge), lane utilization, and
        binding lane capacities with LP shadow prices (π, model $M per unit).
      </p>
      {rows.map((s) => (
        <ScenarioLaneBlock key={s.id} s={s} />
      ))}
    </section>
  )
}

function ScenarioLaneBlock({ s }: { s: Scenario }) {
  const meta = s.optimizeMeta!
  const bd = meta.objectiveBreakdown
  const mix = bd?.modeMix ?? []
  const binding =
    meta.bindingLaneCapacities ??
    (meta.laneCapacity ?? []).filter((r) => r.binding)
  const util = (meta.laneUtilization ?? []).slice(0, 8)
  const mc = meta.modeChoice
  const totalCo2T = mix.reduce((n, m) => n + m.co2Kg, 0) / 1000

  return (
    <div className="mip-lanes-block">
      <div className="mip-lanes-head">
        <strong>{s.name}</strong>
        <span className="muted tiny">
          {mc?.enabled
            ? `${mc.lanesWithModes ?? 0} multi-mode lane(s) · ${mc.modeOptions ?? 0} options · ${mc.laneModeBinaries ?? 0} fixed-charge`
            : 'single-mode lanes'}
          {mc?.serviceFilteredModes
            ? ` · ${mc.serviceFilteredModes} slow option(s) cut by max lead`
            : ''}
          {bd?.laneFixedM ? ` · lane fixed $${bd.laneFixedM.toFixed(2)}M` : ''}
          {bd?.carbonM ? ` · carbon $${bd.carbonM.toFixed(2)}M` : ''}
          {mix.length ? ` · transport CO₂ ${totalCo2T.toLocaleString(undefined, { maximumFractionDigits: 0 })} t` : ''}
        </span>
      </div>

      {mix.length > 0 && (
        <>
          <div
            className="mip-mode-stack"
            role="img"
            aria-label={`Mode mix: ${mix.map((m) => `${m.mode} ${m.sharePct}%`).join(', ')}`}
          >
            {mix.map((m) => (
              <span
                key={m.mode}
                className="mip-mode-seg"
                style={{
                  width: `${Math.max(1, m.sharePct)}%`,
                  background: modeColor(m.mode),
                }}
                title={`${m.mode} ${m.sharePct}%`}
              >
                {m.sharePct >= 9 ? `${m.mode} ${Math.round(m.sharePct)}%` : ''}
              </span>
            ))}
          </div>
          <div className="table-scroll">
            <table className="compare-matrix modes-table">
              <thead>
                <tr>
                  <th scope="col">Mode</th>
                  <th scope="col">Volume</th>
                  <th scope="col">Share</th>
                  <th scope="col">Transport</th>
                  <th scope="col">Lane fixed</th>
                  <th scope="col">CO₂ (t)</th>
                  <th scope="col">Avg transit</th>
                  <th scope="col">Lanes</th>
                </tr>
              </thead>
              <tbody>
                {mix.map((m) => (
                  <tr key={m.mode}>
                    <td>
                      <span
                        className="lane-cap-dot"
                        style={{ background: modeColor(m.mode) }}
                      />{' '}
                      <strong>{m.mode}</strong>
                    </td>
                    <td>{Math.round(m.volume).toLocaleString()}</td>
                    <td>{m.sharePct.toFixed(1)}%</td>
                    <td>${m.transportM.toFixed(3)}M</td>
                    <td>{m.laneFixedM ? `$${m.laneFixedM.toFixed(2)}M` : '—'}</td>
                    <td>{(m.co2Kg / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })}</td>
                    <td>{m.avgLeadDays != null ? `${m.avgLeadDays.toFixed(1)} d` : '—'}</td>
                    <td>{m.laneCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <div className="lane-cap-chips" aria-label="Binding lane capacities">
        <span className="toolbar-label">Binding lane caps</span>
        {binding.length === 0 ? (
          <span className="muted tiny">none — no lane at capacity</span>
        ) : (
          binding.slice(0, 12).map((r) => (
            <span
              key={`${r.laneId ?? `${r.from}-${r.to}`}-${r.scope}-${r.mode ?? ''}`}
              className="lane-cap-chip"
              title={`${r.from} → ${r.to} · ${r.scope} · ${Math.round(r.volume).toLocaleString()} / ${Math.round(r.capacity).toLocaleString()} u · slack ${r.slack}`}
            >
              <span
                className="lane-cap-dot"
                style={{
                  background: r.mode ? modeColor(r.mode) : 'var(--ff-bad, #f87171)',
                }}
              />
              {laneCapLabel(r)} · {r.utilizationPct.toFixed(0)}%
              {r.shadowPrice != null ? ` · π=${formatPi(r.shadowPrice)}` : ''}
            </span>
          ))
        )}
        {binding.length > 12 && (
          <span className="muted tiny">+{binding.length - 12} more</span>
        )}
      </div>

      {util.length > 0 && (
        <div className="table-scroll">
          <table className="compare-matrix modes-table lane-util-table">
            <thead>
              <tr>
                <th scope="col">Lane</th>
                <th scope="col">Route</th>
                <th scope="col">Volume</th>
                <th scope="col">Capacity</th>
                <th scope="col">Utilization</th>
                <th scope="col">Mode split</th>
              </tr>
            </thead>
            <tbody>
              {util.map((r) => (
                <tr key={r.laneId ?? `${r.from}-${r.to}`}>
                  <td>
                    <strong>{r.laneId ?? '—'}</strong>
                    {r.binding ? <span className="lane-binding-tag">binding</span> : null}
                  </td>
                  <td className="muted tiny">
                    {r.from} → {r.to}
                  </td>
                  <td>{Math.round(r.volume).toLocaleString()}</td>
                  <td>{r.capacity != null ? Math.round(r.capacity).toLocaleString() : '∞'}</td>
                  <td>
                    <div className="lane-util-track">
                      <div
                        className={`lane-util-fill${r.binding ? ' is-binding' : (r.utilizationPct ?? 0) >= 80 ? ' is-hot' : ''}`}
                        style={{ width: `${Math.min(100, r.utilizationPct ?? 0)}%` }}
                      />
                    </div>
                    <span className="tiny">
                      {r.utilizationPct != null ? `${r.utilizationPct.toFixed(0)}%` : '—'}
                    </span>
                  </td>
                  <td className="tiny">
                    {r.modes
                      .filter((m) => m.volume > 0)
                      .map((m) => (
                        <span key={m.mode} className="lane-mode-pill" style={{ borderColor: modeColor(m.mode) }}>
                          {m.mode} {Math.round(m.volume).toLocaleString()}
                          {m.utilizationPct != null ? ` (${m.utilizationPct.toFixed(0)}%)` : ''}
                        </span>
                      ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
