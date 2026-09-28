import { kindLabel, type FacilityStatus } from '../data/sampleNetwork'
import { useFlowform } from '../state/FlowformContext'

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

  return (
    <aside className="inspector" aria-label="Inspector">
      <h2>Inspector</h2>
      {!node && !lane && (
        <>
          <p className="hint">
            Select a node or lane on the canvas. Shift-click to multi-select.
          </p>
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
