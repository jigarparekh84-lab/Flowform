import type { LaneShortfallRow, MinThroughputShortfallRow } from '../data/validation'

const fmt = (n: number | undefined) => (n == null ? '—' : n.toLocaleString(undefined, { maximumFractionDigits: 0 }))

/** FF-108: MIN_THROUGHPUT_CONFLICT / LANE_CAPACITY_CONFLICT shortfall tables. */
export function ShortfallTables({
  laneCapacity,
  minThroughput,
  nameOf = (id) => id,
}: {
  laneCapacity: LaneShortfallRow[]
  minThroughput: MinThroughputShortfallRow[]
  nameOf?: (id: string) => string
}) {
  if (!laneCapacity.length && !minThroughput.length) return null
  return (
    <div className="shortfall-tables">
      {minThroughput.length > 0 && (
        <table className="compare-matrix" aria-label="Minimum throughput shortfalls">
          <caption className="muted tiny">Sites that cannot reach their minimum throughput</caption>
          <thead>
            <tr><th scope="col">Site</th><th scope="col">Min throughput</th><th scope="col">Achievable</th><th scope="col">Short by</th></tr>
          </thead>
          <tbody>
            {minThroughput.map((r) => (
              <tr key={r.facilityId}>
                <td>{nameOf(r.facilityId)}</td><td>{fmt(r.capacityMin)}</td><td>{fmt(r.feasibleThroughput)}</td><td>{fmt(r.gap)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {laneCapacity.length > 0 && (
        <table className="compare-matrix" aria-label="Lane capacity shortfalls">
          <caption className="muted tiny">Lanes too small for the flow they must carry</caption>
          <thead>
            <tr><th scope="col">Lane / customer</th><th scope="col">Capacity</th><th scope="col">Needed</th><th scope="col">Short by</th></tr>
          </thead>
          <tbody>
            {laneCapacity.map((r, i) => (
              <tr key={`${r.laneId ?? r.customerId}-${i}`}>
                <td>
                  {r.laneId
                    ? `${r.laneId} (${nameOf(r.from ?? '')} → ${nameOf(r.to ?? '')})`
                    : `${r.name ?? nameOf(r.customerId ?? '')} via ${(r.laneIds ?? []).join(', ')}`}
                </td>
                <td>{fmt(r.capacityUnits ?? r.inboundLaneCapacity)}</td>
                <td>{fmt(r.requiredFlow ?? r.demand)}</td>
                <td>{fmt(r.shortBy)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
