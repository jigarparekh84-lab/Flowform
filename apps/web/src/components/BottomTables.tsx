import { useState } from 'react'
import { kindLabel } from '../data/sampleNetwork'
import { useFlowform } from '../state/FlowformContext'

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
  const { nodes, lanes, nodeById, constraints } = useFlowform()
  const [tab, setTab] = useState<Tab>('facilities')
  const selectedSet = new Set(selectedIds)
  const statusById = new Map(
    constraints.facilities.map((f) => [f.nodeId, f.status]),
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
              </tr>
            </thead>
            <tbody>
              {nodes.map((n) => {
                const selected =
                  selectedKind === 'node' && selectedSet.has(n.id)
                const status = statusById.get(n.id)
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
              </tr>
            </thead>
            <tbody>
              {lanes.map((l) => {
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
