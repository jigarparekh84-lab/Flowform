import { useState } from 'react'
import { LAYERS } from '../data/sampleNetwork'
import { useFlowform } from '../state/FlowformContext'
import { BottomTables } from './BottomTables'
import { Inspector } from './Inspector'
import { KpiStrip } from './KpiStrip'
import { LayerRail } from './LayerRail'
import { NetworkMap } from './NetworkMap'
import { ScenarioFooter } from './ScenarioFooter'

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
  } = useFlowform()

  const [layers, setLayers] = useState(initialLayers)

  function toggleLayer(id: string) {
    setLayers((prev) => ({ ...prev, [id]: !prev[id] }))
  }

  return (
    <div className="network-canvas">
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
