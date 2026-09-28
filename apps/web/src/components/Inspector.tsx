import {
  LANES,
  NODES,
  kindLabel,
  nodeById,
  type NetworkLane,
  type NetworkNode,
} from '../data/sampleNetwork'

type Props = {
  selectedIds: string[]
  selectedKind: 'node' | 'lane' | null
}

export function Inspector({ selectedIds, selectedKind }: Props) {
  const primaryId = selectedIds[selectedIds.length - 1] ?? null
  let node: NetworkNode | undefined
  let lane: NetworkLane | undefined

  if (selectedKind === 'node' && primaryId) {
    node = NODES.find((n) => n.id === primaryId)
  }
  if (selectedKind === 'lane' && primaryId) {
    lane = LANES.find((l) => l.id === primaryId)
  }

  const multi = selectedIds.length > 1

  return (
    <aside className="inspector" aria-label="Inspector">
      <h2>Inspector</h2>
      {!node && !lane && (
        <p className="hint">
          Select a node or lane on the canvas. Shift-click to multi-select.
        </p>
      )}
      {multi && (
        <p className="selection-badge">
          {selectedIds.length} {selectedKind}
          {selectedIds.length === 1 ? '' : 's'} selected
        </p>
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
