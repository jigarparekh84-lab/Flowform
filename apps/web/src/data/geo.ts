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

/** Optional Carto key — only used when VITE_BASEMAP=carto. */
export function cartoApiKey(): string {
  return (
    (import.meta as ImportMeta & { env?: { VITE_CARTO_API_KEY?: string } }).env
      ?.VITE_CARTO_API_KEY?.trim() || ''
  )
}

/** Preferred basemap: OpenFreeMap (free, commercial OK, no API key). */
export function openFreeMapStyleUrl(theme: 'light' | 'dark'): string {
  return theme === 'dark'
    ? 'https://tiles.openfreemap.org/styles/dark'
    : 'https://tiles.openfreemap.org/styles/liberty'
}

export type BasemapProvider = 'openfreemap' | 'carto'

/** Select basemap provider. Default OpenFreeMap; set VITE_BASEMAP=carto to use Carto. */
export function basemapProvider(): BasemapProvider {
  const raw = (
    (import.meta as ImportMeta & { env?: { VITE_BASEMAP?: string } }).env
      ?.VITE_BASEMAP?.trim()
      .toLowerCase() || 'openfreemap'
  )
  return raw === 'carto' ? 'carto' : 'openfreemap'
}

/**
 * Style for MapLibre: OpenFreeMap style URL, or Carto raster when VITE_BASEMAP=carto.
 * Carto requires `?key=` on tile URLs (not `api_key`).
 */
export function mapBasemapStyle(
  theme: 'light' | 'dark',
): string | RasterStyleSpec {
  if (basemapProvider() === 'carto') {
    return cartoRasterStyle(theme)
  }
  return openFreeMapStyleUrl(theme)
}

/**
 * CartoCDN raster basemap (optional fallback).
 * Free key: https://carto.com/basemaps/apikey/
 */
export function cartoRasterStyle(theme: 'light' | 'dark'): RasterStyleSpec {
  const key = cartoApiKey()
  const q = key ? `?key=${encodeURIComponent(key)}` : ''
  const path =
    theme === 'dark' ? 'rastertiles/dark_all' : 'rastertiles/light_all'
  const tiles = ['a', 'b', 'c', 'd'].map(
    (h) =>
      `https://${h}.basemaps.cartocdn.com/${path}/{z}/{x}/{y}.png${q}`,
  )
  return {
    version: 8,
    name:
      theme === 'dark'
        ? key
          ? 'Flowform Dark (Carto · keyed)'
          : 'Flowform Dark (Carto · key missing)'
        : key
          ? 'Flowform Light (Carto · keyed)'
          : 'Flowform Light (Carto · key missing)',
    sources: {
      carto: {
        type: 'raster',
        tiles,
        tileSize: 256,
        attribution:
          '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>, © <a href="https://carto.com/attributions">CARTO</a>',
      },
    },
    layers: [
      {
        id: 'carto-tiles',
        type: 'raster',
        source: 'carto',
        minzoom: 0,
        maxzoom: 20,
      },
    ],
  }
}
