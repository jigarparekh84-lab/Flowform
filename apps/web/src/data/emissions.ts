/**
 * Planning emission factors (kg CO₂e per ton-mile) by transport mode.
 * Used to recompute lane + network CO₂ when distances are available.
 */

export type EmissionFactor = {
  mode: string
  /** kg CO₂e per ton-mile */
  kgPerTonMile: number
  notes: string
}

export const DEFAULT_EMISSION_FACTORS: EmissionFactor[] = [
  {
    mode: 'Truck',
    kgPerTonMile: 0.161,
    notes: 'Heavy-duty diesel TL average (planning)',
  },
  {
    mode: 'Rail',
    kgPerTonMile: 0.022,
    notes: 'Class I freight rail average',
  },
  {
    mode: 'Intermodal',
    kgPerTonMile: 0.065,
    notes: 'Rail + dray blended',
  },
  {
    mode: 'Ocean',
    kgPerTonMile: 0.01,
    notes: 'Deep-sea container (stub)',
  },
  {
    mode: 'Air',
    kgPerTonMile: 0.98,
    notes: 'Belly / freighter blend (stub)',
  },
]

export function factorForMode(
  factors: EmissionFactor[],
  mode: string,
): number {
  const key = mode.trim().toLowerCase()
  const hit = factors.find((f) => f.mode.toLowerCase() === key)
  if (hit) return hit.kgPerTonMile
  // aliases
  if (key.includes('truck') || key.includes('tl') || key.includes('ltl')) {
    return factors.find((f) => f.mode === 'Truck')?.kgPerTonMile ?? 0.161
  }
  if (key.includes('rail')) {
    return factors.find((f) => f.mode === 'Rail')?.kgPerTonMile ?? 0.022
  }
  if (key.includes('inter') || key.includes('imdl')) {
    return factors.find((f) => f.mode === 'Intermodal')?.kgPerTonMile ?? 0.065
  }
  return factors[0]?.kgPerTonMile ?? 0.161
}

export type LaneCo2Input = {
  mode: string
  miles: number
  /** Tons moved on the lane (mock default 1 if unknown). */
  tons?: number
  /** Legacy co2Kg on the lane row (used when miles unknown). */
  fallbackCo2Kg?: number
}

/** kg CO₂e for one lane shipment. */
export function laneCo2Kg(
  factors: EmissionFactor[],
  lane: LaneCo2Input,
): number {
  if (lane.miles > 0) {
    const tons = lane.tons ?? 1
    return Math.round(lane.miles * tons * factorForMode(factors, lane.mode) * 10) / 10
  }
  return lane.fallbackCo2Kg ?? 0
}

/** Sum network CO₂ in kilotonnes. */
export function networkCo2Kt(
  factors: EmissionFactor[],
  lanes: LaneCo2Input[],
): number {
  const kg = lanes.reduce((sum, l) => sum + laneCo2Kg(factors, l), 0)
  return Math.round((kg / 1000) * 10) / 10
}

export function formatCo2Kt(kt: number): string {
  return `${kt.toFixed(1)} kt`
}
