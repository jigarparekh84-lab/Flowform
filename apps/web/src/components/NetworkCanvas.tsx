import { useState } from 'react'
import { LAYERS } from '../data/sampleNetwork'
import { useFlowform } from '../state/FlowformContext'
import { BottomTables } from './BottomTables'
import { Inspector } from './Inspector'
import { KpiStrip } from './KpiStrip'
import { LayerRail } from './LayerRail'
import { NetworkMap } from './NetworkMap'
import { ScenarioFooter } from './ScenarioFooter'
import { EmptyState } from './ui/EmptyState'

function initialLayers(): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const layer of LAYERS) {
    out[layer.id] = layer.defaultOn
  }
  return out
}

export function NetworkCanvas() {
  const {
    activeScenario,
    scenarios,
    activeScenarioId,
    setActiveScenarioId,
    selection,
    selectEntity,
    clearSelection,
    nodes,
  } = useFlowform()

  const [layers, setLayers] = useState(initialLayers)

  function toggleLayer(id: string) {
    setLayers((prev) => ({ ...prev, [id]: !prev[id] }))
  }

  if (nodes.length === 0) {
    return (
      <div className="network-canvas network-empty-wrap">
        <p className="room-tip network-room-tip" role="note">
          <span className="room-tip-label" aria-hidden>
            Tip
          </span>
          Design and inspect the active footprint — sites, lanes, and KPIs on
          one canvas.
        </p>
        <EmptyState
          title="No network loaded"
          body="Upload sites, demand, and lanes in Data, or restore the built-in sample network to start designing."
          action={
            <p className="muted tiny" style={{ margin: 0 }}>
              Esc clears selection · ? for shortcuts
            </p>
          }
        />
        <ScenarioFooter
          scenarios={scenarios}
          activeId={activeScenarioId}
          onSelect={setActiveScenarioId}
        />
      </div>
    )
  }

  return (
    <div className="network-canvas">
      <p className="room-tip network-room-tip" role="note">
        <span className="room-tip-label" aria-hidden>
          Tip
        </span>
        Design and inspect the active footprint — sites, lanes, and KPIs on one
        canvas. Esc clears selection.
      </p>
      <KpiStrip kpis={activeScenario.kpis} />
      <div className="canvas-body">
        <LayerRail layers={layers} onToggle={toggleLayer} />
        <div className="canvas-center">
          <NetworkMap
            layers={layers}
            selectedIds={selection.ids}
            onSelect={selectEntity}
            onClear={clearSelection}
          />
          <BottomTables
            selectedIds={selection.ids}
            selectedKind={selection.kind}
            onSelectNode={(id, additive) => selectEntity(id, 'node', additive)}
            onSelectLane={(id, additive) => selectEntity(id, 'lane', additive)}
          />
        </div>
        <Inspector
          selectedIds={selection.ids}
          selectedKind={selection.kind}
        />
      </div>
      <ScenarioFooter
        scenarios={scenarios}
        activeId={activeScenarioId}
        onSelect={setActiveScenarioId}
      />
    </div>
  )
}
