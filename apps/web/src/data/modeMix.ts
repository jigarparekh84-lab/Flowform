/**
 * Transport mode mix — canonical modes (road/rail/air/ocean),
 * cost relatives aligned with CO₂ emission factors, and Compare summary.
 */

import {
  factorForMode,
  laneCo2Kg,
  type EmissionFactor,
} from './emissions'
import { haversineMiles, nodeLatLng } from './geo'
import type { NetworkLane, NetworkNode } from './sampleNetwork'

/** Editable lane modes (Road aliases Truck in factors). */
export const TRANSPORT_MODES = [
  'Road',
  'Rail',
  'Air',
  'Ocean',
  'Intermodal',
] as const

export type TransportMode = (typeof TRANSPORT_MODES)[number]

/**
 * Relative lane $/unit vs Road — used when changing mode so optimize/CTS
 * pick up mode cost alongside CO₂ factors.
 */
export const MODE_COST_RELATIVE: Record<string, number> = {
  Road: 1,
  Truck: 1,
  Rail: 0.55,
  Intermodal: 0.72,
  Ocean: 0.32,
  Air: 4.5,
}

/** Normalize aliases → canonical TransportMode label. */
export function normalizeMode(mode: string): TransportMode {
  const key = mode.trim().toLowerCase()
  if (
    key === 'truck' ||
    key === 'road' ||
    key.includes('tl') ||
    key.includes('ltl') ||
    key.includes('highway')
  ) {
    return 'Road'
  }
  if (key.includes('rail')) return 'Rail'
  if (key.includes('air') || key.includes('airfreight')) return 'Air'
  if (key.includes('ocean') || key.includes('sea') || key.includes('vessel')) {
    return 'Ocean'
  }
  if (key.includes('inter') || key.includes('imdl')) return 'Intermodal'
  const hit = TRANSPORT_MODES.find((m) => m.toLowerCase() === key)
  return hit ?? 'Road'
}

/** Mode string for emission factor lookup (Road → Truck table row). */
export function emissionModeKey(mode: string): string {
  const n = normalizeMode(mode)
  return n === 'Road' ? 'Truck' : n
}

export function costRelativeForMode(mode: string): number {
  const n = normalizeMode(mode)
  return MODE_COST_RELATIVE[n] ?? MODE_COST_RELATIVE.Road
}

/**
 * Apply a mode change: rescale cost by relative factors, refresh co2Kg
 * from emission factors × miles when coordinates exist.
 */
export function applyLaneModeChange(
  lane: NetworkLane,
  newMode: string,
  args: {
    nodes: NetworkNode[]
    factors: EmissionFactor[]
  },
): NetworkLane {
  const mode = normalizeMode(newMode)
  const oldRel = costRelativeForMode(lane.mode)
  const newRel = costRelativeForMode(mode)
  const costPerUnit =
    Math.round(lane.costPerUnit * (newRel / Math.max(0.01, oldRel)) * 100) / 100

  const from = args.nodes.find((n) => n.id === lane.from)
  const to = args.nodes.find((n) => n.id === lane.to)
  let miles = 0
  if (from && to) {
    miles = haversineMiles(nodeLatLng(from), nodeLatLng(to))
  }
  const co2Kg = laneCo2Kg(args.factors, {
    mode: emissionModeKey(mode),
    miles,
    tons: 1,
    fallbackCo2Kg: lane.co2Kg,
  })

  return { ...lane, mode, costPerUnit, co2Kg }
}

export type ModeMixRow = {
  mode: TransportMode
  laneCount: number
  lanePct: number
  /** Approximate ton-miles (1 ton × miles). */
  tonMiles: number
  tonMilePct: number
  co2Kg: number
  co2Pct: number
  /** Mean cost/unit on lanes of this mode. */
  avgCostPerUnit: number
  costRelative: number
  kgPerTonMile: number
}

export function summarizeModeMix(
  lanes: NetworkLane[],
  nodes: NetworkNode[],
  factors: EmissionFactor[],
): ModeMixRow[] {
  if (lanes.length === 0) return []

  const buckets = new Map<
    TransportMode,
    { count: number; tonMiles: number; co2: number; costSum: number }
  >()

  for (const mode of TRANSPORT_MODES) {
    buckets.set(mode, { count: 0, tonMiles: 0, co2: 0, costSum: 0 })
  }

  for (const lane of lanes) {
    const mode = normalizeMode(lane.mode)
    const from = nodes.find((n) => n.id === lane.from)
    const to = nodes.find((n) => n.id === lane.to)
    let miles = 0
    if (from && to) {
      miles = haversineMiles(nodeLatLng(from), nodeLatLng(to))
    }
    const co2 = laneCo2Kg(factors, {
      mode: emissionModeKey(mode),
      miles,
      tons: 1,
      fallbackCo2Kg: lane.co2Kg,
    })
    const b = buckets.get(mode)!
    b.count += 1
    b.tonMiles += miles
    b.co2 += co2
    b.costSum += lane.costPerUnit
  }

  const totalLanes = lanes.length
  const totalTonMiles =
    [...buckets.values()].reduce((s, b) => s + b.tonMiles, 0) || 1
  const totalCo2 = [...buckets.values()].reduce((s, b) => s + b.co2, 0) || 1

  const rows: ModeMixRow[] = []
  for (const mode of TRANSPORT_MODES) {
    const b = buckets.get(mode)!
    if (b.count === 0) continue
    rows.push({
      mode,
      laneCount: b.count,
      lanePct: Math.round((b.count / totalLanes) * 1000) / 10,
      tonMiles: Math.round(b.tonMiles),
      tonMilePct: Math.round((b.tonMiles / totalTonMiles) * 1000) / 10,
      co2Kg: Math.round(b.co2 * 10) / 10,
      co2Pct: Math.round((b.co2 / totalCo2) * 1000) / 10,
      avgCostPerUnit: Math.round((b.costSum / b.count) * 100) / 100,
      costRelative: costRelativeForMode(mode),
      kgPerTonMile: factorForMode(factors, emissionModeKey(mode)),
    })
  }
  return rows.sort((a, b) => b.laneCount - a.laneCount)
}
