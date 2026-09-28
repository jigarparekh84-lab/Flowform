/**
 * Stochastic / robust scenario-tree optimize helpers + default demand shocks.
 */

import type {
  ApiStochasticResponse,
  StochasticObjective,
  StochasticScenarioInput,
} from './optimizeApi'
import type { Scenario } from './sampleNetwork'

export type StochasticOptimizeResult = {
  ok: boolean
  status: string
  objective: string
  cvarAlpha?: number | null
  solveSeconds?: number
  firstStage: {
    openIds: string[]
    capexM: number
    opexM: number
    fixedCostM?: number
  }
  scenarios: {
    id: string
    name: string
    probability: number
    demandScale?: number
    costScale?: number
    totalCostM: number
    transportM: number
    servicePct: number
    openIds: string[]
    flowsSummary?: { arcCount: number; totalVolume: number }
  }[]
  objectiveValueM: number
  expectedCostM: number
  worstCostM: number
  evpi?: {
    hereAndNowExpectedM: number
    waitAndSeeExpectedM: number | null
    evpiGapM: number | null
    stableWaitAndSeeOpenIds?: string[]
    robustOpenIds?: string[]
    waitAndSeeByScenario?: {
      id: string
      name: string
      openIds: string[]
      costM: number | null
    }[]
  } | null
  log: string[]
  ranAt: string
}

/** Built-in demand/cost shocks for Robust optimize when no chips selected. */
export const DEFAULT_DEMAND_SHOCKS: StochasticScenarioInput[] = [
  {
    id: 'base',
    name: 'Base demand',
    probability: 0.4,
    demandScale: 1.0,
    costScale: 1.0,
  },
  {
    id: 'soft',
    name: 'Soft −15%',
    probability: 0.3,
    demandScale: 0.85,
    costScale: 1.0,
  },
  {
    id: 'surge',
    name: 'Surge +25%',
    probability: 0.3,
    demandScale: 1.25,
    costScale: 1.0,
  },
]

/**
 * Map Compare / Scenario chips to demand shocks.
 * Uses name heuristics for sensitivity presets; otherwise equal-prob mild scales.
 */
export function shocksFromScenarioChips(
  selected: Scenario[],
): StochasticScenarioInput[] {
  const picked = selected.slice(0, 5)
  if (picked.length < 2) return DEFAULT_DEMAND_SHOCKS

  return picked.map((s, i) => {
    const name = s.name.toLowerCase()
    let demandScale = 1.0
    let costScale = 1.0
    let label = s.name
    if (name.includes('fuel')) {
      costScale = 1.2
      label = `${s.name} (cost ×1.2)`
    } else if (name.includes('demand') || name.includes('shift')) {
      demandScale = 1.15
      label = `${s.name} (demand ×1.15)`
    } else if (name.includes('outage')) {
      demandScale = 1.0
      costScale = 1.05
      label = `${s.name} (cost ×1.05)`
    } else if (name.includes('tariff') || name.includes('duty')) {
      costScale = 1.1
      label = `${s.name} (cost ×1.1)`
    } else if (s.id === 'baseline' || name.includes('baseline')) {
      demandScale = 1.0
      label = `${s.name} (base)`
    } else {
      // Mild spread for unnamed chips so tree is not identical
      const spreads = [0.9, 1.0, 1.1, 1.2, 0.95]
      demandScale = spreads[i % spreads.length]
      label = `${s.name} (×${demandScale})`
    }
    return {
      id: s.id,
      name: label,
      probability: 1 / picked.length,
      demandScale,
      costScale,
    }
  })
}

export function apiToStochasticResult(
  api: ApiStochasticResponse,
): StochasticOptimizeResult {
  return {
    ok: api.ok,
    status: api.status,
    objective: String(api.objective),
    cvarAlpha: api.cvarAlpha,
    solveSeconds: api.solveSeconds,
    firstStage: {
      openIds: api.firstStage?.openIds ?? api.openedIds ?? [],
      capexM: api.firstStage?.capexM ?? 0,
      opexM: api.firstStage?.opexM ?? 0,
      fixedCostM: api.firstStage?.fixedCostM,
    },
    scenarios: (api.scenarios ?? []).map((r) => ({
      id: r.id,
      name: r.name,
      probability: r.probability,
      demandScale: r.demandScale,
      costScale: r.costScale,
      totalCostM: r.totalCostM,
      transportM: r.transportM,
      servicePct: r.servicePct,
      openIds: r.openIds,
      flowsSummary: r.flowsSummary
        ? {
            arcCount: r.flowsSummary.arcCount,
            totalVolume: r.flowsSummary.totalVolume,
          }
        : undefined,
    })),
    objectiveValueM: api.objectiveValueM,
    expectedCostM: api.expectedCostM,
    worstCostM: api.worstCostM,
    evpi: api.evpi
      ? {
          hereAndNowExpectedM: api.evpi.hereAndNowExpectedM,
          waitAndSeeExpectedM: api.evpi.waitAndSeeExpectedM,
          evpiGapM: api.evpi.evpiGapM,
          stableWaitAndSeeOpenIds: api.evpi.stableWaitAndSeeOpenIds,
          robustOpenIds: api.evpi.robustOpenIds,
          waitAndSeeByScenario: api.evpi.waitAndSeeByScenario?.map((w) => ({
            id: w.id,
            name: w.name,
            openIds: w.openIds,
            costM: w.costM,
          })),
        }
      : null,
    log: api.log ?? [],
    ranAt: new Date().toLocaleString(),
  }
}

export function formatStochasticBriefSection(
  result: StochasticOptimizeResult,
): string {
  const lines: string[] = [
    '## Robust / stochastic optimize',
    '',
    `- Objective: **${result.objective}**` +
      (result.cvarAlpha != null ? ` (α=${result.cvarAlpha})` : ''),
    `- First-stage opens (stable): ${result.firstStage.openIds.join(', ') || '—'}`,
    `- E[cost]: $${result.expectedCostM.toFixed(2)}M · worst: $${result.worstCostM.toFixed(2)}M · obj: $${result.objectiveValueM.toFixed(2)}M`,
  ]
  if (result.evpi?.evpiGapM != null) {
    lines.push(
      `- EVPI-ish gap: $${result.evpi.evpiGapM.toFixed(2)}M (HN $${result.evpi.hereAndNowExpectedM.toFixed(2)}M − WS $${(result.evpi.waitAndSeeExpectedM ?? 0).toFixed(2)}M)`,
    )
  }
  lines.push('', '| Scenario | p | Cost $M | Service |', '|---|---:|---:|---:|')
  for (const s of result.scenarios) {
    lines.push(
      `| ${s.name} | ${(s.probability * 100).toFixed(0)}% | ${s.totalCostM.toFixed(2)} | ${s.servicePct.toFixed(1)}% |`,
    )
  }
  lines.push('')
  return lines.join('\n')
}

export const STOCHASTIC_OBJECTIVE_OPTIONS: {
  id: StochasticObjective
  label: string
  hint: string
}[] = [
  {
    id: 'expected',
    label: 'Expected cost',
    hint: 'Minimize fixed + probability-weighted variable cost',
  },
  {
    id: 'minimax',
    label: 'Minimax (robust)',
    hint: 'Minimize worst-scenario total cost',
  },
  {
    id: 'cvar_lite',
    label: 'CVaR-lite',
    hint: '(1−α)·E[cost] + α·worst',
  },
]
