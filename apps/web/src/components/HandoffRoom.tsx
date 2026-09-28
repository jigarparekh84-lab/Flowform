import { useMemo, useState } from 'react'
import {
  buildHandoffPackage,
  downloadHandoffJson,
  downloadHandoffOpsBrief,
  HANDOFF_SCHEMA_VERSION,
  type HandoffPackage,
} from '../data/handoffPackage'
import { useFlowform } from '../state/FlowformContext'

type SectionId =
  | 'overview'
  | 'network'
  | 'preferred'
  | 'territory'
  | 'capex'
  | 'products'
  | 'bom'
  | 'inventory'
  | 'scenarios'
  | 'readme'
  | 'raw'

const SECTIONS: { id: SectionId; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'network', label: 'Network' },
  { id: 'preferred', label: 'Preferred lanes' },
  { id: 'territory', label: 'Territory' },
  { id: 'capex', label: 'CapEx years' },
  { id: 'products', label: 'Product mix' },
  { id: 'bom', label: 'BOM / RM' },
  { id: 'inventory', label: 'Inventory' },
  { id: 'scenarios', label: 'Scenarios' },
  { id: 'readme', label: 'Schema README' },
  { id: 'raw', label: 'Raw JSON' },
]

export function HandoffRoom() {
  const {
    handoffPayload,
    brief,
    scenarios,
    network,
    projectName,
    horizon,
    capexRoadmap,
    productMix,
    bom,
    inventoryPolicies,
  } = useFlowform()

  const payload = handoffPayload ?? (brief.sentToHandoffAt ? brief : null)
  const [section, setSection] = useState<SectionId>('overview')

  const pkg = useMemo(() => {
    if (!payload) return null
    return buildHandoffPackage({
      brief: payload,
      scenarios,
      network,
      projectName,
      horizon,
      capexRoadmap,
      productMix,
      bom,
      inventoryPolicies,
      sentAt: payload.sentToHandoffAt,
    })
  }, [
    payload,
    scenarios,
    network,
    projectName,
    horizon,
    capexRoadmap,
    productMix,
    bom,
    inventoryPolicies,
  ])

  const rec = scenarios.find((s) => s.id === payload?.recommendedScenarioId)

  function handleDownloadJson() {
    if (!pkg) return
    downloadHandoffJson(pkg, horizon)
  }

  function handleDownloadOps() {
    if (!pkg) return
    downloadHandoffOpsBrief(pkg, horizon)
  }

  return (
    <div className="studio-room handoff-room">
      <header className="studio-header">
        <div>
          <p className="map-kicker">Handoff</p>
          <h1>S&amp;OP design exit ramp</h1>
          <p className="studio-sub">
            Enriched package of sites, lanes, preferred territory corridors,
            CapEx year events, product mix, BOM implied RM, inventory targets,
            and scenario metadata — Ritara-compatible intake stub (no planner
            screens).
          </p>
        </div>
      </header>

      <div className="brief-layout">
        {!payload || !pkg ? (
          <div className="library-card">
            <h2>Waiting for Brief</h2>
            <p className="studio-sub">
              Open Decision Brief, confirm the recommendation and assumptions,
              then click <strong>Send to Handoff</strong>.
            </p>
          </div>
        ) : (
          <>
            <div className="brief-banner">
              <div>
                <p className="map-kicker">Package ready</p>
                <h2>{rec?.name ?? 'Scenario'}</h2>
                <p>
                  Schema <code>{HANDOFF_SCHEMA_VERSION}</code> · Received{' '}
                  {payload.sentToHandoffAt
                    ? new Date(payload.sentToHandoffAt).toLocaleString()
                    : '—'}
                  . Ritara APS intake contract — design only.
                </p>
                <div className="handoff-count-chips" aria-label="Package section counts">
                  {Object.entries(pkg.section_counts).map(([k, v]) => (
                    <span key={k} className="handoff-chip">
                      <strong>{v}</strong> {k.replace(/_/g, ' ')}
                    </span>
                  ))}
                </div>
              </div>
              <div className="brief-banner-actions">
                <div className="brief-export-row">
                  <button
                    type="button"
                    className="btn primary"
                    onClick={handleDownloadJson}
                  >
                    Download JSON
                  </button>
                  <button
                    type="button"
                    className="btn ghost"
                    onClick={handleDownloadOps}
                  >
                    Ops brief (Markdown)
                  </button>
                </div>
                <p className="status-line">
                  JSON includes inline schema README · Markdown is planner-facing
                </p>
              </div>
            </div>

            <div className="handoff-section-tabs" role="tablist">
              {SECTIONS.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  role="tab"
                  aria-selected={section === s.id}
                  className={`btn-tiny${section === s.id ? ' on' : ''}`}
                  onClick={() => setSection(s.id)}
                >
                  {s.label}
                </button>
              ))}
            </div>

            <div className="library-card handoff-section-panel">
              <SectionPreview section={section} pkg={pkg} />
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function SectionPreview({
  section,
  pkg,
}: {
  section: SectionId
  pkg: HandoffPackage
}) {
  switch (section) {
    case 'overview':
      return (
        <>
          <h2>Package overview</h2>
          <p className="studio-sub">
            Target: <strong>{pkg.target}</strong> · Project{' '}
            <strong>{pkg.meta.project_name}</strong> · Horizon{' '}
            <strong>{pkg.meta.horizon}</strong>
          </p>
          <dl className="handoff-dl">
            <dt>Schema</dt>
            <dd>
              <code>{pkg.schema_version}</code>
            </dd>
            <dt>Generated</dt>
            <dd>{new Date(pkg.meta.generated_at).toLocaleString()}</dd>
            <dt>Recommended</dt>
            <dd>{pkg.brief.recommended_scenario_id ?? '—'}</dd>
            <dt>Compared</dt>
            <dd>{pkg.brief.compared_scenario_ids.join(', ') || '—'}</dd>
            <dt>Checked assumptions</dt>
            <dd>
              {pkg.brief.assumptions.filter((a) => a.checked).length} /{' '}
              {pkg.brief.assumptions.length}
            </dd>
          </dl>
          {pkg.brief.notes.trim() ? (
            <div className="handoff-notes">
              <h3>Brief notes</h3>
              <pre>{pkg.brief.notes.trim()}</pre>
            </div>
          ) : null}
        </>
      )

    case 'network':
      return (
        <>
          <h2>
            Network — {pkg.network.site_count} sites · {pkg.network.lane_count}{' '}
            lanes
          </h2>
          <div className="handoff-table-wrap">
            <table className="handoff-table">
              <thead>
                <tr>
                  <th>Site</th>
                  <th>Kind</th>
                  <th>Region</th>
                  <th>Capacity</th>
                  <th>Lat/Lng</th>
                </tr>
              </thead>
              <tbody>
                {pkg.network.sites.map((s) => (
                  <tr key={s.site_id}>
                    <td>
                      <strong>{s.name}</strong>
                      <div className="muted">{s.site_id}</div>
                    </td>
                    <td>{s.kind}</td>
                    <td>{s.region}</td>
                    <td>{s.capacity}</td>
                    <td>
                      {s.lat != null && s.lng != null
                        ? `${s.lat.toFixed(2)}, ${s.lng.toFixed(2)}`
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3 className="handoff-subh">Lanes (sample)</h3>
          <div className="handoff-table-wrap">
            <table className="handoff-table">
              <thead>
                <tr>
                  <th>Lane</th>
                  <th>From → To</th>
                  <th>Mode</th>
                  <th>$/u</th>
                  <th>Lead</th>
                  <th>Flags</th>
                </tr>
              </thead>
              <tbody>
                {pkg.network.lanes.slice(0, 40).map((l) => (
                  <tr key={l.lane_id}>
                    <td className="muted">{l.lane_id}</td>
                    <td>
                      {l.from_site_id} → {l.to_site_id}
                    </td>
                    <td>{l.mode}</td>
                    <td>{l.cost_per_unit}</td>
                    <td>{l.lead_days}d</td>
                    <td>
                      {l.preferred_demand ? 'preferred ' : ''}
                      {l.territory_sourced ? 'territory' : ''}
                      {!l.preferred_demand && !l.territory_sourced ? '—' : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pkg.network.lanes.length > 40 ? (
            <p className="studio-sub">
              Showing 40 of {pkg.network.lanes.length} lanes — full set in JSON.
            </p>
          ) : null}
        </>
      )

    case 'preferred':
      return (
        <>
          <h2>Preferred lanes ({pkg.preferred_lanes.length})</h2>
          <p className="studio-sub">
            Demand-inbound corridors from the network (territory-applied when
            present; otherwise soft territory preview).
          </p>
          {!pkg.preferred_lanes.length ? (
            <p className="studio-sub">No preferred lanes in package.</p>
          ) : (
            <div className="handoff-table-wrap">
              <table className="handoff-table">
                <thead>
                  <tr>
                    <th>From</th>
                    <th>To</th>
                    <th>Mode</th>
                    <th>Lead</th>
                    <th>$/u</th>
                    <th>Demand vol</th>
                    <th>Source</th>
                  </tr>
                </thead>
                <tbody>
                  {pkg.preferred_lanes.map((l) => (
                    <tr key={l.lane_id}>
                      <td>{l.from_name}</td>
                      <td>{l.to_name}</td>
                      <td>{l.mode}</td>
                      <td>{l.lead_days}d</td>
                      <td>{l.cost_per_unit}</td>
                      <td>{l.demand_volume ?? '—'}</td>
                      <td>
                        {l.territory_sourced ? 'territory' : 'network'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )

    case 'territory':
      return (
        <>
          <h2>Territory coverage</h2>
          <p className="studio-sub">{pkg.territory.summary}</p>
          <dl className="handoff-dl">
            <dt>Mode</dt>
            <dd>{pkg.territory.mode}</dd>
            <dt>Within miles</dt>
            <dd>
              {pkg.territory.metrics.pctCoveredWithinMiles}% (
              {pkg.territory.coverage_miles} mi)
            </dd>
            <dt>Within lead</dt>
            <dd>
              {pkg.territory.metrics.pctCoveredWithinLead}% (
              {pkg.territory.coverage_lead_days}d)
            </dd>
            <dt>Gaps / overlaps</dt>
            <dd>
              {pkg.territory.metrics.gapCount} /{' '}
              {pkg.territory.metrics.overlapCount}
            </dd>
          </dl>
          <div className="handoff-table-wrap">
            <table className="handoff-table">
              <thead>
                <tr>
                  <th>Demand</th>
                  <th>Facility</th>
                  <th>Miles</th>
                  <th>Lead</th>
                  <th>Vol</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {pkg.territory.assignments.map((a) => (
                  <tr key={a.demand_id}>
                    <td>{a.demand_name}</td>
                    <td>{a.facility_name ?? '—'}</td>
                    <td>{a.miles != null ? a.miles.toFixed(0) : '—'}</td>
                    <td>{a.lead_days ?? '—'}</td>
                    <td>{a.volume}</td>
                    <td>{a.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )

    case 'capex':
      return (
        <>
          <h2>CapEx year events ({pkg.capex_events.length})</h2>
          {!pkg.capex_events.length ? (
            <p className="studio-sub">No CapEx events on the roadmap.</p>
          ) : (
            <div className="handoff-table-wrap">
              <table className="handoff-table">
                <thead>
                  <tr>
                    <th>Year</th>
                    <th>Event</th>
                    <th>Kind</th>
                    <th>Site</th>
                    <th>CapEx $M</th>
                    <th>Δ capacity</th>
                  </tr>
                </thead>
                <tbody>
                  {pkg.capex_events.map((e) => (
                    <tr key={e.event_id}>
                      <td>
                        {e.year_label}{' '}
                        <span className="muted">Y{e.year_index}</span>
                      </td>
                      <td>{e.name}</td>
                      <td>{e.kind}</td>
                      <td>{e.site_name}</td>
                      <td>{e.capex_m}</td>
                      <td>{e.capacity_delta}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <h3 className="handoff-subh">Cumulative year slices</h3>
          <div className="handoff-table-wrap">
            <table className="handoff-table">
              <thead>
                <tr>
                  <th>Year</th>
                  <th>CapEx this yr</th>
                  <th>Cum CapEx</th>
                  <th>Cum Δ cap</th>
                  <th>Total capacity</th>
                  <th>Open</th>
                  <th>Events</th>
                </tr>
              </thead>
              <tbody>
                {pkg.capex_year_slices.map((y) => (
                  <tr key={y.year_index}>
                    <td>
                      {y.year_label} ({y.label})
                    </td>
                    <td>${y.capex_this_year_m}M</td>
                    <td>${y.cumulative_capex_m}M</td>
                    <td>{y.cumulative_capacity_delta}</td>
                    <td>{y.total_capacity_units}</td>
                    <td>{y.open_facility_count}</td>
                    <td>{y.event_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )

    case 'products':
      return (
        <>
          <h2>
            Product mix — {pkg.product_mix.catalog_label} (
            {pkg.product_mix.groups.length} groups)
          </h2>
          <div className="handoff-table-wrap">
            <table className="handoff-table">
              <thead>
                <tr>
                  <th>Group</th>
                  <th>Code</th>
                  <th>Handling</th>
                  <th>Demand share</th>
                  <th>Capable sites</th>
                  <th>Cap units</th>
                </tr>
              </thead>
              <tbody>
                {pkg.product_mix.rollup.map((g) => (
                  <tr key={g.groupId}>
                    <td>
                      <span
                        className="handoff-swatch"
                        style={{ background: g.color }}
                        aria-hidden
                      />{' '}
                      {g.name}
                    </td>
                    <td>{g.code}</td>
                    <td>
                      {pkg.product_mix.groups.find((x) => x.id === g.groupId)
                        ?.handling ?? '—'}
                    </td>
                    <td>{g.demandSharePct}%</td>
                    <td>{g.capableFacilities}</td>
                    <td>{g.capacityUnits}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )

    case 'bom':
      return (
        <>
          <h2>
            BOM / implied RM — {pkg.bom.rollup.bomRows} rows ·{' '}
            {pkg.bom.rollup.totalRmQty} RM qty
          </h2>
          <dl className="handoff-dl">
            <dt>FG SKUs</dt>
            <dd>{pkg.bom.rollup.fgCount}</dd>
            <dt>Components</dt>
            <dd>{pkg.bom.rollup.componentCount}</dd>
            <dt>Plant←Supplier</dt>
            <dd>
              {pkg.bom.rollup.plantSupplierFlows} (
              {pkg.bom.rollup.impliedLaneGaps} implied gaps)
            </dd>
            <dt>FG←RM flows</dt>
            <dd>{pkg.bom.rollup.materialFlows}</dd>
          </dl>
          <h3 className="handoff-subh">Implied RM demand</h3>
          {!pkg.bom.implied_rm.length ? (
            <p className="studio-sub">No implied RM.</p>
          ) : (
            <div className="handoff-table-wrap">
              <table className="handoff-table">
                <thead>
                  <tr>
                    <th>Component</th>
                    <th>Kind</th>
                    <th>Qty needed</th>
                    <th>Preferred supplier</th>
                  </tr>
                </thead>
                <tbody>
                  {pkg.bom.implied_rm.map((r) => (
                    <tr key={r.componentId}>
                      <td>{r.componentName}</td>
                      <td>{r.componentKind}</td>
                      <td>{Math.round(r.qtyNeeded)}</td>
                      <td>{r.preferredSupplierName ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )

    case 'inventory':
      return (
        <>
          <h2>Inventory targets</h2>
          {!pkg.inventory_targets?.present ? (
            <p className="studio-sub">
              No inventory policies present in this project.
            </p>
          ) : (
            <>
              <dl className="handoff-dl">
                <dt>Formula</dt>
                <dd>{pkg.inventory_targets.formula}</dd>
                <dt>Total SS units</dt>
                <dd>{pkg.inventory_targets.total_units}</dd>
                <dt>Total inventory $</dt>
                <dd>${pkg.inventory_targets.total_dollars_m}M</dd>
              </dl>
              <div className="handoff-table-wrap">
                <table className="handoff-table">
                  <thead>
                    <tr>
                      <th>Site</th>
                      <th>Kind</th>
                      <th>Service %</th>
                      <th>LT d</th>
                      <th>SS units</th>
                      <th>Inv $</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(pkg.inventory_targets.nodes ?? []).map((n) => (
                      <tr key={n.site_id}>
                        <td>{n.name}</td>
                        <td>{n.kind}</td>
                        <td>{n.service_target_pct}</td>
                        <td>{n.lead_time_days}</td>
                        <td>{n.safety_stock_units}</td>
                        <td>${n.inventory_dollars}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )

    case 'scenarios':
      return (
        <>
          <h2>Scenario metadata ({pkg.scenarios.length})</h2>
          <div className="handoff-table-wrap">
            <table className="handoff-table">
              <thead>
                <tr>
                  <th>Scenario</th>
                  <th>Role</th>
                  <th>Tag</th>
                  <th>Cost</th>
                  <th>Service</th>
                  <th>CapEx</th>
                  <th>Extras</th>
                </tr>
              </thead>
              <tbody>
                {pkg.scenarios.map((s) => (
                  <tr key={s.scenario_id}>
                    <td>
                      <strong>{s.name}</strong>
                      <div className="muted">{s.scenario_id}</div>
                    </td>
                    <td>{s.role}</td>
                    <td>{s.tag}</td>
                    <td>{s.kpis.cost.value}</td>
                    <td>{s.kpis.service.value}</td>
                    <td>{s.kpis.capex.value}</td>
                    <td>
                      {[
                        s.optimize ? 'optimize' : null,
                        s.des_lite ? 'DES' : null,
                        s.resilience ? 'resilience' : null,
                        s.inventory_rollup ? 'inv' : null,
                      ]
                        .filter(Boolean)
                        .join(', ') || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )

    case 'readme':
      return (
        <>
          <h2>Schema README (embedded in JSON)</h2>
          <pre className="handoff-json handoff-readme">{pkg.readme}</pre>
        </>
      )

    case 'raw':
      return (
        <>
          <h2>Raw JSON preview</h2>
          <pre className="handoff-json">
            {JSON.stringify(
              {
                schema_version: pkg.schema_version,
                product: pkg.product,
                target: pkg.target,
                meta: pkg.meta,
                section_counts: pkg.section_counts,
                brief: {
                  ...pkg.brief,
                  assumptions: pkg.brief.assumptions.filter((a) => a.checked),
                },
                network: {
                  site_count: pkg.network.site_count,
                  lane_count: pkg.network.lane_count,
                  sites_sample: pkg.network.sites.slice(0, 3),
                  lanes_sample: pkg.network.lanes.slice(0, 3),
                },
                preferred_lanes_count: pkg.preferred_lanes.length,
                capex_events_count: pkg.capex_events.length,
                product_groups: pkg.product_mix.groups.map((g) => g.code),
                bom_rollup: pkg.bom.rollup,
                inventory_present: !!pkg.inventory_targets?.present,
                scenarios: pkg.scenarios.map((s) => ({
                  id: s.scenario_id,
                  role: s.role,
                  name: s.name,
                })),
                readme_excerpt: pkg.readme.split('\n').slice(0, 8).join('\n'),
              },
              null,
              2,
            )}
          </pre>
          <p className="studio-sub">
            Truncated preview — use <strong>Download JSON</strong> for the full
            package (includes complete sites, lanes, and README).
          </p>
        </>
      )

    default:
      return null
  }
}
