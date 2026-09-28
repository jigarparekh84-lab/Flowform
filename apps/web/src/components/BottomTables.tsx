import { useMemo, useState } from 'react'
import {
  demandSharesForNode,
  facilityCapFor,
  formatGroupCodes,
  laneGroups,
  laneMatchesProductFilter,
  nodeMatchesProductFilter,
} from '../data/productGroups'
import { kindLabel } from '../data/sampleNetwork'
import { useFlowform } from '../state/FlowformContext'
import { EmptyState } from './ui/EmptyState'

type Tab = 'facilities' | 'lanes'

type Props = {
  selectedIds: string[]
  selectedKind: 'node' | 'lane' | null
  onSelectNode: (id: string, additive?: boolean) => void
  onSelectLane: (id: string, additive?: boolean) => void
}

export function BottomTables({
  selectedIds,
  selectedKind,
  onSelectNode,
  onSelectLane,
}: Props) {
  const { nodes, lanes, nodeById, constraints, productMix } = useFlowform()
  const [tab, setTab] = useState<Tab>('facilities')
  const selectedSet = new Set(selectedIds)
  const statusById = new Map(
    constraints.facilities.map((f) => [f.nodeId, f.status]),
  )

  const visibleNodes = useMemo(
    () => nodes.filter((n) => nodeMatchesProductFilter(n, productMix)),
    [nodes, productMix],
  )
  const visibleLanes = useMemo(
    () =>
      lanes.filter(
        (l) =>
          laneMatchesProductFilter(l, productMix) &&
          nodeMatchesProductFilter(
            nodes.find((n) => n.id === l.from) ?? {
              id: l.from,
              name: l.from,
              kind: 'dc',
              region: '',
              capacity: '',
              x: 0,
              y: 0,
            },
            productMix,
          ),
      ),
    [lanes, nodes, productMix],
  )

  return (
    <div className="bottom-tables">
      <div className="table-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'facilities'}
          className={tab === 'facilities' ? 'active' : ''}
          onClick={() => setTab('facilities')}
        >
          Facilities
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'lanes'}
          className={tab === 'lanes' ? 'active' : ''}
          onClick={() => setTab('lanes')}
        >
          Lanes
        </button>
        {productMix.filterGroupId && (
          <span className="table-filter-hint">
            Filtered ·{' '}
            {productMix.groups.find((g) => g.id === productMix.filterGroupId)
              ?.code ?? 'group'}
          </span>
        )}
      </div>

      <div className="table-scroll">
        {tab === 'facilities' ? (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Status</th>
                <th>Region</th>
                <th>Capacity</th>
                <th>Products</th>
              </tr>
            </thead>
            <tbody>
              {visibleNodes.length === 0 ? (
                <tr>
                  <td colSpan={6} className="empty-cell">
                    <EmptyState
                      compact
                      title="No facilities"
                      body="Nothing matches the current product filter — clear the filter or load data in Data."
                    />
                  </td>
                </tr>
              ) : null}
              {visibleNodes.map((n) => {
                const selected =
                  selectedKind === 'node' && selectedSet.has(n.id)
                const status = statusById.get(n.id)
                let products = '—'
                if (n.kind === 'demand') {
                  const shares = demandSharesForNode(productMix, n.id)
                  products = productMix.groups
                    .filter((g) => (shares[g.id] ?? 0) > 0)
                    .map((g) => `${g.code} ${shares[g.id]}%`)
                    .join(' · ')
                } else {
                  const cap = facilityCapFor(productMix, n.id)
                  if (cap) {
                    products = formatGroupCodes(productMix, cap.capableGroupIds)
                  }
                }
                return (
                  <tr
                    key={n.id}
                    className={selected ? 'selected' : ''}
                    onClick={(e) => onSelectNode(n.id, e.shiftKey)}
                  >
                    <td>{n.name}</td>
                    <td>{kindLabel(n.kind)}</td>
                    <td>{status ?? '—'}</td>
                    <td>{n.region}</td>
                    <td>{n.capacity}</td>
                    <td className="tiny">{products}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        ) : (
          <table>
            <thead>
              <tr>
                <th>From</th>
                <th>To</th>
                <th>Mode</th>
                <th>Cost/u</th>
                <th>Lead</th>
                <th>CO₂</th>
                <th>Products</th>
              </tr>
            </thead>
            <tbody>
              {visibleLanes.length === 0 ? (
                <tr>
                  <td colSpan={7} className="empty-cell">
                    <EmptyState
                      compact
                      title="No lanes"
                      body="Nothing matches the current product filter — clear the filter or load lanes in Data."
                    />
                  </td>
                </tr>
              ) : null}
              {visibleLanes.map((l) => {
                const selected =
                  selectedKind === 'lane' && selectedSet.has(l.id)
                return (
                  <tr
                    key={l.id}
                    className={selected ? 'selected' : ''}
                    onClick={(e) => onSelectLane(l.id, e.shiftKey)}
                  >
                    <td>{nodeById(l.from)?.name ?? l.from}</td>
                    <td>{nodeById(l.to)?.name ?? l.to}</td>
                    <td>{l.mode}</td>
                    <td>${l.costPerUnit.toFixed(2)}</td>
                    <td>{l.leadDays}d</td>
                    <td>{l.co2Kg} kg</td>
                    <td className="tiny">
                      {formatGroupCodes(productMix, laneGroups(productMix, l.id))}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
