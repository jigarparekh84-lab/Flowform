/**
 * CSV parsers + templates for Flowform Data room.
 * Map coords: prefer lat/lng (converted to 0–100 canvas); fall back to x/y.
 */

import {
  LANES as SAMPLE_LANES,
  NODES as SAMPLE_NODES,
  type NetworkLane,
  type NetworkNode,
  type NodeKind,
} from './sampleNetwork'

export type CsvKind = 'sites' | 'demand' | 'lanes'

export type ValidationIssue = {
  level: 'error' | 'warn' | 'info'
  message: string
  row?: number
}

export type DatasetValidation = {
  ok: boolean
  issues: ValidationIssue[]
  /** 0–100: how well optional lat/lng geocode columns are populated. */
  geocodeScore: number
  /** 0–100: how closely uploaded data reconciles to the sample baseline shape. */
  reconcileScore: number
  rowCounts: { sites: number; demand: number; lanes: number }
}

export type UploadedNetwork = {
  nodes: NetworkNode[]
  lanes: NetworkLane[]
  /** Demand volumes by node id (from demand CSV or inferred). */
  demandVolume: Record<string, number>
  source: 'sample' | 'upload'
  fileNames: Partial<Record<CsvKind, string>>
  validation: DatasetValidation
}

export const SITES_TEMPLATE = `id,name,kind,region,capacity,lat,lng
n1,Austin Plant,plant,South,42000,30.27,-97.74
n2,Columbus DC,dc,Midwest,18000,39.96,-82.99
n3,Atlanta DC,dc,Southeast,14000,33.75,-84.39
n4,Chicago Hub,demand,Midwest,9200,41.88,-87.63
n5,Dallas Metro,demand,South,7100,32.78,-96.80
n6,NYC Corridor,demand,Northeast,11400,40.71,-74.01
n7,Monterrey Sup,supplier,MX,22000,25.67,-100.31
n8,Reno DC,dc,West,12000,39.53,-119.81
`

export const DEMAND_TEMPLATE = `id,name,region,volume,lat,lng
n4,Chicago Hub,Midwest,9200,41.88,-87.63
n5,Dallas Metro,South,7100,32.78,-96.80
n6,NYC Corridor,Northeast,11400,40.71,-74.01
`

export const LANES_TEMPLATE = `id,from,to,mode,cost_per_unit,lead_days,co2_kg
l1,n7,n1,Truck,1.12,3,18
l2,n1,n2,Rail,0.64,5,9
l3,n1,n3,Truck,0.88,2,14
l4,n2,n4,Truck,0.41,1,6
l5,n3,n6,Intermodal,0.97,4,11
l6,n1,n5,Truck,0.35,1,5
l7,n8,n2,Rail,0.72,6,8
l8,n3,n5,Truck,0.79,2,12
l9,n2,n6,Truck,1.38,2,10
`

const SITES_REQUIRED = ['id', 'name', 'kind'] as const
const DEMAND_REQUIRED = ['id', 'name', 'volume'] as const
const LANES_REQUIRED = ['id', 'from', 'to'] as const

function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'))
  if (lines.length === 0) return { headers: [], rows: [] }
  const headers = splitCsvLine(lines[0]).map((h) =>
    h.trim().toLowerCase().replace(/\s+/g, '_'),
  )
  const rows = lines.slice(1).map(splitCsvLine)
  return { headers, rows }
}

/** Minimal CSV split supporting quoted fields. */
function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQ = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') {
        cur += '"'
        i++
      } else {
        inQ = !inQ
      }
    } else if (ch === ',' && !inQ) {
      out.push(cur.trim())
      cur = ''
    } else {
      cur += ch
    }
  }
  out.push(cur.trim())
  return out
}

function col(headers: string[], row: string[], name: string): string {
  const i = headers.indexOf(name)
  return i >= 0 ? (row[i] ?? '').trim() : ''
}

function num(raw: string, fallback = 0): number {
  const n = parseFloat(raw.replace(/[,$]/g, ''))
  return Number.isFinite(n) ? n : fallback
}

/** Rough CONUS / MX lat/lng → canvas 0–100. */
export function latLngToXY(lat: number, lng: number): { x: number; y: number } {
  const x = ((lng + 125) / 60) * 100
  const y = ((50 - lat) / 30) * 100
  return {
    x: Math.min(96, Math.max(4, Math.round(x * 10) / 10)),
    y: Math.min(92, Math.max(8, Math.round(y * 10) / 10)),
  }
}

function parseKind(raw: string): NodeKind | null {
  const k = raw.toLowerCase()
  if (k === 'plant' || k === 'dc' || k === 'demand' || k === 'supplier' || k === 'candidate') {
    return k
  }
  if (k === 'warehouse' || k === 'distribution' || k === 'distribution_center') return 'dc'
  if (k === 'factory' || k === 'manufacturing') return 'plant'
  if (k === 'customer' || k === 'market') return 'demand'
  return null
}

function formatCapacity(kind: NodeKind, volume: number): string {
  if (kind === 'dc') return `${Math.round(volume / 1000)}k pallet`
  if (volume >= 1000) return `${(volume / 1000).toFixed(1)}k u/wk`
  return `${Math.round(volume)} u/wk`
}

export function downloadTemplate(kind: CsvKind): void {
  const map: Record<CsvKind, { name: string; body: string }> = {
    sites: { name: 'flowform_sites_template.csv', body: SITES_TEMPLATE },
    demand: { name: 'flowform_demand_template.csv', body: DEMAND_TEMPLATE },
    lanes: { name: 'flowform_lanes_template.csv', body: LANES_TEMPLATE },
  }
  const { name, body } = map[kind]
  const blob = new Blob([body], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

export type ParseSitesResult = {
  nodes: NetworkNode[]
  issues: ValidationIssue[]
  geocodeHits: number
  geocodeTotal: number
}

export function parseSitesCsv(text: string): ParseSitesResult {
  const { headers, rows } = parseCsv(text)
  const issues: ValidationIssue[] = []
  for (const req of SITES_REQUIRED) {
    if (!headers.includes(req)) {
      issues.push({ level: 'error', message: `Sites CSV missing required column “${req}”.` })
    }
  }
  if (issues.some((i) => i.level === 'error')) {
    return { nodes: [], issues, geocodeHits: 0, geocodeTotal: 0 }
  }

  const nodes: NetworkNode[] = []
  let geocodeHits = 0
  let geocodeTotal = 0

  rows.forEach((row, idx) => {
    const rowNum = idx + 2
    const id = col(headers, row, 'id')
    const name = col(headers, row, 'name')
    const kindRaw = col(headers, row, 'kind')
    const kind = parseKind(kindRaw)
    if (!id || !name || !kind) {
      issues.push({
        level: 'error',
        row: rowNum,
        message: `Row ${rowNum}: need id, name, and valid kind (plant|dc|demand|supplier|candidate).`,
      })
      return
    }
    const region = col(headers, row, 'region') || '—'
    const capacityRaw = col(headers, row, 'capacity')
    const latRaw = col(headers, row, 'lat') || col(headers, row, 'latitude')
    const lngRaw = col(headers, row, 'lng') || col(headers, row, 'lon') || col(headers, row, 'longitude')
    const xRaw = col(headers, row, 'x')
    const yRaw = col(headers, row, 'y')

    geocodeTotal++
    let x = 50
    let y = 50
    let lat: number | undefined
    let lng: number | undefined
    if (latRaw && lngRaw) {
      const latN = num(latRaw, NaN)
      const lngN = num(lngRaw, NaN)
      if (Number.isFinite(latN) && Number.isFinite(lngN)) {
        const xy = latLngToXY(latN, lngN)
        x = xy.x
        y = xy.y
        lat = latN
        lng = lngN
        geocodeHits++
      } else {
        issues.push({
          level: 'warn',
          row: rowNum,
          message: `Row ${rowNum}: lat/lng not numeric — falling back to x/y or center.`,
        })
      }
    } else if (xRaw && yRaw) {
      x = Math.min(96, Math.max(4, num(xRaw, 50)))
      y = Math.min(92, Math.max(8, num(yRaw, 50)))
      issues.push({
        level: 'info',
        row: rowNum,
        message: `Row ${rowNum}: using canvas x/y (no lat/lng).`,
      })
    } else {
      issues.push({
        level: 'warn',
        row: rowNum,
        message: `Row ${rowNum}: no lat/lng or x/y — placed at map center.`,
      })
    }

    const capNum = num(capacityRaw, kind === 'dc' ? 12000 : 8000)
    nodes.push({
      id,
      name,
      kind,
      region,
      capacity: capacityRaw || formatCapacity(kind, capNum),
      x,
      y,
      ...(lat != null && lng != null ? { lat, lng } : {}),
    })
  })

  return { nodes, issues, geocodeHits, geocodeTotal }
}

export type ParseDemandResult = {
  nodes: NetworkNode[]
  volume: Record<string, number>
  issues: ValidationIssue[]
  geocodeHits: number
  geocodeTotal: number
}

export function parseDemandCsv(text: string): ParseDemandResult {
  const { headers, rows } = parseCsv(text)
  const issues: ValidationIssue[] = []
  for (const req of DEMAND_REQUIRED) {
    if (!headers.includes(req)) {
      issues.push({ level: 'error', message: `Demand CSV missing required column “${req}”.` })
    }
  }
  if (issues.some((i) => i.level === 'error')) {
    return { nodes: [], volume: {}, issues, geocodeHits: 0, geocodeTotal: 0 }
  }

  const nodes: NetworkNode[] = []
  const volume: Record<string, number> = {}
  let geocodeHits = 0
  let geocodeTotal = 0

  rows.forEach((row, idx) => {
    const rowNum = idx + 2
    const id = col(headers, row, 'id')
    const name = col(headers, row, 'name')
    const vol = num(col(headers, row, 'volume'), NaN)
    if (!id || !name || !Number.isFinite(vol)) {
      issues.push({
        level: 'error',
        row: rowNum,
        message: `Row ${rowNum}: need id, name, and numeric volume.`,
      })
      return
    }
    const region = col(headers, row, 'region') || '—'
    const latRaw = col(headers, row, 'lat') || col(headers, row, 'latitude')
    const lngRaw = col(headers, row, 'lng') || col(headers, row, 'lon') || col(headers, row, 'longitude')
    const xRaw = col(headers, row, 'x')
    const yRaw = col(headers, row, 'y')

    geocodeTotal++
    let x = 50
    let y = 50
    let lat: number | undefined
    let lng: number | undefined
    if (latRaw && lngRaw) {
      const latN = num(latRaw, NaN)
      const lngN = num(lngRaw, NaN)
      if (Number.isFinite(latN) && Number.isFinite(lngN)) {
        const xy = latLngToXY(latN, lngN)
        x = xy.x
        y = xy.y
        lat = latN
        lng = lngN
        geocodeHits++
      }
    } else if (xRaw && yRaw) {
      x = Math.min(96, Math.max(4, num(xRaw, 50)))
      y = Math.min(92, Math.max(8, num(yRaw, 50)))
    } else {
      issues.push({
        level: 'warn',
        row: rowNum,
        message: `Row ${rowNum}: demand point missing lat/lng.`,
      })
    }

    volume[id] = vol
    nodes.push({
      id,
      name,
      kind: 'demand',
      region,
      capacity: formatCapacity('demand', vol),
      x,
      y,
      ...(lat != null && lng != null ? { lat, lng } : {}),
    })
  })

  return { nodes, volume, issues, geocodeHits, geocodeTotal }
}

export type ParseLanesResult = {
  lanes: NetworkLane[]
  issues: ValidationIssue[]
}

export function parseLanesCsv(text: string): ParseLanesResult {
  const { headers, rows } = parseCsv(text)
  const issues: ValidationIssue[] = []
  for (const req of LANES_REQUIRED) {
    if (!headers.includes(req)) {
      issues.push({ level: 'error', message: `Lanes CSV missing required column “${req}”.` })
    }
  }
  if (issues.some((i) => i.level === 'error')) {
    return { lanes: [], issues }
  }

  const lanes: NetworkLane[] = []
  rows.forEach((row, idx) => {
    const rowNum = idx + 2
    const id = col(headers, row, 'id')
    const from = col(headers, row, 'from')
    const to = col(headers, row, 'to')
    if (!id || !from || !to) {
      issues.push({
        level: 'error',
        row: rowNum,
        message: `Row ${rowNum}: need id, from, and to.`,
      })
      return
    }
    lanes.push({
      id,
      from,
      to,
      mode: col(headers, row, 'mode') || 'Truck',
      costPerUnit: num(
        col(headers, row, 'cost_per_unit') || col(headers, row, 'cost'),
        0.5,
      ),
      leadDays: Math.max(0, Math.round(num(col(headers, row, 'lead_days') || col(headers, row, 'lead'), 2))),
      co2Kg: num(col(headers, row, 'co2_kg') || col(headers, row, 'co2'), 10),
    })
  })

  return { lanes, issues }
}

/** Score how closely an uploaded set resembles the sample baseline shape. */
export function computeReconcileScore(
  nodes: NetworkNode[],
  lanes: NetworkLane[],
  demandVolume: Record<string, number>,
): number {
  const sampleDemand = SAMPLE_NODES.filter((n) => n.kind === 'demand')
  const sampleFacilities = SAMPLE_NODES.filter(
    (n) => n.kind === 'dc' || n.kind === 'plant',
  )
  const facilities = nodes.filter((n) => n.kind === 'dc' || n.kind === 'plant')
  const demand = nodes.filter((n) => n.kind === 'demand')

  let score = 40

  // Kind presence
  if (facilities.length > 0) score += 10
  if (demand.length > 0) score += 10
  if (lanes.length > 0) score += 8

  // Count proximity to sample
  const facRatio =
    sampleFacilities.length === 0
      ? 1
      : Math.min(facilities.length, sampleFacilities.length) /
        Math.max(facilities.length, sampleFacilities.length)
  const demRatio =
    sampleDemand.length === 0
      ? 1
      : Math.min(demand.length, sampleDemand.length) /
        Math.max(demand.length, sampleDemand.length)
  score += facRatio * 12 + demRatio * 12

  // Volume magnitude vs sample (~27.7k)
  const sampleVol = 9200 + 7100 + 11400
  const uploadVol = Object.values(demandVolume).reduce((a, b) => a + b, 0)
  if (uploadVol > 0) {
    const vr =
      Math.min(uploadVol, sampleVol) / Math.max(uploadVol, sampleVol)
    score += vr * 10
  }

  // Lane endpoint coverage
  const ids = new Set(nodes.map((n) => n.id))
  if (lanes.length > 0) {
    const covered = lanes.filter((l) => ids.has(l.from) && ids.has(l.to)).length
    score += (covered / lanes.length) * 8
  }

  // Bonus if sample lane count is similar
  const laneRatio =
    SAMPLE_LANES.length === 0
      ? 1
      : Math.min(lanes.length || 1, SAMPLE_LANES.length) /
        Math.max(lanes.length || 1, SAMPLE_LANES.length)
  score += laneRatio * 5

  return Math.min(100, Math.max(0, Math.round(score)))
}

export function buildValidation(
  nodes: NetworkNode[],
  lanes: NetworkLane[],
  demandVolume: Record<string, number>,
  issues: ValidationIssue[],
  geocodeHits: number,
  geocodeTotal: number,
): DatasetValidation {
  const errors = issues.filter((i) => i.level === 'error')
  const geocodeScore =
    geocodeTotal === 0 ? 0 : Math.round((geocodeHits / geocodeTotal) * 100)
  const reconcileScore = computeReconcileScore(nodes, lanes, demandVolume)

  if (nodes.length === 0) {
    issues.push({ level: 'error', message: 'No sites/demand nodes loaded.' })
  }
  const demandNodes = nodes.filter((n) => n.kind === 'demand')
  if (demandNodes.length === 0) {
    issues.push({
      level: 'warn',
      message: 'No demand nodes — optimize will use facility-only heuristic.',
    })
  }

  const ids = new Set(nodes.map((n) => n.id))
  for (const lane of lanes) {
    if (!ids.has(lane.from) || !ids.has(lane.to)) {
      issues.push({
        level: 'warn',
        message: `Lane ${lane.id} references missing node (${lane.from}→${lane.to}).`,
      })
    }
  }

  return {
    ok: errors.length === 0 && nodes.length > 0,
    issues,
    geocodeScore,
    reconcileScore,
    rowCounts: {
      sites: nodes.filter((n) => n.kind !== 'demand').length,
      demand: demandNodes.length,
      lanes: lanes.length,
    },
  }
}

export function sampleUploadedNetwork(): UploadedNetwork {
  const demandVolume: Record<string, number> = {
    n4: 9200,
    n5: 7100,
    n6: 11400,
  }
  const validation = buildValidation(
    SAMPLE_NODES,
    SAMPLE_LANES,
    demandVolume,
    [{ level: 'info', message: 'Using built-in sample network.' }],
    SAMPLE_NODES.length,
    SAMPLE_NODES.length,
  )
  return {
    nodes: SAMPLE_NODES,
    lanes: SAMPLE_LANES,
    demandVolume,
    source: 'sample',
    fileNames: {},
    validation,
  }
}

/** Merge sites + demand uploads (demand wins on overlapping ids for kind/volume). */
export function mergeNetworkParts(parts: {
  sites?: ParseSitesResult
  demand?: ParseDemandResult
  lanes?: ParseLanesResult
  fileNames?: Partial<Record<CsvKind, string>>
}): UploadedNetwork {
  const issues: ValidationIssue[] = []
  let geocodeHits = 0
  let geocodeTotal = 0

  const byId = new Map<string, NetworkNode>()
  const demandVolume: Record<string, number> = {}

  if (parts.sites) {
    issues.push(...parts.sites.issues)
    geocodeHits += parts.sites.geocodeHits
    geocodeTotal += parts.sites.geocodeTotal
    for (const n of parts.sites.nodes) byId.set(n.id, n)
  }
  if (parts.demand) {
    issues.push(...parts.demand.issues)
    geocodeHits += parts.demand.geocodeHits
    geocodeTotal += parts.demand.geocodeTotal
    Object.assign(demandVolume, parts.demand.volume)
    for (const n of parts.demand.nodes) {
      const prev = byId.get(n.id)
      if (prev && prev.kind !== 'demand') {
        // Keep facility; still record volume against id if same id reused.
        demandVolume[n.id] = parts.demand.volume[n.id]
      } else {
        byId.set(n.id, n)
      }
    }
  }

  let lanes: NetworkLane[] = []
  if (parts.lanes) {
    issues.push(...parts.lanes.issues)
    lanes = parts.lanes.lanes
  }

  const nodes = [...byId.values()]
  // Infer demand volume from capacity text when demand CSV absent
  for (const n of nodes) {
    if (n.kind === 'demand' && demandVolume[n.id] == null) {
      const m = n.capacity.replace(/,/g, '').match(/([\d.]+)/)
      if (m) {
        let v = parseFloat(m[1])
        if (/k/i.test(n.capacity)) v *= 1000
        demandVolume[n.id] = v
      }
    }
  }

  const validation = buildValidation(
    nodes,
    lanes,
    demandVolume,
    issues,
    geocodeHits,
    geocodeTotal,
  )

  return {
    nodes,
    lanes,
    demandVolume,
    source: 'upload',
    fileNames: parts.fileNames ?? {},
    validation,
  }
}
