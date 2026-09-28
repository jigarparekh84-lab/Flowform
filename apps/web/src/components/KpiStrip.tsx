import { useMemo } from 'react'
import { formatCo2Kt } from '../data/emissions'
import type { KpiSnapshot } from '../data/sampleNetwork'
import { useFlowform } from '../state/FlowformContext'

type Props = {
  kpis: KpiSnapshot
}

const ORDER: { key: keyof KpiSnapshot; label: string }[] = [
  { key: 'cost', label: 'Cost' },
  { key: 'service', label: 'Service' },
  { key: 'capex', label: 'CapEx' },
  { key: 'co2', label: 'CO₂' },
  { key: 'risk', label: 'Risk' },
]

export function KpiStrip({ kpis }: Props) {
  const { computedCo2Kt, lanes, nodes } = useFlowform()
  const display = useMemo(() => {
    // When lanes + nodes exist, prefer factor-based CO₂ over static KPI.
    if (lanes.length === 0 || nodes.length === 0) return kpis
    return {
      ...kpis,
      co2: {
        ...kpis.co2,
        value: formatCo2Kt(computedCo2Kt),
        delta: kpis.co2.delta === '—' ? 'from factors' : kpis.co2.delta,
      },
    }
  }, [kpis, computedCo2Kt, lanes.length, nodes.length])

  return (
    <div className="kpi-strip" role="group" aria-label="Scenario KPIs">
      {ORDER.map(({ key, label }) => {
        const cell = display[key]
        const deltaClass =
          cell.delta === '—' || cell.delta === 'from factors'
            ? 'neutral'
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
