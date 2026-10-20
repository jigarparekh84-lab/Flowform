/**
 * Plain-language Run summary (FF-115). Deterministic templates over the Run
 * result — no AI, no invented numbers: every figure in a sentence comes from a
 * listed source field (unit-tested).
 */
import type { OptimizeMeta } from './sampleNetwork'

export type NarrativeSource = { field: string; value: number | string }
export type NarrativeSentence = { text: string; sources: NarrativeSource[] }
export type RunNarrative = { headline: string; sentences: NarrativeSentence[] }

export function fmtMoneyM(m: number): string {
  const a = Math.abs(m)
  if (a >= 1) return `$${m.toFixed(2)}M`
  return `$${Math.round(m * 1000)}k`
}
export const fmtPct = (p: number) => `${p.toFixed(1)}%`

const list = (xs: string[]) =>
  xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`

export function buildRunNarrative(
  meta: OptimizeMeta,
  nameOf: (id: string) => string = (id) => id,
): RunNarrative {
  const s: NarrativeSentence[] = []
  const bd = meta.objectiveBreakdown
  const infeasible = meta.status === 'Infeasible'

  if (infeasible) {
    const rep = meta.infeasibilityReport
    s.push({
      text: `The network can't be solved as set up${rep?.summary ? `: ${rep.summary}` : '.'}`,
      sources: [{ field: 'infeasibilityReport.summary', value: rep?.summary ?? '' }],
    })
    return { headline: 'No feasible network — fix the blocking constraint and run again.', sentences: s }
  }

  if (bd) {
    const parts = [`${fmtMoneyM(bd.transportM)} transport`, `${fmtMoneyM(bd.fixedOpexM)} site running cost`]
    const src: NarrativeSource[] = [
      { field: 'objectiveBreakdown.totalM', value: bd.totalM },
      { field: 'objectiveBreakdown.transportM', value: bd.transportM },
      { field: 'objectiveBreakdown.fixedOpexM', value: bd.fixedOpexM },
    ]
    if (bd.fixedCapexM > 0) {
      parts.push(`${fmtMoneyM(bd.fixedCapexM)} one-off investment`)
      src.push({ field: 'objectiveBreakdown.fixedCapexM', value: bd.fixedCapexM })
    }
    if (bd.uncoveredPenaltyM > 0) {
      parts.push(`${fmtMoneyM(bd.uncoveredPenaltyM)} penalty for unserved demand`)
      src.push({ field: 'objectiveBreakdown.uncoveredPenaltyM', value: bd.uncoveredPenaltyM })
    }
    s.push({ text: `The best network costs ${fmtMoneyM(bd.totalM)}: ${list(parts)}.`, sources: src })
  }

  s.push({
    text: `It serves ${fmtPct(meta.servicePct)} of demand.`,
    sources: [{ field: 'servicePct', value: meta.servicePct }],
  })

  const opened = meta.openedIds.map(nameOf)
  const closed = meta.closedIds.map(nameOf)
  const changes: string[] = []
  if (opened.length) changes.push(`open ${list(opened)}`)
  if (closed.length) changes.push(`close ${list(closed)}`)
  s.push({
    text: changes.length ? `Recommendation: ${changes.join(' and ')}.` : 'Recommendation: keep the current sites as they are.',
    sources: [
      { field: 'openedIds', value: meta.openedIds.join(',') },
      { field: 'closedIds', value: meta.closedIds.join(',') },
    ],
  })

  const ex = meta.explain
  if (ex?.facilities?.length) {
    const best = ex.facilities
      .filter((f) => f.open && f.tier !== 'plant' && f.flipCostM != null && f.flipCostM > 0)
      .sort((a, b) => (b.flipCostM ?? 0) - (a.flipCostM ?? 0))[0]
    if (best) {
      s.push({
        text: `Closing ${best.name} instead would add ${fmtMoneyM(best.flipCostM!)} to total cost.`,
        sources: [{ field: `explain.facilities[${best.facilityId}].flipCostM`, value: best.flipCostM! }],
      })
    }
  }

  const headline = bd
    ? `${changes.length ? 'Change' : 'Keep'} the network: ${fmtMoneyM(bd.totalM)} at ${fmtPct(meta.servicePct)} service.`
    : `Run complete: ${fmtPct(meta.servicePct)} service.`
  return { headline, sentences: s }
}

/** For tests: every numeric token in text must be a formatted source value. */
export function untracedNumbers(sent: NarrativeSentence): string[] {
  const allowed = new Set<string>()
  for (const src of sent.sources) {
    if (typeof src.value === 'number') {
      allowed.add(fmtMoneyM(src.value))
      allowed.add(fmtPct(src.value))
    } else {
      for (const t of String(src.value).match(/\$?\d[\d,.]*[MkK%]?/g) ?? []) allowed.add(t)
    }
  }
  const tokens = sent.text.match(/\$?\d[\d,.]*[Mk%]?/g) ?? []
  return tokens
    .map((t) => t.replace(/[.,]$/, ''))
    .filter((t) => ![...allowed].some((a) => a.replace(/[.,]$/, '') === t))
}
