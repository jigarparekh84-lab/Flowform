/**
 * Canvas ↔ geographic helpers for MapLibre + distance/CO₂.
 * Canvas x/y are 0–100 over a rough CONUS/MX bounding box.
 */

export type LatLng = { lat: number; lng: number }

/** Inverse of latLngToXY (CONUS / MX box). */
export function xyToLatLng(x: number, y: number): LatLng {
  const lng = (x / 100) * 60 - 125
  const lat = 50 - (y / 100) * 30
  return {
    lat: Math.round(lat * 100) / 100,
    lng: Math.round(lng * 100) / 100,
  }
}

/** Haversine distance in miles. */
export function haversineMiles(a: LatLng, b: LatLng): number {
  const R = 3958.8
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** Resolve lat/lng from node fields or canvas x/y. */
export function nodeLatLng(node: {
  lat?: number
  lng?: number
  x: number
  y: number
}): LatLng {
  if (
    typeof node.lat === 'number' &&
    typeof node.lng === 'number' &&
    Number.isFinite(node.lat) &&
    Number.isFinite(node.lng)
  ) {
    return { lat: node.lat, lng: node.lng }
  }
  return xyToLatLng(node.x, node.y)
}

export type RasterStyleSpec = {
  version: 8
  name: string
  sources: Record<
    string,
    {
      type: 'raster'
      tiles: string[]
      tileSize: number
      attribution: string
    }
  >
  layers: {
    id: string
    type: 'raster'
    source: string
    minzoom: number
    maxzoom: number
  }[]
}

/** Free raster basemap styles (CartoCDN) — no API key. */
export function cartoRasterStyle(theme: 'light' | 'dark'): RasterStyleSpec {
  const tiles =
    theme === 'dark'
      ? [
          'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
          'https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
          'https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
        ]
      : [
          'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
          'https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
          'https://c.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
        ]
  return {
    version: 8,
    name: theme === 'dark' ? 'Flowform Dark (Carto)' : 'Flowform Light (Carto)',
    sources: {
      carto: {
        type: 'raster',
        tiles,
        tileSize: 256,
        attribution: '© OpenStreetMap © CARTO',
      },
    },
    layers: [
      {
        id: 'carto-tiles',
        type: 'raster',
        source: 'carto',
        minzoom: 0,
        maxzoom: 19,
      },
    ],
  }
}
