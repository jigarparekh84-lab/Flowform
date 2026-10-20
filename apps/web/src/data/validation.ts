/**
 * Pre-run guardrails client (FF-108) — POST /optimize/validate, plus helpers to
 * turn infeasibility hints into shortfall tables.
 */
import { DEFAULT_API_BASE } from './apiBase'

export type ValidationIssue = {
  code: string
  level: 'error' | 'warning'
  message: string
  entities: string[]
  fix: string | null
}

export type LaneShortfallRow = {
  laneId?: string
  from?: string
  to?: string
  customerId?: string
  name?: string
  capacityUnits?: number
  inboundLaneCapacity?: number
  requiredFlow?: number
  demand?: number
  shortBy: number
  laneIds?: string[]
}

export type MinThroughputShortfallRow = {
  facilityId: string
  capacityMin: number
  feasibleThroughput: number
  gap: number
}

export type ValidationResult = {
  ok: boolean
  blocking: boolean
  errorCount: number
  warningCount: number
  issues: ValidationIssue[]
  shortfalls: { laneCapacity: LaneShortfallRow[]; minThroughput: MinThroughputShortfallRow[] }
}

export type ShortfallHint = {
  code: string
  shortfalls?: Record<string, unknown>[]
}

export async function postValidate(
  body: { network: unknown; constraints: unknown },
  opts: { baseUrl?: string; deep?: boolean } = {},
): Promise<ValidationResult> {
  const base = (opts.baseUrl ?? DEFAULT_API_BASE).replace(/\/$/, '')
  const res = await fetch(`${base}/optimize/validate${opts.deep ? '?deep=true' : ''}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`validate HTTP ${res.status}`)
  return (await res.json()) as ValidationResult
}

/** One-line reason for the Run button / status bar. */
export function blockingReason(v: ValidationResult): string {
  const errs = v.issues.filter((i) => i.level === 'error')
  if (!errs.length) return ''
  const first = errs[0]
  const more = errs.length > 1 ? ` (+${errs.length - 1} more)` : ''
  return `Run blocked — ${first.message}${first.fix ? ` Fix: ${first.fix}` : ''}${more}`
}

/** Split infeasibility-hint shortfalls into the two tables the UI shows. */
export function shortfallTables(hints: ShortfallHint[] | undefined): {
  laneCapacity: LaneShortfallRow[]
  minThroughput: MinThroughputShortfallRow[]
} {
  const laneCapacity: LaneShortfallRow[] = []
  const minThroughput: MinThroughputShortfallRow[] = []
  for (const h of hints ?? []) {
    for (const s of h.shortfalls ?? []) {
      if ('laneId' in s) laneCapacity.push(s as unknown as LaneShortfallRow)
      else if ('facilityId' in s) minThroughput.push(s as unknown as MinThroughputShortfallRow)
    }
  }
  return { laneCapacity, minThroughput }
}
