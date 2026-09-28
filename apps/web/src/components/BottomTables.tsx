import { useState } from 'react'
import {
  LANES,
  NODES,
  kindLabel,
  nodeById,
} from '../data/sampleNetwork'

type Tab = 'facilities' | 'lanes'

type Props = {
  selectedId: string | null
  onSelectNode: (id: string) => void
  onSelectLane: (id: string) => void
}

export function BottomTables({ selectedId, onSelectNode, onSelectLane }: Props) {
  const [tab, setTab] = useState<Tab>('facilities')

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
                <th>Region</th>
                <th>Capacity</th>
              </tr>
            </thead>
            <tbody>
              {NODES.map((n) => (
                <tr
                  key={n.id}
                  className={selectedId === n.id ? 'selected' : ''}
                  onClick={() => onSelectNode(n.id)}
                >
                  <td>{n.name}</td>
                  <td>{kindLabel(n.kind)}</td>
                  <td>{n.region}</td>
                  <td>{n.capacity}</td>
                </tr>
              ))}
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
              {LANES.map((l) => (
                <tr
                  key={l.id}
                  className={selectedId === l.id ? 'selected' : ''}
                  onClick={() => onSelectLane(l.id)}
                >
                  <td>{nodeById(l.from)?.name ?? l.from}</td>
                  <td>{nodeById(l.to)?.name ?? l.to}</td>
                  <td>{l.mode}</td>
                  <td>${l.costPerUnit.toFixed(2)}</td>
                  <td>{l.leadDays}d</td>
                  <td>{l.co2Kg} kg</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
