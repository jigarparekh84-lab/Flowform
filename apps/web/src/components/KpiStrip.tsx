import { useMemo } from 'react'
import { formatCo2Kt } from '../data/emissions'
import {
  computeInventoryRollup,
  formatInvDollars,
  formatInvUnits,
} from '../data/inventoryPolicy'
import type { KpiCell, KpiSnapshot } from '../data/sampleNetwork'
import { useFlowform } from '../state/FlowformContext'

type Props = {
  kpis: KpiSnapshot
}

const CORE: { key: keyof KpiSnapshot; label: string }[] = [
  { key: 'cost', label: 'Cost' },
  { key: 'service', label: 'Service' },
  { key: 'capex', label: 'CapEx' },
  { key: 'co2', label: 'CO₂' },
  { key: 'risk', label: 'Risk' },
]

export function KpiStrip({ kpis }: Props) {
  const { computedCo2Kt, lanes, nodes, inventoryPolicies, network, activeScenario } =
    useFlowform()

  const liveInv = useMemo(() => {
    if (kpis.inventory && kpis.invUnits) {
      return { inventory: kpis.inventory, invUnits: kpis.invUnits }
    }
    // Live preview from current policies (even before Apply)
    if (inventoryPolicies.nodes.length === 0) return null
    const rollup = computeInventoryRollup(inventoryPolicies, network)
    return {
      inventory: {
        value: formatInvDollars(rollup.totalDollars),
        delta: activeScenario.inventoryRollup
          ? inventoryPolicies.formula === 'simple'
            ? 'simple'
            : 'ASCM'
          : 'preview',
        better: true,
      } satisfies KpiCell,
      invUnits: {
        value: formatInvUnits(rollup.totalUnits),
        delta: `${rollup.nodes.length} sites`,
        better: true,
      } satisfies KpiCell,
    }
  }, [kpis, inventoryPolicies, network, activeScenario.inventoryRollup])

  const display = useMemo(() => {
    let next: KpiSnapshot = { ...kpis }
    // D-05: when KPIs come from the MIP, CO₂ is the modelled transport CO₂
    // (same tonnes the carbon price uses). The factor estimate is only a
    // fallback for scenarios that were never solved.
    const fromApi =
      !!activeScenario.optimizeMeta?.objectiveBreakdown || activeScenario.kpiSource === 'api'
    if (!fromApi && lanes.length > 0 && nodes.length > 0) {
      next = {
        ...next,
        co2: {
          ...kpis.co2,
          value: formatCo2Kt(computedCo2Kt),
          delta: kpis.co2.delta === '—' ? 'from factors' : kpis.co2.delta,
        },
      }
    }
    if (liveInv) {
      next = {
        ...next,
        inventory: liveInv.inventory,
        invUnits: liveInv.invUnits,
      }
    }
    return next
  }, [kpis, computedCo2Kt, lanes.length, nodes.length, liveInv, activeScenario.optimizeMeta, activeScenario.kpiSource])

  const order: { key: keyof KpiSnapshot; label: string }[] = [
    ...CORE,
    ...(display.inventory ? [{ key: 'inventory' as const, label: 'Inv $' }] : []),
    ...(display.invUnits ? [{ key: 'invUnits' as const, label: 'Inv units' }] : []),
  ]

  return (
    <div className="kpi-strip" role="group" aria-label="Scenario KPIs">
      {order.map(({ key, label }) => {
        const cell = display[key]
        if (!cell) return null
        const deltaClass =
          cell.delta === '—' ||
          cell.delta === 'from factors' ||
          cell.delta === 'preview' ||
          cell.delta === 'simple' ||
          cell.delta === 'ASCM' ||
          cell.delta.endsWith('sites') ||
          cell.delta.includes('SPOF')
            ? cell.delta.includes('SPOF') && !cell.better
              ? 'down'
              : 'neutral'
            : cell.better
              ? 'up'
              : 'down'
        return (
          <div key={key} className="kpi-card">
            <span className="kpi-label">{label}</span>
            <span className="kpi-value">{cell.value}</span>
            <span className={`kpi-delta ${deltaClass}`}>{cell.delta}</span>
          </div>
        )
      })}
    </div>
  )
}
