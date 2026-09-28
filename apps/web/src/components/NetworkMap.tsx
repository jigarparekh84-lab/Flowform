import { useEffect, useRef, useState } from 'react'
import * as maplibregl from 'maplibre-gl'
import type {
  GeoJSONSource,
  Map as MapLibreMap,
  StyleSpecification,
} from 'maplibre-gl'
import type { FeatureCollection } from 'geojson'
import 'maplibre-gl/dist/maplibre-gl.css'
import { computeCapacityUtilization } from '../data/capacityHeat'
import { computeTerritoryColors } from '../data/serviceTerritory'
import { basemapProvider, mapBasemapStyle, nodeLatLng } from '../data/geo'
import {
  kindLabel,
  type NetworkLane,
  type NetworkNode,
  type NodeKind,
} from '../data/sampleNetwork'
import {
  laneMatchesProductFilter,
  nodeMatchesProductFilter,
  type ProductMixState,
} from '../data/productGroups'
import { bomDrivenLaneIds } from '../data/bom'
import { useFlowform } from '../state/FlowformContext'
import { useTheme } from '../state/theme'

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

const KIND_COLOR: Record<NodeKind, string> = {
  plant: '#34d399',
  dc: '#38bdf8',
  demand: '#fbbf24',
  supplier: '#a78bfa',
  candidate: '#fb7185',
}

function visibleNode(n: NetworkNode, layers: Record<string, boolean>): boolean {
  return !!layers[KIND_LAYER[n.kind]]
}

function colorFor(kind: NodeKind): string {
  return KIND_COLOR[kind]
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

type MapMode = 'maplibre' | 'svg'

export function NetworkMap({ layers, selectedIds, onSelect, onClear }: Props) {
  const [mode, setMode] = useState<MapMode>('maplibre')
  const [mapError, setMapError] = useState<string | null>(null)

  return (
    <div className="map-stage">
      {mode === 'maplibre' ? (
        <MapLibreCanvas
          layers={layers}
          selectedIds={selectedIds}
          onSelect={onSelect}
          onClear={onClear}
          onFail={(reason) => {
            setMapError(reason)
            setMode('svg')
          }}
        />
      ) : (
        <SvgNetworkMap
          layers={layers}
          selectedIds={selectedIds}
          onSelect={onSelect}
          onClear={onClear}
        />
      )}
      <div className="map-legend" aria-hidden>
        {layers.territory ? (
          <>
            <span>
              <i className="dot dc" /> Territory color
            </span>
            <span>
              <i className="dot util-high" /> Gap
            </span>
            <span>
              <i className="dot demand" /> Demand by server
            </span>
          </>
        ) : layers.utilization ? (
          <>
            <span>
              <i className="dot util-low" /> Low util
            </span>
            <span>
              <i className="dot util-mid" /> Mid
            </span>
            <span>
              <i className="dot util-high" /> High / over
            </span>
            <span>
              <i className="dot demand" /> Demand
            </span>
          </>
        ) : (
          <>
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
          </>
        )}
      </div>
      <div className="map-chrome-bar">
        <p className="map-hint">
          {mode === 'maplibre'
            ? `MapLibre · ${basemapProvider() === 'carto' ? 'Carto' : 'OpenFreeMap'} · `
            : 'SVG fallback · '}
          Click to select · Shift multi-select
          {mapError ? ` · tiles failed (${mapError})` : ''}
        </p>
        <div className="map-mode-toggle">
          <button
            type="button"
            className={mode === 'maplibre' ? 'btn ghost btn-tiny on' : 'btn ghost btn-tiny'}
            onClick={() => {
              setMapError(null)
              setMode('maplibre')
            }}
            title="MapLibre GL basemap"
          >
            Tiles
          </button>
          <button
            type="button"
            className={mode === 'svg' ? 'btn ghost btn-tiny on' : 'btn ghost btn-tiny'}
            onClick={() => setMode('svg')}
            title="SVG schematic fallback"
          >
            SVG
          </button>
        </div>
      </div>
    </div>
  )
}

function MapLibreCanvas({
  layers,
  selectedIds,
  onSelect,
  onClear,
  onFail,
}: Props & { onFail: (reason: string) => void }) {
  const { nodes, lanes, network, constraints, productMix, bom } = useFlowform()
  const { theme } = useTheme()
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const failedRef = useRef(false)
  const onSelectRef = useRef(onSelect)
  const onClearRef = useRef(onClear)
  onSelectRef.current = onSelect
  onClearRef.current = onClear

  // Init map once
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return
    failedRef.current = false

    let map: MapLibreMap
    try {
      map = new maplibregl.Map({
        container: containerRef.current,
        style: mapBasemapStyle(theme) as string | StyleSpecification,
        center: [-95, 37],
        zoom: 3.4,
        attributionControl: { compact: true },
      })
    } catch (err) {
      onFail(err instanceof Error ? err.message : 'init failed')
      return
    }

    mapRef.current = map
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')

    const failTimer = window.setTimeout(() => {
      // If style never loads, fall back
      if (!map.isStyleLoaded() && !failedRef.current) {
        failedRef.current = true
        map.remove()
        mapRef.current = null
        onFail('style timeout')
      }
    }, 8000)

    map.on('error', (e) => {
      const msg = e.error?.message ?? 'tile error'
      // Ignore benign tile 404 noise; only fail hard on style issues
      if (!failedRef.current && /style|Failed to fetch|NetworkError/i.test(msg)) {
        failedRef.current = true
        window.clearTimeout(failTimer)
        try {
          map.remove()
        } catch {
          /* ignore */
        }
        mapRef.current = null
        onFail(msg.slice(0, 80))
      }
    })

    map.on('load', () => {
      window.clearTimeout(failTimer)
    })

    map.on('click', (e) => {
      const feats = map.queryRenderedFeatures(e.point, {
        layers: ['ff-nodes-circle', 'ff-lanes-line'].filter((id) =>
          map.getLayer(id),
        ),
      })
      if (feats.length === 0) {
        onClearRef.current?.()
        return
      }
      const f = feats[0]
      const id = String(f.properties?.id ?? '')
      const kind = f.properties?.entityKind as 'node' | 'lane' | undefined
      if (!id || !kind) return
      const additive = !!(e.originalEvent as MouseEvent)?.shiftKey
      onSelectRef.current(id, kind, additive)
    })

    return () => {
      window.clearTimeout(failTimer)
      try {
        map.remove()
      } catch {
        /* ignore */
      }
      mapRef.current = null
    }
    // theme handled separately via setStyle
  }, [])

  // Theme swap
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    map.setStyle(mapBasemapStyle(theme) as string | StyleSpecification)
  }, [theme])

  // Sync geojson after style loads / data changes
  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    const apply = () => {
      if (!map.isStyleLoaded()) return
      const utilById = layers.utilization
        ? computeCapacityUtilization(network, constraints)
        : null
      const territoryById = layers.territory
        ? computeTerritoryColors(network).colorByNode
        : null
      const bomLaneIds = bomDrivenLaneIds(bom, network)
      syncNetworkLayers(map, {
        nodes,
        lanes,
        layers,
        selectedIds,
        statusById: new Map(
          constraints.facilities.map((f) => [f.nodeId, f.status]),
        ),
        source: network.source,
        utilById,
        territoryById,
        productMix,
        bomLaneIds,
      })
    }

    if (map.isStyleLoaded()) {
      apply()
    } else {
      map.once('styledata', apply)
      map.once('load', apply)
    }
  }, [nodes, lanes, layers, selectedIds, constraints, network, theme, productMix, bom])

  return <div ref={containerRef} className="maplibre-root" role="img" aria-label="Network map" />
}

function syncNetworkLayers(
  map: MapLibreMap,
  args: {
    nodes: NetworkNode[]
    lanes: NetworkLane[]
    layers: Record<string, boolean>
    selectedIds: string[]
    statusById: Map<string, string>
    source: string
    utilById?: Map<string, { color: string; label: string }> | null
    territoryById?: Map<string, { color: string; label: string }> | null
    productMix: ProductMixState
    bomLaneIds: Set<string>
  },
) {
  const { nodes, lanes, layers, selectedIds, statusById, utilById, territoryById, productMix, bomLaneIds } = args
  const selectedSet = new Set(selectedIds)
  const nodeMap = new Map(nodes.map((n) => [n.id, n]))

  const visibleNodes = nodes.filter(
    (n) => visibleNode(n, layers) && nodeMatchesProductFilter(n, productMix),
  )
  const visibleLanes = layers.lanes
    ? lanes.filter((l) => {
        const a = nodeMap.get(l.from)
        const b = nodeMap.get(l.to)
        return (
          a &&
          b &&
          visibleNode(a, layers) &&
          visibleNode(b, layers) &&
          laneMatchesProductFilter(l, productMix) &&
          nodeMatchesProductFilter(a, productMix) &&
          nodeMatchesProductFilter(b, productMix)
        )
      })
    : []

  const laneFc: FeatureCollection = {
    type: 'FeatureCollection',
    features: visibleLanes.map((lane) => {
      const a = nodeMap.get(lane.from)!
      const b = nodeMap.get(lane.to)!
      const la = nodeLatLng(a)
      const lb = nodeLatLng(b)
      return {
        type: 'Feature',
        properties: {
          id: lane.id,
          entityKind: 'lane',
          selected: selectedSet.has(lane.id) ? 1 : 0,
          bom: bomLaneIds.has(lane.id) ? 1 : 0,
          mode: lane.mode,
        },
        geometry: {
          type: 'LineString',
          coordinates: [
            [la.lng, la.lat],
            [lb.lng, lb.lat],
          ],
        },
      }
    }),
  }

  const nodeFc: FeatureCollection = {
    type: 'FeatureCollection',
    features: visibleNodes.map((node) => {
      const ll = nodeLatLng(node)
      const status = statusById.get(node.id) ?? 'open'
      const util = utilById?.get(node.id)
      const terr = territoryById?.get(node.id)
      const terrOn = !!layers.territory && !!terr
      const heatOn = !terrOn && !!layers.utilization && !!util
      const isFacility =
        node.kind === 'dc' || node.kind === 'plant' || node.kind === 'candidate'
      const color = terrOn
        ? terr.color
        : heatOn && isFacility
          ? util.color
          : colorFor(node.kind)
      const name = terrOn
        ? terr.label
        : heatOn && isFacility
          ? `${node.name} · ${util.label}`
          : node.name
      return {
        type: 'Feature',
        properties: {
          id: node.id,
          entityKind: 'node',
          name,
          kind: node.kind,
          color,
          selected: selectedSet.has(node.id) ? 1 : 0,
          closed: status === 'closed' ? 1 : 0,
          candidate: status === 'candidate' || node.kind === 'candidate' ? 1 : 0,
        },
        geometry: {
          type: 'Point',
          coordinates: [ll.lng, ll.lat],
        },
      }
    }),
  }

  const ensureSource = (id: string, data: FeatureCollection) => {
    const existing = map.getSource(id) as GeoJSONSource | undefined
    if (existing) {
      existing.setData(data)
    } else {
      map.addSource(id, { type: 'geojson', data })
    }
  }

  ensureSource('ff-lanes', laneFc)
  ensureSource('ff-nodes', nodeFc)

  if (!map.getLayer('ff-lanes-line')) {
    map.addLayer({
      id: 'ff-lanes-line',
      type: 'line',
      source: 'ff-lanes',
      paint: {
        'line-color': [
          'case',
          ['==', ['get', 'selected'], 1],
          '#7dd3fc',
          ['==', ['get', 'bom'], 1],
          '#c084fc',
          '#64748b',
        ],
        'line-width': [
          'case',
          ['==', ['get', 'selected'], 1],
          3.5,
          ['==', ['get', 'bom'], 1],
          2.8,
          2,
        ],
        'line-opacity': 0.85,
      },
      layout: {
        'line-cap': 'round',
        'line-join': 'round',
      },
    })
  }

  if (map.getLayer('ff-lanes-line')) {
    map.setPaintProperty('ff-lanes-line', 'line-color', [
      'case',
      ['==', ['get', 'selected'], 1],
      '#7dd3fc',
      ['==', ['get', 'bom'], 1],
      '#c084fc',
      '#64748b',
    ])
    map.setPaintProperty('ff-lanes-line', 'line-width', [
      'case',
      ['==', ['get', 'selected'], 1],
      3.5,
      ['==', ['get', 'bom'], 1],
      2.8,
      2,
    ])
  }

  if (!map.getLayer('ff-nodes-halo')) {
    map.addLayer({
      id: 'ff-nodes-halo',
      type: 'circle',
      source: 'ff-nodes',
      paint: {
        'circle-radius': [
          'case',
          ['==', ['get', 'selected'], 1],
          14,
          0,
        ],
        'circle-color': '#7dd3fc',
        'circle-opacity': 0.35,
      },
    })
  }

  if (!map.getLayer('ff-nodes-circle')) {
    map.addLayer({
      id: 'ff-nodes-circle',
      type: 'circle',
      source: 'ff-nodes',
      paint: {
        'circle-radius': [
          'case',
          ['==', ['get', 'selected'], 1],
          9,
          7,
        ],
        'circle-color': ['get', 'color'],
        'circle-stroke-width': 2,
        'circle-stroke-color': '#0f172a',
        'circle-opacity': [
          'case',
          ['==', ['get', 'closed'], 1],
          0.35,
          0.95,
        ],
      },
    })
  }

  if (!map.getLayer('ff-nodes-label')) {
    map.addLayer({
      id: 'ff-nodes-label',
      type: 'symbol',
      source: 'ff-nodes',
      layout: {
        'text-field': ['get', 'name'],
        'text-size': 11,
        'text-offset': [0, 1.4],
        'text-anchor': 'top',
        'text-max-width': 10,
      },
      paint: {
        'text-color': '#e2e8f0',
        'text-halo-color': '#0f172a',
        'text-halo-width': 1.2,
      },
    })
  }

  // Fit bounds once when we have nodes
  if (visibleNodes.length > 0 && !(map as unknown as { __ffFitted?: boolean }).__ffFitted) {
    const bounds = new maplibregl.LngLatBounds()
    for (const n of visibleNodes) {
      const ll = nodeLatLng(n)
      bounds.extend([ll.lng, ll.lat])
    }
    if (!bounds.isEmpty()) {
      map.fitBounds(bounds, { padding: 56, maxZoom: 5.5, duration: 0 })
      ;(map as unknown as { __ffFitted?: boolean }).__ffFitted = true
    }
  }
}

function SvgNetworkMap({ layers, selectedIds, onSelect, onClear }: Props) {
  const { nodes, lanes, network, constraints, productMix, bom } = useFlowform()
  const nodeMap = new Map(nodes.map((n) => [n.id, n]))
  const selectedSet = new Set(selectedIds)
  const statusById = new Map(
    constraints.facilities.map((f) => [f.nodeId, f.status]),
  )
  const utilById = layers.utilization
    ? computeCapacityUtilization(network, constraints)
    : null
  const territoryById = layers.territory
    ? computeTerritoryColors(network).colorByNode
    : null
  const bomLaneIds = bomDrivenLaneIds(bom, network)

  const visibleLanes = layers.lanes
    ? lanes.filter((l) => {
        const a = nodeMap.get(l.from)
        const b = nodeMap.get(l.to)
        return (
          a &&
          b &&
          visibleNode(a, layers) &&
          visibleNode(b, layers) &&
          laneMatchesProductFilter(l, productMix) &&
          nodeMatchesProductFilter(a, productMix) &&
          nodeMatchesProductFilter(b, productMix)
        )
      })
    : []

  return (
    <svg
      className="network-svg"
      viewBox="0 0 100 100"
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="Network map SVG fallback"
      onClick={() => onClear?.()}
    >
      <defs>
        <radialGradient id="mapGlow" cx="50%" cy="45%" r="55%">
          <stop offset="0%" stopColor="var(--ff-map-glow-0)" />
          <stop offset="100%" stopColor="var(--ff-map-glow-1)" />
        </radialGradient>
        <pattern id="grid" width="5" height="5" patternUnits="userSpaceOnUse">
          <path
            d="M 5 0 L 0 0 0 5"
            fill="none"
            stroke="var(--ff-map-grid)"
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
        fill="var(--ff-map-land)"
        stroke="var(--ff-map-land-stroke)"
        strokeWidth="0.3"
      />

      {visibleLanes.map((lane: NetworkLane) => {
        const a = nodeMap.get(lane.from)!
        const b = nodeMap.get(lane.to)!
        const selected = selectedSet.has(lane.id)
        const isBom = bomLaneIds.has(lane.id)
        return (
          <path
            key={lane.id}
            d={bezierPath(a, b)}
            fill="none"
            stroke={
              selected
                ? 'var(--ff-accent-text)'
                : isBom
                  ? '#c084fc'
                  : 'var(--ff-lane)'
            }
            strokeWidth={selected ? 0.55 : isBom ? 0.48 : 0.35}
            strokeLinecap="round"
            className="lane-arc"
            onClick={(e) => {
              e.stopPropagation()
              onSelect(lane.id, 'lane', e.shiftKey)
            }}
          />
        )
      })}

      {nodes.filter((n) => visibleNode(n, layers) && nodeMatchesProductFilter(n, productMix)).map((node) => {
        const selected = selectedSet.has(node.id)
        const util = utilById?.get(node.id)
        const terr = territoryById?.get(node.id)
        const isFacility =
          node.kind === 'dc' || node.kind === 'plant' || node.kind === 'candidate'
        const fill =
          layers.territory && terr
            ? terr.color
            : layers.utilization && util && isFacility
              ? util.color
              : colorFor(node.kind)
        const status = statusById.get(node.id)
        const closed = status === 'closed'
        return (
          <g
            key={node.id}
            className={`map-node${selected ? ' is-selected' : ''}${closed ? ' is-closed' : ''}`}
            transform={`translate(${node.x} ${node.y})`}
            opacity={closed ? 0.35 : 1}
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
                stroke="var(--ff-accent-text)"
                strokeWidth="0.35"
                opacity="0.85"
              />
            )}
            {status === 'candidate' && (
              <circle
                r="2.8"
                fill="none"
                stroke="#fb7185"
                strokeWidth="0.25"
                strokeDasharray="0.8 0.6"
              />
            )}
            <circle
              r={selected ? 2.4 : 1.9}
              fill="var(--ff-node-fill)"
              stroke={fill}
              strokeWidth={selected ? 0.55 : 0.4}
            />
            <circle r="0.7" fill={fill} />
            <text
              y="3.8"
              textAnchor="middle"
              className="node-label"
              fill="var(--ff-text-soft)"
              fontSize="2.1"
            >
              {node.name.split(' ')[0]}
            </text>
            <title>
              {node.name} · {kindLabel(node.kind)}
              {status ? ` · ${status}` : ''}
              {layers.territory && terr
                ? ` · ${terr.label}`
                : layers.utilization && util && isFacility
                  ? ` · ${util.label}`
                  : ''}
            </title>
          </g>
        )
      })}
      <title>
        {network.source === 'upload' ? 'Uploaded' : 'Sample'} network SVG
      </title>
    </svg>
  )
}
