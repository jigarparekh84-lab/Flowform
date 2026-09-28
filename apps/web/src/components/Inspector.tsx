import {
  LANES,
  NODES,
  kindLabel,
  nodeById,
  type NetworkLane,
  type NetworkNode,
} from '../data/sampleNetwork'

type Props = {
  selectedId: string | null
  selectedKind: 'node' | 'lane' | null
}

export function Inspector({ selectedId, selectedKind }: Props) {
  let node: NetworkNode | undefined
  let lane: NetworkLane | undefined

  if (selectedKind === 'node' && selectedId) {
    node = NODES.find((n) => n.id === selectedId)
  }
  if (selectedKind === 'lane' && selectedId) {
    lane = LANES.find((l) => l.id === selectedId)
  }

  return (
    <aside className="inspector" aria-label="Inspector">
      <h2>Inspector</h2>
      {!node && !lane && (
        <p className="hint">Select a node or lane on the canvas.</p>
      )}
      {node && (
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
      )}
      {lane && (
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
            <dt>Mode</dt>
            <dd>{lane.mode}</dd>
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
        </dl>
      )}
    </aside>
  )
}
