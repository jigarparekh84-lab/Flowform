import { useMemo, useState } from 'react'
import { LAYERS, SCENARIOS } from '../data/sampleNetwork'
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

type Props = {
  activeScenarioId: string
  onScenarioChange: (id: string) => void
}

export function NetworkCanvas({ activeScenarioId, onScenarioChange }: Props) {
  const [layers, setLayers] = useState(initialLayers)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedKind, setSelectedKind] = useState<'node' | 'lane' | null>(null)

  const scenario = useMemo(
    () => SCENARIOS.find((s) => s.id === activeScenarioId) ?? SCENARIOS[0],
    [activeScenarioId],
  )

  function toggleLayer(id: string) {
    setLayers((prev) => ({ ...prev, [id]: !prev[id] }))
  }

  function selectNode(id: string) {
    setSelectedId(id)
    setSelectedKind('node')
  }

  function selectLane(id: string) {
    setSelectedId(id)
    setSelectedKind('lane')
  }

  function onMapSelect(id: string, kind: 'node' | 'lane') {
    setSelectedId(id)
    setSelectedKind(kind)
  }

  return (
    <div className="network-canvas">
      <KpiStrip kpis={scenario.kpis} />
      <div className="canvas-body">
        <LayerRail layers={layers} onToggle={toggleLayer} />
        <div className="canvas-center">
          <NetworkMap
            layers={layers}
            selectedId={selectedId}
            onSelect={onMapSelect}
          />
          <BottomTables
            selectedId={selectedId}
            onSelectNode={selectNode}
            onSelectLane={selectLane}
          />
        </div>
        <Inspector selectedId={selectedId} selectedKind={selectedKind} />
      </div>
      <ScenarioFooter
        scenarios={SCENARIOS}
        activeId={scenario.id}
        onSelect={onScenarioChange}
      />
    </div>
  )
}
