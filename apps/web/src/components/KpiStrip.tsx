import type { KpiSnapshot } from '../data/sampleNetwork'

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
  return (
    <div className="kpi-strip" role="group" aria-label="Scenario KPIs">
      {ORDER.map(({ key, label }) => {
        const cell = kpis[key]
        const deltaClass =
          cell.delta === '—'
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
