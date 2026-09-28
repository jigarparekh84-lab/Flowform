/**
 * One-click sensitivity presets: create delta scenarios from Active.
 */

import {
  parseMoneyM,
  parsePercent,
  type KpiSnapshot,
  type Scenario,
} from './sampleNetwork'

export type SensitivityPresetId = 'fuel-20' | 'demand-shift' | 'node-outage'

export type SensitivityPreset = {
  id: SensitivityPresetId
  label: string
  description: string
  tag: string
}

export const SENSITIVITY_PRESETS: SensitivityPreset[] = [
  {
    id: 'fuel-20',
    label: 'Fuel +20%',
    description: 'Bump transport cost ~20%; slight CO₂ up from mode mix.',
    tag: 'Sensitivity',
  },
  {
    id: 'demand-shift',
    label: 'Demand shift East',
    description: 'East-heavy demand: service pressure, modest cost + CapEx.',
    tag: 'Sensitivity',
  },
  {
    id: 'node-outage',
    label: 'Node outage (DC)',
    description: 'Soft-close primary DC: service drop, cost + risk up.',
    tag: 'Sensitivity',
  },
]

function money(m: number): string {
  return `$${m.toFixed(1)}M`
}

function pct(p: number): string {
  return `${p.toFixed(1)}%`
}

function co2(kt: number): string {
  return `${kt.toFixed(1)} kt`
}

function deltaPct(from: number, to: number): string {
  if (from === 0) return '—'
  const d = ((to - from) / Math.abs(from)) * 100
  const sign = d > 0 ? '+' : '−'
  return `${sign}${Math.abs(d).toFixed(1)}%`
}

function deltaPp(from: number, to: number): string {
  const d = to - from
  const sign = d > 0 ? '+' : '−'
  return `${sign}${Math.abs(d).toFixed(1)}pp`
}

function parseCo2Kt(value: string): number {
  const m = value.replace(/,/g, '').match(/([\d.]+)/)
  return m ? parseFloat(m[1]) : 12.4
}

export function kpisForSensitivity(
  base: Scenario,
  presetId: SensitivityPresetId,
): KpiSnapshot {
  const cost0 = parseMoneyM(base.kpis.cost.value)
  const service0 = parsePercent(base.kpis.service.value)
  const capex0 = parseMoneyM(base.kpis.capex.value)
  const co20 = parseCo2Kt(base.kpis.co2.value)

  let cost = cost0
  let service = service0
  let capex = capex0
  let co2v = co20
  let risk = base.kpis.risk.value
  let riskBetter = true

  if (presetId === 'fuel-20') {
    // ~55% of cost is transport → +20% on that share ≈ +11% total
    cost = Math.round(cost0 * 1.11 * 10) / 10
    co2v = Math.round(co20 * 1.03 * 10) / 10
    risk = base.kpis.risk.value
  } else if (presetId === 'demand-shift') {
    cost = Math.round((cost0 + 1.4) * 10) / 10
    service = Math.round((service0 - 1.8) * 10) / 10
    capex = Math.round((capex0 + 4) * 10) / 10
    co2v = Math.round((co20 + 0.6) * 10) / 10
    risk = 'Med'
  } else if (presetId === 'node-outage') {
    cost = Math.round((cost0 + 2.8) * 10) / 10
    service = Math.round((service0 - 3.5) * 10) / 10
    capex = capex0
    co2v = Math.round((co20 + 1.1) * 10) / 10
    risk = 'High'
    riskBetter = false
  }

  return {
    cost: {
      value: money(cost),
      delta: deltaPct(cost0, cost),
      better: cost <= cost0,
    },
    service: {
      value: pct(service),
      delta: deltaPp(service0, service),
      better: service >= service0,
    },
    capex: {
      value: money(capex),
      delta:
        capex === capex0
          ? '—'
          : `${capex > capex0 ? '+' : '−'}$${Math.abs(capex - capex0).toFixed(1)}M`,
      better: capex <= capex0,
    },
    co2: {
      value: co2(co2v),
      delta: deltaPct(co20, co2v),
      better: co2v <= co20,
    },
    risk: {
      value: risk,
      delta: riskBetter ? '→' : '↑',
      better: riskBetter,
    },
  }
}

export function sensitivityScenarioName(
  base: Scenario,
  preset: SensitivityPreset,
): string {
  return `${base.name} · ${preset.label}`
}
