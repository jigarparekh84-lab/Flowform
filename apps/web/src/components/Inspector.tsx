import { TRANSPORT_MODES, normalizeMode } from '../data/modeMix'
import {
  laneMiles,
  rankBids,
  strategyLabel,
  tableForLane,
  type BidStrategy,
  type RateUnit,
} from '../data/laneRates'
import {
  demandSharesForNode,
  facilityCapFor,
  formatGroupCodes,
  laneGroups,
  type ProductGroupId,
} from '../data/productGroups'
import {
  componentKindLabel,
  deriveBomRequirements,
  deriveEchelonFlows,
} from '../data/bom'
import { kindLabel, type FacilityStatus } from '../data/sampleNetwork'
import { useFlowform } from '../state/FlowformContext'
import { EmptyState } from './ui/EmptyState'

type Props = {
  selectedIds: string[]
  selectedKind: 'node' | 'lane' | null
}

export function Inspector({ selectedIds, selectedKind }: Props) {
  const {
    nodes,
    lanes,
    nodeById,
    constraints,
    updateFacilityConstraint,
    updateConstraintGlobals,
    updateLaneMode,
    productMix,
    setProductFilter,
    updateDemandProductShares,
    updateLaneProductGroups,
    updateFacilityProductCap,
    laneRates,
    setLaneRatesStrategy,
    addRateBid,
    removeRateBid,
    applyRateBid,
    applyWinningBids,
    network,
    bom,
    setBomHighlight,
  } = useFlowform()

  const primaryId = selectedIds[selectedIds.length - 1] ?? null
  const node =
    selectedKind === 'node' && primaryId
      ? nodes.find((n) => n.id === primaryId)
      : undefined
  const lane =
    selectedKind === 'lane' && primaryId
      ? lanes.find((l) => l.id === primaryId)
      : undefined
  const multi = selectedIds.length > 1

  const facility = node
    ? constraints.facilities.find((f) => f.nodeId === node.id)
    : undefined
  const isFacility =
    node &&
    (node.kind === 'dc' || node.kind === 'plant' || node.kind === 'candidate')
  const facCap = node ? facilityCapFor(productMix, node.id) : undefined
  const demandShares = node ? demandSharesForNode(productMix, node.id) : null
  const laneGroupIds = lane ? laneGroups(productMix, lane.id) : []
  const rateTable = lane ? tableForLane(laneRates, lane.id) : undefined
  const miles = lane ? laneMiles(lane, nodes) : 0
  const rankedBids = rateTable
    ? rankBids(
        rateTable.bids,
        miles,
        laneRates.compareStrategy,
        rateTable.selectedBidId,
      )
    : []

  function toggleLaneGroup(gid: ProductGroupId) {
    if (!lane) return
    const has = laneGroupIds.includes(gid)
    const next = has
      ? laneGroupIds.filter((x) => x !== gid)
      : [...laneGroupIds, gid]
    updateLaneProductGroups(lane.id, next.length === 0 ? productMix.groups.map((g) => g.id) : next)
  }

  function toggleFacilityCapable(gid: ProductGroupId) {
    if (!node || !facCap) return
    const has = facCap.capableGroupIds.includes(gid)
    const capableGroupIds = has
      ? facCap.capableGroupIds.filter((x) => x !== gid)
      : [...facCap.capableGroupIds, gid]
    const capacityByGroup = { ...facCap.capacityByGroup }
    if (!has && !(capacityByGroup[gid] > 0)) {
      capacityByGroup[gid] = 5000
    }
    if (has) capacityByGroup[gid] = 0
    updateFacilityProductCap(node.id, { capableGroupIds, capacityByGroup })
  }

  return (
    <aside className="inspector" aria-label="Inspector">
      <h2>Inspector</h2>

      <div className="product-filter-block">
        <h3>Product group filter</h3>
        <div className="product-chip-row" role="group" aria-label="Filter by product group">
          <button
            type="button"
            className={
              productMix.filterGroupId == null
                ? 'product-chip on'
                : 'product-chip'
            }
            onClick={() => setProductFilter(null)}
          >
            All
          </button>
          {productMix.groups.map((g) => (
            <button
              key={g.id}
              type="button"
              className={
                productMix.filterGroupId === g.id
                  ? 'product-chip on'
                  : 'product-chip'
              }
              style={{ ['--pg-color' as string]: g.color }}
              onClick={() =>
                setProductFilter(
                  productMix.filterGroupId === g.id ? null : g.id,
                )
              }
              title={g.description}
            >
              <span className="product-chip-dot" aria-hidden />
              {g.code}
            </button>
          ))}
        </div>
        <p className="hint">
          Map and tables dim entities outside the selected commodity group.
        </p>
      </div>

      {!node && !lane && (
        <>
          <EmptyState
            compact
            title="Nothing selected"
            body="Click a node or lane on the map or in the tables. Shift-click to multi-select · Esc clears."
          />
          <ConstraintsPanel
            constraints={constraints}
            nodes={nodes}
            onGlobals={updateConstraintGlobals}
            onFacility={updateFacilityConstraint}
          />
        </>
      )}
      {multi && (
        <p className="selection-badge">
          {selectedIds.length} {selectedKind}
          {selectedIds.length === 1 ? '' : 's'} selected
        </p>
      )}
      {node && (
        <>
          <dl className="stub-fields">
            <div>
              <dt>Name</dt>
              <dd>{node.name}</dd>
            </div>
            <div>
              <dt>Type</dt>
              <dd>{kindLabel(node.kind)}</dd>
            </div>
            <div>
              <dt>Region</dt>
              <dd>{node.region}</dd>
            </div>
            <div>
              <dt>Capacity</dt>
              <dd>{node.capacity}</dd>
            </div>
            <div>
              <dt>ID</dt>
              <dd className="mono">{node.id}</dd>
            </div>
          </dl>
          {node.kind === 'demand' && demandShares && (
            <div className="constraint-edit product-edit">
              <h3>Demand product mix</h3>
              <p className="hint">Volume share % by product group (≈100).</p>
              {productMix.groups.map((g) => (
                <label key={g.id} className="field">
                  <span>
                    <span
                      className="product-chip-dot inline"
                      style={{ background: g.color }}
                      aria-hidden
                    />{' '}
                    {g.name} ({g.code})
                  </span>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step={1}
                    value={demandShares[g.id] ?? 0}
                    onChange={(e) => {
                      const next = {
                        ...demandShares,
                        [g.id]: Number(e.target.value),
                      }
                      updateDemandProductShares(node.id, next)
                    }}
                  />
                </label>
              ))}
            </div>
          )}
          {isFacility && facCap && (
            <div className="constraint-edit product-edit">
              <h3>Product capabilities</h3>
              <ul className="product-capable-list">
                {productMix.groups.map((g) => {
                  const on = facCap.capableGroupIds.includes(g.id)
                  return (
                    <li key={g.id}>
                      <label className="layer-row">
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() => toggleFacilityCapable(g.id)}
                        />
                        <span
                          className="product-chip-dot inline"
                          style={{ background: g.color }}
                          aria-hidden
                        />
                        <span>{g.name}</span>
                      </label>
                      <input
                        className="factor-input mono"
                        type="number"
                        min={0}
                        step={100}
                        disabled={!on}
                        value={facCap.capacityByGroup[g.id] ?? 0}
                        onChange={(e) =>
                          updateFacilityProductCap(node.id, {
                            capacityByGroup: {
                              ...facCap.capacityByGroup,
                              [g.id]: Number(e.target.value),
                            },
                          })
                        }
                        aria-label={`${g.name} capacity`}
                      />
                    </li>
                  )
                })}
              </ul>
            </div>
          )}

          {node.kind === 'plant' && (
            <div className="constraint-edit bom-edit">
              <h3>BOM production (FG ← RM)</h3>
              <p className="hint">
                Plant builds finished goods from inbound components. Edit rows in
                Data → Bill of materials.
              </p>
              <label className="layer-row" style={{ marginBottom: '0.5rem' }}>
                <input
                  type="checkbox"
                  checked={bom.highlightBomLanes}
                  onChange={(e) => setBomHighlight(e.target.checked)}
                />
                <span>Highlight BOM lanes on map</span>
              </label>
              {deriveBomRequirements(bom, network)
                .filter((r) => r.plantId === node.id)
                .map((r) => (
                  <div key={`${r.plantId}-${r.finishedGoodId}`} className="bom-req-card">
                    <strong>
                      {r.finishedGoodName}{' '}
                      <span className="mono muted">
                        ({r.fgDemand.toLocaleString()} FG)
                      </span>
                    </strong>
                    <ul className="bom-comp-list">
                      {r.components.map((c) => (
                        <li key={c.componentId}>
                          <span className="bom-kind">
                            {componentKindLabel(c.componentKind)}
                          </span>{' '}
                          {c.componentName}{' '}
                          <span className="mono">
                            ×{c.qtyPerUnit} → {c.qtyNeeded.toLocaleString()}
                          </span>
                          {c.supplierName ? (
                            <span className="muted tiny">
                              {' '}
                              ← {c.supplierName}
                            </span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              {deriveBomRequirements(bom, network).filter(
                (r) => r.plantId === node.id,
              ).length === 0 && (
                <p className="hint">No BOM rows bound to this plant.</p>
              )}
            </div>
          )}
          {node.kind === 'supplier' && (
            <div className="constraint-edit bom-edit">
              <h3>BOM outbound (Plant ← Supplier)</h3>
              <ul className="bom-comp-list">
                {deriveEchelonFlows(bom, network)
                  .filter(
                    (f) =>
                      f.echelon === 'plant←supplier' && f.fromId === node.id,
                  )
                  .map((f) => (
                    <li key={f.id}>
                      → {f.toName}: {f.materialName}{' '}
                      <span className="mono">
                        {f.volume.toLocaleString()}
                      </span>
                      {f.implied ? (
                        <em className="bom-gap"> gap</em>
                      ) : (
                        <span className="muted tiny"> via {f.laneId}</span>
                      )}
                    </li>
                  ))}
              </ul>
            </div>
          )}
          {isFacility && facility && (
            <div className="constraint-edit">
              <h3>Candidates &amp; constraints</h3>
              <label className="field">
                <span>Status</span>
                <select
                  value={facility.status}
                  onChange={(e) =>
                    updateFacilityConstraint(node.id, {
                      status: e.target.value as FacilityStatus,
                    })
                  }
                >
                  <option value="open">Open</option>
                  <option value="closed">Closed</option>
                  <option value="candidate">Candidate</option>
                </select>
              </label>
              <label className="field">
                <span>Capacity min</span>
                <input
                  type="number"
                  value={facility.capacityMin}
                  onChange={(e) =>
                    updateFacilityConstraint(node.id, {
                      capacityMin: Number(e.target.value),
                    })
                  }
                />
              </label>
              <label className="field">
                <span>Capacity max</span>
                <input
                  type="number"
                  value={facility.capacityMax}
                  onChange={(e) =>
                    updateFacilityConstraint(node.id, {
                      capacityMax: Number(e.target.value),
                    })
                  }
                />
              </label>
              <label className="field">
                <span>Open CapEx ($M)</span>
                <input
                  type="number"
                  value={facility.fixedCapexM}
                  onChange={(e) =>
                    updateFacilityConstraint(node.id, {
                      fixedCapexM: Number(e.target.value),
                    })
                  }
                />
              </label>
            </div>
          )}
        </>
      )}
      {lane && (
        <>
          <dl className="stub-fields">
            <div>
              <dt>Lane</dt>
              <dd className="mono">{lane.id}</dd>
            </div>
            <div>
              <dt>From</dt>
              <dd>{nodeById(lane.from)?.name ?? lane.from}</dd>
            </div>
            <div>
              <dt>To</dt>
              <dd>{nodeById(lane.to)?.name ?? lane.to}</dd>
            </div>
            <div>
              <dt>Cost / unit</dt>
              <dd>${lane.costPerUnit.toFixed(2)}</dd>
            </div>
            <div>
              <dt>Lead time</dt>
              <dd>{lane.leadDays}d</dd>
            </div>
            <div>
              <dt>CO₂</dt>
              <dd>{lane.co2Kg} kg/u</dd>
            </div>
            <div>
              <dt>Products</dt>
              <dd>{formatGroupCodes(productMix, laneGroupIds)}</dd>
            </div>
          </dl>
          <div className="constraint-edit product-edit">
            <h3>Lane product groups</h3>
            <div className="product-chip-row wrap">
              {productMix.groups.map((g) => {
                const on = laneGroupIds.includes(g.id)
                return (
                  <button
                    key={g.id}
                    type="button"
                    className={on ? 'product-chip on' : 'product-chip'}
                    style={{ ['--pg-color' as string]: g.color }}
                    onClick={() => toggleLaneGroup(g.id)}
                  >
                    <span className="product-chip-dot" aria-hidden />
                    {g.code}
                  </button>
                )
              })}
            </div>
            <p className="hint">Toggle which commodities this lane may carry.</p>
          </div>
          <div className="constraint-edit">
            <h3>Transport mode</h3>
            <label className="field">
              <span>Mode (road / rail / air / ocean)</span>
              <select
                value={normalizeMode(lane.mode)}
                onChange={(e) => updateLaneMode(lane.id, e.target.value)}
              >
                {TRANSPORT_MODES.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
            <p className="hint">
              Changing mode rescales cost via mode relatives and refreshes CO₂
              from planning emission factors.
            </p>
          </div>
          {rateTable && (
            <div className="constraint-edit rate-bid-edit">
              <h3>Carrier bids</h3>
              <label className="field">
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
              <p className="hint">
                {miles > 0 ? `${miles} mi · ` : ''}
                {strategyLabel(laneRates.compareStrategy)} ranks bids;
                Apply writes cost + transit onto this lane.
              </p>
              <ul className="bid-list">
                {rankedBids.map((row) => (
                  <li
                    key={row.bid.id}
                    className={
                      row.isWinner
                        ? 'bid-row winner'
                        : row.isSelected
                          ? 'bid-row selected'
                          : 'bid-row'
                    }
                  >
                    <div className="bid-row-head">
                      <strong>{row.bid.carrier}</strong>
                      <span className="bid-rank">#{row.rank}</span>
                      {row.isWinner && (
                        <span className="bid-badge">Winner</span>
                      )}
                      {row.isSelected && (
                        <span className="bid-badge applied">Applied</span>
                      )}
                    </div>
                    <div className="bid-meta mono">
                      {row.bid.mode} · ${row.effectiveCostPerUnit.toFixed(2)}/u
                      {row.bid.rateUnit === 'per_mile'
                        ? ` ($${row.bid.rate}/mi)`
                        : ''}{' '}
                      · {row.bid.transitDays}d · cap{' '}
                      {row.bid.capacityUnits.toLocaleString()}
                    </div>
                    <div className="bid-actions">
                      <button
                        type="button"
                        className="btn primary btn-tiny"
                        onClick={() => applyRateBid(lane.id, row.bid.id)}
                      >
                        Apply
                      </button>
                      <button
                        type="button"
                        className="btn ghost btn-tiny"
                        onClick={() => removeRateBid(lane.id, row.bid.id)}
                      >
                        Remove
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
              <div className="bid-toolbar">
                <button
                  type="button"
                  className="btn ghost btn-tiny"
                  onClick={() =>
                    addRateBid(lane.id, {
                      carrier: 'New carrier',
                      mode: normalizeMode(lane.mode),
                      rate: lane.costPerUnit,
                      rateUnit: 'per_unit' as RateUnit,
                      transitDays: lane.leadDays,
                      capacityUnits: 5000,
                    })
                  }
                >
                  Add bid
                </button>
                <button
                  type="button"
                  className="btn ghost btn-tiny"
                  onClick={() => applyWinningBids(undefined, lane.id)}
                >
                  Apply winner
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </aside>
  )
}

function ConstraintsPanel({
  constraints,
  nodes,
  onGlobals,
  onFacility,
}: {
  constraints: ReturnType<typeof useFlowform>['constraints']
  nodes: ReturnType<typeof useFlowform>['nodes']
  onGlobals: ReturnType<typeof useFlowform>['updateConstraintGlobals']
  onFacility: ReturnType<typeof useFlowform>['updateFacilityConstraint']
}) {
  return (
    <div className="constraint-panel">
      <h3>Network constraints</h3>
      <label className="field">
        <span>Service target % ({constraints.serviceTargetPct})</span>
        <input
          type="range"
          min={85}
          max={99}
          value={constraints.serviceTargetPct}
          onChange={(e) =>
            onGlobals({ serviceTargetPct: Number(e.target.value) })
          }
        />
      </label>
      <label className="field">
        <span>Service radius (mi)</span>
        <input
          type="number"
          value={constraints.serviceRadiusMiles}
          onChange={(e) =>
            onGlobals({ serviceRadiusMiles: Number(e.target.value) })
          }
        />
      </label>
      <label className="field">
        <span>CapEx budget ($M)</span>
        <input
          type="number"
          value={constraints.capexBudgetM}
          onChange={(e) =>
            onGlobals({ capexBudgetM: Number(e.target.value) })
          }
        />
      </label>
      <label className="field">
        <span>Max facilities</span>
        <input
          type="number"
          min={1}
          max={20}
          value={constraints.maxFacilities}
          onChange={(e) =>
            onGlobals({ maxFacilities: Number(e.target.value) })
          }
        />
      </label>
      <label className="field checkbox-field">
        <span>Hard service constraints</span>
        <input
          type="checkbox"
          checked={!!constraints.hardServiceConstraints}
          onChange={(e) =>
            onGlobals({ hardServiceConstraints: e.target.checked })
          }
        />
        <span className="muted tiny">
          Fail infeasible (no uncovered) vs soft penalty
        </span>
      </label>
      <label className="field">
        <span>Max lead-time (days, optional)</span>
        <input
          type="number"
          min={0}
          step={0.5}
          value={constraints.maxLeadTimeDays ?? ''}
          placeholder="—"
          onChange={(e) => {
            const v = e.target.value
            onGlobals({
              maxLeadTimeDays: v === '' ? undefined : Number(v),
            })
          }}
        />
      </label>
      <h3>Facilities</h3>
      <ul className="facility-status-list">
        {constraints.facilities.map((f) => {
          const n = nodes.find((x) => x.id === f.nodeId)
          return (
            <li key={f.nodeId}>
              <span className="fac-name">{n?.name ?? f.nodeId}</span>
              <select
                value={f.status}
                onChange={(e) =>
                  onFacility(f.nodeId, {
                    status: e.target.value as FacilityStatus,
                  })
                }
                aria-label={`Status for ${n?.name ?? f.nodeId}`}
              >
                <option value="open">Open</option>
                <option value="closed">Closed</option>
                <option value="candidate">Candidate</option>
              </select>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
