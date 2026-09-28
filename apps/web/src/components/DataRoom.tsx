import { useMemo, useState } from 'react'
import {
  downloadTemplate,
  mergeNetworkParts,
  parseDemandCsv,
  parseLanesCsv,
  parseSitesCsv,
  type CsvKind,
  type ParseDemandResult,
  type ParseLanesResult,
  type ParseSitesResult,
} from '../data/csvParsers'
import {
  bidCompareRollup,
  effectiveCostPerUnit,
  laneMiles,
  rankBids,
  strategyLabel,
  type BidStrategy,
  type RateUnit,
} from '../data/laneRates'
import {
  catalogLabel,
  demandSharesForNode,
  formatGroupCodes,
  laneGroups,
  type ProductCatalogId,
} from '../data/productGroups'
import { useFlowform } from '../state/FlowformContext'

type Draft = {
  sites?: ParseSitesResult
  demand?: ParseDemandResult
  lanes?: ParseLanesResult
  fileNames: Partial<Record<CsvKind, string>>
}

export function DataRoom() {
  const {
    network,
    loadUploadedNetwork,
    resetToSampleNetwork,
    constraints,
    emissionFactors,
    updateEmissionFactor,
    computedCo2Kt,
    productMix,
    setProductCatalog,
    updateDemandProductShares,
    updateFacilityProductCap,
    resetProductMix,
    laneRates,
    setLaneRatesStrategy,
    updateRateBid,
    removeRateBid,
    applyRateBid,
    applyWinningBids,
    resetLaneRates,
  } = useFlowform()
  const [draft, setDraft] = useState<Draft>({ fileNames: {} })
  const [status, setStatus] = useState<string | null>(null)

  const preview = useMemo(() => {
    if (!draft.sites && !draft.demand && !draft.lanes) return null
    return mergeNetworkParts(draft)
  }, [draft])

  async function onFile(kind: CsvKind, file: File | null) {
    if (!file) return
    const text = await file.text()
    setDraft((prev) => {
      const next: Draft = {
        ...prev,
        fileNames: { ...prev.fileNames, [kind]: file.name },
      }
      if (kind === 'sites') next.sites = parseSitesCsv(text)
      if (kind === 'demand') next.demand = parseDemandCsv(text)
      if (kind === 'lanes') next.lanes = parseLanesCsv(text)
      return next
    })
    setStatus(`Parsed ${file.name}`)
  }

  function handleLoad() {
    if (!preview) {
      setStatus('Upload at least one CSV (sites, demand, or lanes).')
      return
    }
    if (!preview.validation.ok) {
      setStatus('Fix validation errors before loading into the map.')
      return
    }
    loadUploadedNetwork(preview)
    setStatus(
      `Loaded into Network · ${preview.nodes.length} nodes · ${preview.lanes.length} lanes · reconcile ${preview.validation.reconcileScore}%`,
    )
  }

  function handleReset() {
    resetToSampleNetwork()
    setDraft({ fileNames: {} })
    setStatus('Restored built-in sample network.')
  }


  return (
    <div className="studio-room data-room">
      <header className="studio-header">
        <div>
          <p className="map-kicker">Data</p>
          <h1>Data room</h1>
          <p className="studio-sub">
            Upload sites, demand, and lanes/rates CSVs. Validate required
            columns, optional lat/lng geocode coverage, and baseline reconcile
            score — then load into the Network map.
          </p>
        </div>
      </header>

      <div className="studio-body data-body">
        <aside className="wizard-panel" aria-label="CSV uploads">
          <h2>Uploads</h2>

          <UploadCard
            title="Sites"
            kind="sites"
            fileName={draft.fileNames.sites}
            hint="id, name, kind, region, capacity, lat, lng"
            onFile={(f) => onFile('sites', f)}
          />
          <UploadCard
            title="Demand"
            kind="demand"
            fileName={draft.fileNames.demand}
            hint="id, name, region, volume, lat, lng"
            onFile={(f) => onFile('demand', f)}
          />
          <UploadCard
            title="Lanes / rates"
            kind="lanes"
            fileName={draft.fileNames.lanes}
            hint="id, from, to, mode, cost_per_unit, lead_days, co2_kg"
            onFile={(f) => onFile('lanes', f)}
          />

          <div className="promote-block">
            <button
              type="button"
              className="btn primary wizard-run"
              onClick={handleLoad}
              disabled={!preview}
            >
              Load into Network
            </button>
            <button
              type="button"
              className="btn ghost wizard-run"
              onClick={handleReset}
            >
              Reset to sample
            </button>
          </div>

          {status && <p className="status-line">{status}</p>}
        </aside>

        <div className="studio-main data-main">
          <div className="data-scores">
            <ScoreCard
              label="Active source"
              value={network.source === 'sample' ? 'Sample' : 'Upload'}
              sub={
                Object.values(network.fileNames).filter(Boolean).join(' · ') ||
                'Built-in NA footprint'
              }
            />
            <ScoreCard
              label="Geocode"
              value={`${(preview ?? network).validation.geocodeScore}%`}
              sub="lat/lng present on rows"
              tone={(preview ?? network).validation.geocodeScore >= 70 ? 'good' : 'warn'}
            />
            <ScoreCard
              label="Reconcile"
              value={`${(preview ?? network).validation.reconcileScore}%`}
              sub="vs sample baseline shape"
              tone={
                (preview ?? network).validation.reconcileScore >= 70
                  ? 'good'
                  : 'warn'
              }
            />
            <ScoreCard
              label="Rows"
              value={`${(preview ?? network).validation.rowCounts.sites} / ${(preview ?? network).validation.rowCounts.demand} / ${(preview ?? network).validation.rowCounts.lanes}`}
              sub="sites · demand · lanes"
            />
          </div>

          <section className="library-card data-validation" aria-label="Validation">
            <h2>Validation</h2>
            <ValidationList
              issues={(preview ?? network).validation.issues}
              ok={(preview ?? network).validation.ok}
            />
          </section>

          <section className="library-card" aria-label="Constraints snapshot">
            <h2>Constraints linked to Network</h2>
            <p className="studio-sub" style={{ marginTop: 0 }}>
              CapEx budget ${constraints.capexBudgetM}M · max{' '}
              {constraints.maxFacilities} facilities · service target{' '}
              {constraints.serviceTargetPct}% within{' '}
              {constraints.serviceRadiusMiles} mi. Edit statuses in Network
              Inspector.
            </p>
            <div className="table-scroll data-table">
              <table>
                <thead>
                  <tr>
                    <th>Facility</th>
                    <th>Status</th>
                    <th>Capacity band</th>
                    <th>CapEx</th>
                  </tr>
                </thead>
                <tbody>
                  {constraints.facilities.map((f) => {
                    const node = network.nodes.find((n) => n.id === f.nodeId)
                    return (
                      <tr key={f.nodeId}>
                        <td>{node?.name ?? f.nodeId}</td>
                        <td>
                          <span className={`status-pill status-${f.status}`}>
                            {f.status}
                          </span>
                        </td>
                        <td className="mono">
                          {f.capacityMin.toLocaleString()}–
                          {f.capacityMax.toLocaleString()}
                        </td>
                        <td>${f.fixedCapexM}M</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <section className="library-card" aria-label="Product mix">
            <div className="library-card-head">
              <h2>Product / commodity groups</h2>
              <div className="product-chip-row">
                <button
                  type="button"
                  className="btn ghost btn-tiny"
                  onClick={() => resetProductMix()}
                >
                  Reset mix
                </button>
              </div>
            </div>
            <p className="studio-sub" style={{ marginTop: 0 }}>
              Multi-commodity tags for demand, lanes, and facility capability.
              Catalog:{' '}
              <strong>{catalogLabel(productMix.catalog)}</strong>. Edit shares
              and capabilities here or in the Network Inspector.
            </p>
            <label className="field" style={{ maxWidth: '20rem' }}>
              <span>Catalog</span>
              <select
                value={productMix.catalog}
                onChange={(e) =>
                  setProductCatalog(e.target.value as ProductCatalogId)
                }
              >
                <option value="temp-handling">Ambient / Chilled / Hazmat</option>
                <option value="mfg-stage">Finished / WIP / RM</option>
              </select>
            </label>

            <div className="product-group-cards">
              {productMix.groups.map((g) => (
                <div key={g.id} className="product-group-card">
                  <span
                    className="product-chip-dot"
                    style={{ background: g.color }}
                    aria-hidden
                  />
                  <div>
                    <strong>
                      {g.name}{' '}
                      <span className="mono muted">({g.code})</span>
                    </strong>
                    <p className="muted tiny">{g.description}</p>
                  </div>
                </div>
              ))}
            </div>

            <h3 className="data-subhead">Demand mix by node</h3>
            <div className="table-scroll data-table">
              <table>
                <thead>
                  <tr>
                    <th>Demand node</th>
                    {productMix.groups.map((g) => (
                      <th key={g.id}>{g.code} %</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {network.nodes
                    .filter((n) => n.kind === 'demand')
                    .map((n) => {
                      const shares = demandSharesForNode(productMix, n.id)
                      return (
                        <tr key={n.id}>
                          <td>{n.name}</td>
                          {productMix.groups.map((g) => (
                            <td key={g.id}>
                              <input
                                className="factor-input mono"
                                type="number"
                                min={0}
                                max={100}
                                value={shares[g.id] ?? 0}
                                onChange={(e) =>
                                  updateDemandProductShares(n.id, {
                                    ...shares,
                                    [g.id]: Number(e.target.value),
                                  })
                                }
                                aria-label={`${n.name} ${g.code} share`}
                              />
                            </td>
                          ))}
                        </tr>
                      )
                    })}
                </tbody>
              </table>
            </div>

            <h3 className="data-subhead">Facility capabilities</h3>
            <div className="table-scroll data-table">
              <table>
                <thead>
                  <tr>
                    <th>Facility</th>
                    <th>Capable</th>
                    {productMix.groups.map((g) => (
                      <th key={g.id}>{g.code} cap</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {productMix.facilityCaps.map((f) => {
                    const node = network.nodes.find((n) => n.id === f.nodeId)
                    return (
                      <tr key={f.nodeId}>
                        <td>{node?.name ?? f.nodeId}</td>
                        <td className="tiny">
                          {formatGroupCodes(productMix, f.capableGroupIds)}
                        </td>
                        {productMix.groups.map((g) => (
                          <td key={g.id}>
                            <input
                              className="factor-input mono"
                              type="number"
                              min={0}
                              step={100}
                              value={f.capacityByGroup[g.id] ?? 0}
                              onChange={(e) => {
                                const val = Number(e.target.value)
                                const capable = new Set(f.capableGroupIds)
                                if (val > 0) capable.add(g.id)
                                else capable.delete(g.id)
                                updateFacilityProductCap(f.nodeId, {
                                  capableGroupIds: [...capable],
                                  capacityByGroup: {
                                    ...f.capacityByGroup,
                                    [g.id]: val,
                                  },
                                })
                              }}
                              aria-label={`${node?.name ?? f.nodeId} ${g.code} capacity`}
                            />
                          </td>
                        ))}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            <h3 className="data-subhead">Lane product tags (sample)</h3>
            <div className="table-scroll data-table">
              <table>
                <thead>
                  <tr>
                    <th>Lane</th>
                    <th>From → To</th>
                    <th>Products</th>
                  </tr>
                </thead>
                <tbody>
                  {network.lanes.slice(0, 12).map((l) => {
                    const from = network.nodes.find((n) => n.id === l.from)
                    const to = network.nodes.find((n) => n.id === l.to)
                    return (
                      <tr key={l.id}>
                        <td className="mono">{l.id}</td>
                        <td>
                          {from?.name ?? l.from} → {to?.name ?? l.to}
                        </td>
                        <td className="tiny">
                          {formatGroupCodes(
                            productMix,
                            laneGroups(productMix, l.id),
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <p className="hint">
              Toggle lane groups on a selected lane in the Network Inspector.
            </p>
          </section>

          <section className="library-card" aria-label="Lane rate tables">
            <div className="library-card-head">
              <h2>Lane rate tables &amp; bids</h2>
              <div className="product-chip-row">
                <button
                  type="button"
                  className="btn ghost btn-tiny"
                  onClick={() => {
                    const n = applyWinningBids()
                    setStatus(
                      `Applied ${strategyLabel(laneRates.compareStrategy)} winner on ${n} lane${n === 1 ? '' : 's'}.`,
                    )
                  }}
                >
                  Apply all winners
                </button>
                <button
                  type="button"
                  className="btn ghost btn-tiny"
                  onClick={() => {
                    resetLaneRates()
                    setStatus('Reset sample carrier rate tables.')
                  }}
                >
                  Reset rates
                </button>
              </div>
            </div>
            <p className="studio-sub" style={{ marginTop: 0 }}>
              Carrier bids per lane corridor — mode, $/unit or $/mile, transit
              days, capacity. Compare{' '}
              <strong>{strategyLabel(laneRates.compareStrategy)}</strong> and
              apply the selected bid onto active network lane cost (and transit).
              Edit here or apply from the Network Inspector on a selected lane.
            </p>
            <label className="field" style={{ maxWidth: '16rem' }}>
              <span>Compare strategy</span>
              <select
                value={laneRates.compareStrategy}
                onChange={(e) =>
                  setLaneRatesStrategy(e.target.value as BidStrategy)
                }
              >
                <option value="cheapest">Cheapest</option>
                <option value="fastest">Fastest</option>
                <option value="balanced">Balanced</option>
              </select>
            </label>
            {(() => {
              const rollup = bidCompareRollup(
                laneRates.tables.map((t) => {
                  const lane = network.lanes.find((l) => l.id === t.laneId)
                  const miles = lane ? laneMiles(lane, network.nodes) : 0
                  const ranked = rankBids(
                    t.bids,
                    miles,
                    laneRates.compareStrategy,
                    t.selectedBidId,
                  )
                  const winner = ranked.find((r) => r.isWinner) ?? null
                  const currentCost = lane?.costPerUnit ?? 0
                  return {
                    laneId: t.laneId,
                    corridorLabel: t.corridorLabel,
                    mode: lane?.mode ?? '—',
                    currentCost,
                    currentLeadDays: lane?.leadDays ?? 0,
                    miles,
                    bids: ranked,
                    winner,
                    selected: ranked.find((r) => r.isSelected) ?? null,
                    savingsPerUnit: winner
                      ? Math.round(
                          (currentCost - winner.effectiveCostPerUnit) * 100,
                        ) / 100
                      : 0,
                  }
                }),
              )
              return (
                <div className="data-scores" style={{ marginTop: '0.75rem' }}>
                  <ScoreCard
                    label="Lanes"
                    value={String(rollup.laneCount)}
                    sub={`${rollup.bidCount} bids`}
                  />
                  <ScoreCard
                    label="Avg current"
                    value={`$${rollup.avgCurrentCost.toFixed(2)}`}
                    sub="$/unit"
                  />
                  <ScoreCard
                    label="Avg winner"
                    value={`$${rollup.avgWinnerCost.toFixed(2)}`}
                    sub={strategyLabel(laneRates.compareStrategy)}
                    tone="good"
                  />
                  <ScoreCard
                    label="Savings Σ"
                    value={`${rollup.totalSavingsPerUnit >= 0 ? '' : '−'}$${Math.abs(rollup.totalSavingsPerUnit).toFixed(2)}`}
                    sub={`${rollup.lanesWithSavings} lanes cheaper`}
                    tone={rollup.totalSavingsPerUnit > 0 ? 'good' : 'warn'}
                  />
                </div>
              )
            })()}

            <h3 className="data-subhead">Bids by corridor</h3>
            <div className="table-scroll data-table">
              <table>
                <thead>
                  <tr>
                    <th>Corridor</th>
                    <th>Carrier</th>
                    <th>Mode</th>
                    <th>Rate</th>
                    <th>Unit</th>
                    <th>$/unit</th>
                    <th>Transit</th>
                    <th>Capacity</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {laneRates.tables.flatMap((t) => {
                    const lane = network.lanes.find((l) => l.id === t.laneId)
                    const miles = lane ? laneMiles(lane, network.nodes) : 0
                    const ranked = rankBids(
                      t.bids,
                      miles,
                      laneRates.compareStrategy,
                      t.selectedBidId,
                    )
                    return ranked.map((row) => (
                      <tr
                        key={row.bid.id}
                        className={
                          row.isWinner
                            ? 'rate-row winner'
                            : row.isSelected
                              ? 'rate-row selected'
                              : undefined
                        }
                      >
                        <td className="tiny">
                          {t.corridorLabel}
                          {row.isWinner ? ' ★' : ''}
                          {row.isSelected ? ' ✓' : ''}
                        </td>
                        <td>
                          <input
                            className="factor-input"
                            value={row.bid.carrier}
                            onChange={(e) =>
                              updateRateBid(t.laneId, row.bid.id, {
                                carrier: e.target.value,
                              })
                            }
                            aria-label="Carrier"
                          />
                        </td>
                        <td>
                          <select
                            value={row.bid.mode}
                            onChange={(e) =>
                              updateRateBid(t.laneId, row.bid.id, {
                                mode: e.target.value,
                              })
                            }
                            aria-label="Mode"
                          >
                            <option value="Road">Road</option>
                            <option value="Rail">Rail</option>
                            <option value="Air">Air</option>
                            <option value="Ocean">Ocean</option>
                            <option value="Intermodal">Intermodal</option>
                          </select>
                        </td>
                        <td>
                          <input
                            className="factor-input mono"
                            type="number"
                            min={0}
                            step={0.01}
                            value={row.bid.rate}
                            onChange={(e) =>
                              updateRateBid(t.laneId, row.bid.id, {
                                rate: Number(e.target.value),
                              })
                            }
                            aria-label="Rate"
                          />
                        </td>
                        <td>
                          <select
                            value={row.bid.rateUnit}
                            onChange={(e) =>
                              updateRateBid(t.laneId, row.bid.id, {
                                rateUnit: e.target.value as RateUnit,
                              })
                            }
                            aria-label="Rate unit"
                          >
                            <option value="per_unit">$/unit</option>
                            <option value="per_mile">$/mile</option>
                          </select>
                        </td>
                        <td className="mono">
                          ${effectiveCostPerUnit(row.bid, miles).toFixed(2)}
                        </td>
                        <td>
                          <input
                            className="factor-input mono"
                            type="number"
                            min={1}
                            step={1}
                            value={row.bid.transitDays}
                            onChange={(e) =>
                              updateRateBid(t.laneId, row.bid.id, {
                                transitDays: Number(e.target.value),
                              })
                            }
                            aria-label="Transit days"
                          />
                        </td>
                        <td>
                          <input
                            className="factor-input mono"
                            type="number"
                            min={0}
                            step={100}
                            value={row.bid.capacityUnits}
                            onChange={(e) =>
                              updateRateBid(t.laneId, row.bid.id, {
                                capacityUnits: Number(e.target.value),
                              })
                            }
                            aria-label="Capacity"
                          />
                        </td>
                        <td className="bid-cell-actions">
                          <button
                            type="button"
                            className="btn primary btn-tiny"
                            onClick={() => {
                              applyRateBid(t.laneId, row.bid.id)
                              setStatus(
                                `Applied ${row.bid.carrier} to ${t.corridorLabel}.`,
                              )
                            }}
                          >
                            Apply
                          </button>
                          <button
                            type="button"
                            className="btn ghost btn-tiny"
                            onClick={() =>
                              removeRateBid(t.laneId, row.bid.id)
                            }
                          >
                            ×
                          </button>
                        </td>
                      </tr>
                    ))
                  })}
                </tbody>
              </table>
            </div>
            <p className="hint">
              Add a bid on a corridor from Network Inspector, or reset sample
              rates above. ★ = strategy winner · ✓ = applied to lane.
            </p>
          </section>

          <section className="library-card" aria-label="CO2 emission factors">
            <h2>CO₂ emission factors</h2>
            <p className="studio-sub" style={{ marginTop: 0 }}>
              Planning factors (kg CO₂e / ton-mile). Network KPI CO₂ is computed
              as lane distance × mode factor when sites have coordinates —
              currently <strong>{computedCo2Kt.toFixed(1)} kt</strong> for the
              active network.
            </p>
            <div className="table-scroll data-table">
              <table>
                <thead>
                  <tr>
                    <th>Mode</th>
                    <th>kg / ton-mile</th>
                    <th>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {emissionFactors.map((f) => (
                    <tr key={f.mode}>
                      <td>{f.mode}</td>
                      <td>
                        <input
                          className="factor-input mono"
                          type="number"
                          min={0}
                          step={0.001}
                          value={f.kgPerTonMile}
                          onChange={(e) =>
                            updateEmissionFactor(
                              f.mode,
                              parseFloat(e.target.value) || 0,
                            )
                          }
                          aria-label={`${f.mode} kg per ton-mile`}
                        />
                      </td>
                      <td className="muted tiny">{f.notes}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}

function UploadCard({
  title,
  kind,
  fileName,
  hint,
  onFile,
}: {
  title: string
  kind: CsvKind
  fileName?: string
  hint: string
  onFile: (f: File | null) => void
}) {
  return (
    <div className="upload-card">
      <div className="upload-card-head">
        <h3>{title}</h3>
        <button
          type="button"
          className="btn ghost btn-tiny"
          onClick={() => downloadTemplate(kind)}
        >
          Template
        </button>
      </div>
      <p className="upload-hint">{hint}</p>
      <label className="file-drop">
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => onFile(e.target.files?.[0] ?? null)}
        />
        <span>{fileName ?? 'Choose CSV…'}</span>
      </label>
    </div>
  )
}

function ScoreCard({
  label,
  value,
  sub,
  tone,
}: {
  label: string
  value: string
  sub: string
  tone?: 'good' | 'warn'
}) {
  return (
    <div className={`score-card${tone ? ` tone-${tone}` : ''}`}>
      <span className="score-label">{label}</span>
      <strong className="score-value">{value}</strong>
      <span className="score-sub">{sub}</span>
    </div>
  )
}

function ValidationList({
  issues,
  ok,
}: {
  issues: { level: string; message: string; row?: number }[]
  ok: boolean
}) {
  if (issues.length === 0) {
    return <p className="hint">No issues — dataset looks loadable.</p>
  }
  return (
    <>
      <p className={`validation-banner ${ok ? 'ok' : 'bad'}`}>
        {ok ? 'Ready to load' : 'Blocked — fix errors'}
      </p>
      <ul className="issue-list">
        {issues.slice(0, 40).map((issue, i) => (
          <li key={i} className={`issue-${issue.level}`}>
            <span className="issue-level">{issue.level}</span>
            {issue.message}
          </li>
        ))}
      </ul>
    </>
  )
}
