/**
 * Depth slice 8 — "why was this site opened / closed" explain cards.
 * Data comes from the MIP explain block (API explain=true): real HiGHS
 * capacity duals, cost-to-serve and counterfactual re-solves.
 */
import type {
  OptimizeExplain,
  OptimizeExplainFacility,
  OptimizeExplainReason,
  Scenario,
} from '../data/sampleNetwork'

/** Format a model-$M amount: $1.2M · $340k · $12. */
export function fmtM(v: number | null | undefined, signed = false): string {
  if (v == null || !Number.isFinite(v)) return '—'
  const a = Math.abs(v)
  const sign = v < 0 ? '−' : signed ? '+' : ''
  if (a >= 100) return `${sign}$${a.toLocaleString(undefined, { maximumFractionDigits: 0 })}M`
  if (a >= 1) return `${sign}$${a.toFixed(1)}M`
  if (a >= 0.01) return `${sign}$${(a * 1000).toFixed(0)}k`
  if (a >= 0.001) return `${sign}$${(a * 1000).toFixed(1)}k`
  return `${sign}$${(a * 1e6).toFixed(0)}`
}

const DECISION_LABEL: Record<OptimizeExplainFacility['decision'], string> = {
  opened: 'Opened',
  'kept-open': 'Kept open',
  closed: 'Closed',
  'kept-closed': 'Kept closed',
}

export function DecisionBadge({ fx }: { fx: OptimizeExplainFacility }) {
  return (
    <span className={`explain-badge dec-${fx.decision}`}>
      {DECISION_LABEL[fx.decision] ?? fx.decision}
      {fx.locked ? ' · locked' : ''}
    </span>
  )
}

function ReasonList({
  reasons,
  limit,
}: {
  reasons: OptimizeExplainReason[]
  limit?: number
}) {
  const rows = limit ? reasons.slice(0, limit) : reasons
  return (
    <ol className="explain-reasons">
      {rows.map((r, i) => (
        <li key={i} className={`tone-${r.tone}`}>
          <span className="explain-reason-kind" aria-hidden>
            {r.tone === 'risk' ? '!' : r.tone === 'support' ? '✓' : 'i'}
          </span>
          <span>{r.text}</span>
        </li>
      ))}
    </ol>
  )
}

/** Flip-cost chip: $ penalty of flipping the decision + service impact. */
export function FlipChip({ fx }: { fx: OptimizeExplainFacility }) {
  const cf = fx.counterfactual
  if (!cf?.evaluated) {
    return <span className="explain-flip muted">flip not evaluated</span>
  }
  if (cf.status === 'infeasible') {
    return <span className="explain-flip flip-hard">flip infeasible</span>
  }
  const verb = fx.open ? 'Close' : 'Open'
  const du = cf.unservedDeltaUnits ?? 0
  const op = cf.operatingDeltaM ?? cf.deltaM ?? 0
  const svc =
    cf.serviceDeltaPct != null && Math.abs(cf.serviceDeltaPct) > 0.05
      ? ` · service ${cf.servicePct?.toFixed(1)}%`
      : ''
  const title = `Objective Δ ${fmtM(cf.deltaM, true)} (incl. unmet-demand penalty ${fmtM(cf.penaltyDeltaM ?? 0, true)}) · re-solve ${cf.seconds?.toFixed(2)}s · ${cf.status}`
  const tone =
    du > 0.5 || (cf.deltaM ?? 0) > 0 ? (cf.withinGap ? 'flip-soft' : 'flip-hard') : 'flip-soft'
  return (
    <span className={`explain-flip ${tone}`} title={title}>
      {verb}: {du > 0.5 ? `strands ${Math.round(du).toLocaleString()} u · ` : ''}
      {fmtM(op, true)} op. cost{svc}
    </span>
  )
}

export function FacilityExplainCard({
  fx,
  explain,
  nameOf,
}: {
  fx: OptimizeExplainFacility
  explain: OptimizeExplain
  nameOf?: (id: string) => string
}) {
  const cf = fx.counterfactual
  const name = (id: string) => nameOf?.(id) ?? id
  return (
    <section className="explain-card" aria-label={`Why ${fx.name} is ${fx.open ? 'open' : 'closed'}`}>
      <header className="explain-card-head">
        <div>
          <p className="explain-kicker">Why this site?</p>
          <h3>{fx.name}</h3>
        </div>
        <DecisionBadge fx={fx} />
      </header>
      <p className="explain-headline">{fx.headline}</p>
      <ReasonList reasons={fx.reasons.slice(1)} limit={4} />
      <dl className="explain-metrics">
        <div>
          <dt>Fixed cost</dt>
          <dd>
            {fmtM(fx.fixedCostM)}
            <span className="muted tiny">
              {' '}
              CapEx {fmtM(fx.fixedCapexM)} + OpEx {fmtM(fx.fixedOpexM)}
            </span>
          </dd>
        </div>
        {fx.open && (
          <>
            <div>
              <dt>Throughput cost</dt>
              <dd>
                {fmtM(fx.variableCostM)}
                <span className="muted tiny">
                  {' '}
                  in {fmtM(fx.inboundTransportM)} · out {fmtM(fx.outboundTransportM)}
                </span>
              </dd>
            </div>
            <div>
              <dt>Utilization</dt>
              <dd>
                <span className="explain-util">
                  <span
                    className="explain-util-bar"
                    style={{ width: `${Math.min(100, fx.utilizationPct)}%` }}
                  />
                </span>
                {fx.utilizationPct.toFixed(0)}%
                <span className="muted tiny">
                  {' '}
                  {Math.round(fx.throughput).toLocaleString()} /{' '}
                  {fx.capacityMax >= 1e8 ? '∞' : Math.round(fx.capacityMax).toLocaleString()}
                </span>
              </dd>
            </div>
            <div>
              <dt>Demand served</dt>
              <dd>
                {fx.demandSharePct.toFixed(1)}%
                <span className="muted tiny"> · {fx.customersServed} customers</span>
              </dd>
            </div>
            <div>
              <dt>Cost-to-serve</dt>
              <dd>
                {fmtM(fx.costToServeM)}
                <span className="muted tiny">
                  {' '}
                  {fx.costToServeSharePct.toFixed(1)}% of network
                  {fx.landedCostRank ? ` · rank #${fx.landedCostRank}` : ''}
                </span>
              </dd>
            </div>
          </>
        )}
        {!fx.open && (
          <div>
            <dt>Reachable demand</dt>
            <dd>{fx.reachableDemandPct.toFixed(0)}%</dd>
          </div>
        )}
        <div>
          <dt>Capacity dual</dt>
          <dd>
            {fx.capacityDual == null
              ? '—'
              : fx.capacityDual === 0
                ? '0 (slack)'
                : `${fmtM(-fx.capacityDual)} / unit`}
            {fx.capacityBinding && <span className="explain-pill">binding</span>}
          </dd>
        </div>
        <div>
          <dt>Flip penalty</dt>
          <dd>
            <FlipChip fx={fx} />
          </dd>
        </div>
      </dl>
      {cf?.evaluated && ((cf.alsoOpens?.length ?? 0) > 0 || (cf.alsoCloses?.length ?? 0) > 0) && (
        <p className="muted tiny explain-ripple">
          Re-solve ripple:
          {(cf.alsoOpens ?? []).length > 0 && ` opens ${(cf.alsoOpens ?? []).map(name).join(', ')}`}
          {(cf.alsoCloses ?? []).length > 0 && ` closes ${(cf.alsoCloses ?? []).map(name).join(', ')}`}
        </p>
      )}
      <p className="muted tiny explain-foot">
        MIP counterfactual: site forced {fx.open ? 'closed' : 'open'}, rest
        re-optimized{cf?.lockLifted ? ' (scenario lock lifted)' : ''} ·{' '}
        {explain.timing.counterfactualCount} re-solves in{' '}
        {explain.timing.counterfactualSeconds.toFixed(2)}s · duals: HiGHS LP
      </p>
    </section>
  )
}

function DecisionRow({ fx }: { fx: OptimizeExplainFacility }) {
  return (
    <li className="why-row">
      <div className="why-row-head">
        <strong>{fx.name}</strong>
        <DecisionBadge fx={fx} />
        <FlipChip fx={fx} />
      </div>
      <ReasonList reasons={fx.reasons} limit={3} />
    </li>
  )
}

/** Brief / Compare: "Why this network" — top opened/closed decisions. */
export function WhyThisNetwork({
  scenario,
  explain,
  limit = 4,
  title = 'Why this network',
}: {
  scenario?: Scenario
  explain: OptimizeExplain
  limit?: number
  title?: string
}) {
  const byId = new Map(explain.facilities.map((f) => [f.facilityId, f]))
  const opened = explain.topOpenedIds
    .map((id) => byId.get(id))
    .filter((f): f is OptimizeExplainFacility => !!f)
    .slice(0, limit)
  const closed = explain.topClosedIds
    .map((id) => byId.get(id))
    .filter((f): f is OptimizeExplainFacility => !!f)
    .slice(0, limit)
  return (
    <section className="library-card why-network" aria-label={title}>
      <header className="why-network-head">
        <div>
          <h2>{title}</h2>
          {scenario && <p className="muted tiny">{scenario.name}</p>}
        </div>
        <span className="muted tiny">
          base {fmtM(explain.baseCostM)} · service {explain.baseServicePct.toFixed(1)}% ·{' '}
          {explain.timing.counterfactualCount} counterfactuals
        </span>
      </header>
      <p className="explain-headline">{explain.headline}</p>
      <div className="why-columns">
        <div>
          <h3>Open sites — top by flip cost</h3>
          {opened.length ? (
            <ul className="why-list">
              {opened.map((fx) => (
                <DecisionRow key={fx.facilityId} fx={fx} />
              ))}
            </ul>
          ) : (
            <p className="muted tiny">No open decidable sites.</p>
          )}
        </div>
        <div>
          <h3>Closed sites — why not</h3>
          {closed.length ? (
            <ul className="why-list">
              {closed.map((fx) => (
                <DecisionRow key={fx.facilityId} fx={fx} />
              ))}
            </ul>
          ) : (
            <p className="muted tiny">Every candidate was opened — nothing left closed.</p>
          )}
        </div>
      </div>
    </section>
  )
}

/** Markdown lines for brief export. */
export function explainMarkdown(explain: OptimizeExplain, limit = 5): string[] {
  const lines = ['## Why this network', '', explain.headline, '']
  const byId = new Map(explain.facilities.map((f) => [f.facilityId, f]))
  const ids = [...explain.topOpenedIds.slice(0, limit), ...explain.topClosedIds.slice(0, limit)]
  for (const id of ids) {
    const fx = byId.get(id)
    if (!fx) continue
    const cf = fx.counterfactual
    const flip = cf?.evaluated
      ? cf.status === 'infeasible'
        ? 'flip infeasible'
        : `flip ${fmtM(cf.operatingDeltaM ?? cf.deltaM, true)} op. cost, service ${cf.servicePct?.toFixed(1)}%`
      : 'flip not evaluated'
    lines.push(`- **${fx.name}** — ${DECISION_LABEL[fx.decision]} (${flip})`)
    for (const r of fx.reasons.slice(0, 3)) lines.push(`  - ${r.text}`)
  }
  lines.push('')
  return lines
}
