import {
  LANES,
  NODES,
  kindLabel,
  type NetworkLane,
  type NetworkNode,
  type NodeKind,
} from '../data/sampleNetwork'

type Props = {
  layers: Record<string, boolean>
  selectedIds: string[]
  onSelect: (id: string, kind: 'node' | 'lane', additive: boolean) => void
  onClear?: () => void
}

const KIND_LAYER: Record<NodeKind, string> = {
  plant: 'plants',
  dc: 'dcs',
  demand: 'demand',
  supplier: 'suppliers',
  candidate: 'candidates',
}

function colorFor(kind: NodeKind): string {
  switch (kind) {
    case 'plant':
      return '#34d399'
    case 'dc':
      return '#38bdf8'
    case 'demand':
      return '#fbbf24'
    case 'supplier':
      return '#a78bfa'
    case 'candidate':
      return '#fb7185'
  }
}

function bezierPath(a: NetworkNode, b: NetworkNode): string {
  const x1 = a.x
  const y1 = a.y
  const x2 = b.x
  const y2 = b.y
  const mx = (x1 + x2) / 2
  const my = (y1 + y2) / 2
  const dx = x2 - x1
  const dy = y2 - y1
  const cx = mx - dy * 0.18
  const cy = my + dx * 0.18
  return `M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`
}

function visibleNode(n: NetworkNode, layers: Record<string, boolean>): boolean {
  return !!layers[KIND_LAYER[n.kind]]
}

export function NetworkMap({ layers, selectedIds, onSelect, onClear }: Props) {
  const nodeMap = new Map(NODES.map((n) => [n.id, n]))
  const selectedSet = new Set(selectedIds)

  const visibleLanes = layers.lanes
    ? LANES.filter((l) => {
        const a = nodeMap.get(l.from)
        const b = nodeMap.get(l.to)
        return a && b && visibleNode(a, layers) && visibleNode(b, layers)
      })
    : []

  return (
    <div className="map-stage">
      <svg
        className="network-svg"
        viewBox="0 0 100 100"
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label="Network map with sample nodes and lanes"
        onClick={() => onClear?.()}
      >
        <defs>
          <radialGradient id="mapGlow" cx="50%" cy="45%" r="55%">
            <stop offset="0%" stopColor="#12203a" />
            <stop offset="100%" stopColor="#060b14" />
          </radialGradient>
          <pattern id="grid" width="5" height="5" patternUnits="userSpaceOnUse">
            <path
              d="M 5 0 L 0 0 0 5"
              fill="none"
              stroke="rgba(56,189,248,0.07)"
              strokeWidth="0.15"
            />
          </pattern>
          <filter id="softGlow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="0.6" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        <rect width="100" height="100" fill="url(#mapGlow)" />
        <rect width="100" height="100" fill="url(#grid)" />

        <path
          d="M12 40 C18 28, 30 24, 42 26 C52 22, 62 24, 72 30 C82 28, 90 34, 92 44 C94 55, 88 66, 78 70 C68 78, 52 80, 40 74 C28 78, 18 70, 14 58 Z"
          fill="rgba(30,58,95,0.35)"
          stroke="rgba(56,189,248,0.12)"
          strokeWidth="0.3"
        />

        {visibleLanes.map((lane: NetworkLane) => {
          const a = nodeMap.get(lane.from)!
          const b = nodeMap.get(lane.to)!
          const selected = selectedSet.has(lane.id)
          return (
            <path
              key={lane.id}
              d={bezierPath(a, b)}
              fill="none"
              stroke={selected ? '#7dd3fc' : 'rgba(125,211,252,0.45)'}
              strokeWidth={selected ? 0.55 : 0.35}
              strokeLinecap="round"
              className="lane-arc"
              onClick={(e) => {
                e.stopPropagation()
                onSelect(lane.id, 'lane', e.shiftKey)
              }}
            />
          )
        })}

        {NODES.filter((n) => visibleNode(n, layers)).map((node) => {
          const selected = selectedSet.has(node.id)
          const fill = colorFor(node.kind)
          return (
            <g
              key={node.id}
              className={`map-node${selected ? ' is-selected' : ''}`}
              transform={`translate(${node.x} ${node.y})`}
              onClick={(e) => {
                e.stopPropagation()
                onSelect(node.id, 'node', e.shiftKey)
              }}
              filter={selected ? 'url(#softGlow)' : undefined}
            >
              {selected && (
                <circle
                  r="3.2"
                  fill="none"
                  stroke="#7dd3fc"
                  strokeWidth="0.35"
                  opacity="0.85"
                />
              )}
              <circle
                r={selected ? 2.4 : 1.9}
                fill="#0b1220"
                stroke={fill}
                strokeWidth={selected ? 0.55 : 0.4}
              />
              <circle r="0.7" fill={fill} />
              <text
                y="3.8"
                textAnchor="middle"
                className="node-label"
                fill="#cbd5e1"
                fontSize="2.1"
              >
                {node.name.split(' ')[0]}
              </text>
              <title>
                {node.name} · {kindLabel(node.kind)}
              </title>
            </g>
          )
        })}
      </svg>
      <div className="map-legend" aria-hidden>
        <span>
          <i className="dot plant" /> Plant
        </span>
        <span>
          <i className="dot dc" /> DC
        </span>
        <span>
          <i className="dot demand" /> Demand
        </span>
        <span>
          <i className="dot supplier" /> Supplier
        </span>
      </div>
      <p className="map-hint">Click to select · Shift-click to multi-select</p>
    </div>
  )
}
