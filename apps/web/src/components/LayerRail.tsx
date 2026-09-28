import { LAYERS } from '../data/sampleNetwork'

type Props = {
  layers: Record<string, boolean>
  onToggle: (id: string) => void
}

export function LayerRail({ layers, onToggle }: Props) {
  return (
    <aside className="layer-rail" aria-label="Map layers">
      <h2>Layers</h2>
      <ul>
        {LAYERS.map((layer) => (
          <li key={layer.id}>
            <label className="layer-row">
              <input
                type="checkbox"
                checked={!!layers[layer.id]}
                onChange={() => onToggle(layer.id)}
              />
              <span>{layer.label}</span>
            </label>
          </li>
        ))}
      </ul>
    </aside>
  )
}
