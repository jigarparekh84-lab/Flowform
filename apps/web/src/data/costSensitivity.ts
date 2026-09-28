/**
 * Cost-driver sensitivity: one-at-a-time tornado + lightweight Monte Carlo.
 * Drivers shock shares of baseline OpEx cost KPI (aligned with CTS / waterfall mocks).
 */

import { parseMoneyM, type Scenario } from './sampleNetwork'

export type CostDriverId =
  | 'transport-rate'
  | 'fuel'
  | 'tariff'
  | 'demand-volume'
  | 'facility-fixed'
  | 'inventory-holding'

export type CostDriverDef = {
  id: CostDriverId
  label: string
  description: string
  /** Default ±% range for OAT / MC sampling. */
  defaultRangePct: number
  /**
   * Fraction of baseline cost this driver scales (0–1).
   * Cost impact ≈ baseline × share × (pct/100) × elasticity.
   */
  costShare: number
  /** How strongly cost tracks the driver (1 = fully proportional to share). */
  elasticity: number
  /** Optional link to Scenarios sensitivity preset when ranges match. */
  relatedPreset?: 'fuel-20' | 'tariff-duty' | 'demand-shift'
}

export const COST_DRIVERS: CostDriverDef[] = [
  {
    id: 'transport-rate',
    label: 'Transport $/mi',
    description: 'Base lane rate (excl. fuel surcharge)',
    defaultRangePct: 15,
    costShare: 0.4,
    elasticity: 1,
  },
  {
    id: 'fuel',
    label: 'Fuel',
    description: 'Fuel surcharge on transport (~fuel +20% preset)',
    defaultRangePct: 20,
    costShare: 0.15,
    elasticity: 1,
    relatedPreset: 'fuel-20',
  },
  {
    id: 'tariff',
    label: 'Tariff / duty',
    description: 'Inbound duty (MX / nearshore) — matches tariff preset',
    defaultRangePct: 25,
    costShare: 0.18,
    elasticity: 1,
    relatedPreset: 'tariff-duty',
  },
  {
    id: 'demand-volume',
    label: 'Demand volume',
    description: 'Network volume; variable costs scale sub-linearly',
    defaultRangePct: 15,
    costShare: 0.55,
    elasticity: 0.75,
    relatedPreset: 'demand-shift',
  },
  {
    id: 'facility-fixed',
    label: 'Facility fixed cost',
    description: 'DC / plant fixed OpEx allocation',
    defaultRangePct: 12,
    costShare: 0.2,
    elasticity: 1,
  },
  {
    id: 'inventory-holding',
    label: 'Inventory holding',
    description: 'Safety-stock holding cost share',
    defaultRangePct: 20,
    costShare: 0.1,
    elasticity: 1,
  },
]

export type DriverRangeMap = Partial<Record<CostDriverId, number>>

export type TornadoBar = {
  driverId: CostDriverId
  label: string
  lowCostM: number
  highCostM: number
  /** Absolute swing |high − low|. */
  swingM: number
  lowDeltaM: number
  highDeltaM: number
  rangePct: number
}

export type CostMcBin = { label: string; lo: number; hi: number; count: number }

export type CostSensitivityResult = {
  runAt: string
  baselineCostM: number
  trials: number
  seed: number
  ranges: Record<CostDriverId, number>
  tornado: TornadoBar[]
  /** Sorted ascending cost samples ($M). */
  samples: number[]
  p10: number
  p50: number
  p90: number
  mean: number
  min: number
  max: number
  histogram: CostMcBin[]
}

export type CostSensitivityParams = {
  trials?: number
  seed?: number
  /** Override ±% range per driver (defaults from COST_DRIVERS). */
  ranges?: DriverRangeMap
}

const DEFAULT_TRIALS = 300

/** Mulberry32 — same PRNG family as DES-lite. */
function mulberry32(seed: number): () => number {
  let t = seed >>> 0
  return () => {
    t = (t + 0x6d2b79f5) >>> 0
    let r = Math.imul(t ^ (t >>> 15), 1 | t)
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r)
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

function resolveRanges(overrides?: DriverRangeMap): Record<CostDriverId, number> {
  const out = {} as Record<CostDriverId, number>
  for (const d of COST_DRIVERS) {
    const v = overrides?.[d.id]
    out[d.id] =
      v != null && Number.isFinite(v)
        ? Math.max(1, Math.min(80, Math.abs(v)))
        : d.defaultRangePct
  }
  return out
}

/**
 * Cost delta ($M) when a single driver moves by pct (can be negative).
 * Drivers are additive shocks on disjoint-ish shares (fuel sits inside transport
 * conceptually but we keep shares as planning factors — intentional overlap is OK
 * for tornado ranking).
 */
export function driverCostDeltaM(
  baselineM: number,
  driver: CostDriverDef,
  pct: number,
): number {
  return baselineM * driver.costShare * driver.elasticity * (pct / 100)
}

/** Total cost when every driver is at its pct map (0 = baseline). */
export function costWithShocks(
  baselineM: number,
  shocksPct: Partial<Record<CostDriverId, number>>,
): number {
  let total = baselineM
  for (const d of COST_DRIVERS) {
    const pct = shocksPct[d.id] ?? 0
    if (pct === 0) continue
    total += driverCostDeltaM(baselineM, d, pct)
  }
  return Math.round(total * 1000) / 1000
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0
  const ix = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(p * sorted.length) - 1),
  )
  return sorted[ix]
}

function buildHistogram(samples: number[], baselineM: number): CostMcBin[] {
  if (!samples.length) return []
  const min = samples[0]
  const max = samples[samples.length - 1]
  const span = Math.max(max - min, baselineM * 0.02, 0.2)
  const binCount = 8
  const width = span / binCount
  const lo0 = min
  const bins: CostMcBin[] = []
  for (let i = 0; i < binCount; i++) {
    const lo = lo0 + i * width
    const hi = lo0 + (i + 1) * width
    const label =
      i === binCount - 1
        ? `$${lo.toFixed(1)}+`
        : `$${lo.toFixed(1)}–${hi.toFixed(1)}`
    bins.push({ label, lo, hi, count: 0 })
  }
  for (const s of samples) {
    let idx = Math.floor((s - lo0) / width)
    if (idx < 0) idx = 0
    if (idx >= binCount) idx = binCount - 1
    bins[idx].count += 1
  }
  return bins
}

/** One-at-a-time tornado bars, sorted by swing descending. */
export function buildTornado(
  baselineM: number,
  ranges: Record<CostDriverId, number>,
): TornadoBar[] {
  const bars: TornadoBar[] = COST_DRIVERS.map((d) => {
    const rangePct = ranges[d.id]
    const lowCostM =
      Math.round(costWithShocks(baselineM, { [d.id]: -rangePct }) * 100) / 100
    const highCostM =
      Math.round(costWithShocks(baselineM, { [d.id]: rangePct }) * 100) / 100
    return {
      driverId: d.id,
      label: d.label,
      lowCostM,
      highCostM,
      swingM: Math.round(Math.abs(highCostM - lowCostM) * 100) / 100,
      lowDeltaM: Math.round((lowCostM - baselineM) * 100) / 100,
      highDeltaM: Math.round((highCostM - baselineM) * 100) / 100,
      rangePct,
    }
  })
  bars.sort((a, b) => b.swingM - a.swingM)
  return bars
}

/**
 * Run tornado + Monte Carlo cost sensitivity for a scenario's cost KPI.
 */
export function runCostSensitivity(args: {
  scenario: Scenario
  params?: CostSensitivityParams
}): CostSensitivityResult {
  const baselineCostM = parseMoneyM(args.scenario.kpis.cost.value)
  const trials = Math.max(
    50,
    Math.min(2000, args.params?.trials ?? DEFAULT_TRIALS),
  )
  const seed = args.params?.seed ?? 42
  const ranges = resolveRanges(args.params?.ranges)
  const rng = mulberry32(seed)

  const tornado = buildTornado(baselineCostM, ranges)

  const samples: number[] = []
  for (let t = 0; t < trials; t++) {
    const shocks: Partial<Record<CostDriverId, number>> = {}
    for (const d of COST_DRIVERS) {
      const r = ranges[d.id]
      // Uniform in [−r, +r]
      shocks[d.id] = -r + rng() * (2 * r)
    }
    samples.push(costWithShocks(baselineCostM, shocks))
  }

  const sorted = [...samples].sort((a, b) => a - b)
  const mean =
    Math.round(
      (sorted.reduce((s, x) => s + x, 0) / Math.max(1, sorted.length)) * 100,
    ) / 100
  const p10 = Math.round(percentile(sorted, 0.1) * 100) / 100
  const p50 = Math.round(percentile(sorted, 0.5) * 100) / 100
  const p90 = Math.round(percentile(sorted, 0.9) * 100) / 100
  const min = Math.round(sorted[0] * 100) / 100
  const max = Math.round(sorted[sorted.length - 1] * 100) / 100

  return {
    runAt: new Date().toISOString(),
    baselineCostM,
    trials,
    seed,
    ranges,
    tornado,
    samples: sorted.map((x) => Math.round(x * 100) / 100),
    p10,
    p50,
    p90,
    mean,
    min,
    max,
    histogram: buildHistogram(sorted, baselineCostM),
  }
}

/** Default editable ranges for UI. */
export function defaultDriverRanges(): Record<CostDriverId, number> {
  return resolveRanges()
}

/** Apply ranges inspired by named sensitivity presets. */
export function rangesFromPresetHint(
  presetId: 'fuel-20' | 'tariff-duty' | 'demand-shift' | 'balanced',
): DriverRangeMap {
  if (presetId === 'fuel-20') {
    return { fuel: 20, 'transport-rate': 10 }
  }
  if (presetId === 'tariff-duty') {
    return { tariff: 25 }
  }
  if (presetId === 'demand-shift') {
    return { 'demand-volume': 15, 'transport-rate': 10 }
  }
  // balanced — restore defaults
  const out: DriverRangeMap = {}
  for (const d of COST_DRIVERS) out[d.id] = d.defaultRangePct
  return out
}
