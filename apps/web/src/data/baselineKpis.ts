/**
 * Baseline KPIs computed from the actual current network (API `baseline`
 * block: existing sites open, candidates closed, no decisions) instead of the
 * hard-coded $48.2M seed.
 */
import type { KpiSnapshot } from './sampleNetwork'

export type ApiBaselineBlock = {
  status: string
  openIds?: string[]
  kpis?: {
    servicePct: number
    capexUsedM: number
    costM: number
    co2Kt: number
  } | null
}

export function baselineKpisFromApi(b: ApiBaselineBlock | null | undefined): KpiSnapshot | null {
  if (!b || b.status !== 'Optimal' || !b.kpis) return null
  const k = b.kpis
  const risk = k.servicePct >= 96 ? 'Low' : k.servicePct >= 92 ? 'Med' : 'High'
  return {
    cost: { value: `$${k.costM.toFixed(1)}M`, delta: '—', better: true },
    service: { value: `${k.servicePct.toFixed(1)}%`, delta: '—', better: true },
    capex: { value: `$${k.capexUsedM.toFixed(0)}M`, delta: '—', better: true },
    co2: { value: `${k.co2Kt.toFixed(1)} kt`, delta: '—', better: true },
    risk: { value: risk, delta: '—', better: true },
  }
}

/** Percent delta helper shared with kpisFromApi. */
export function pctDelta(value: number, ref: number): number {
  return ref ? ((value - ref) / ref) * 100 : 0
}
