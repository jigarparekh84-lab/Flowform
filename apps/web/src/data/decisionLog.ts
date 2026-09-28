/**
 * Append-only decision / audit log for meaningful scenario actions.
 * Persisted on ProjectSnapshot.decisionLog (localStorage).
 */

export const DECISION_ACTOR_LOCAL = {
  id: 'local',
  name: 'Local user',
} as const

export type DecisionActor = {
  id: string
  name: string
}

export type DecisionActionType =
  | 'create_scenario'
  | 'activate_scenario'
  | 'run_optimize'
  | 'apply_hub'
  | 'apply_territory'
  | 'apply_roadmap'
  | 'optimize_timing'
  | 'apply_bom'
  | 'apply_bids'
  | 'apply_sensitivity'
  | 'handoff_export'
  | 'share'

export const DECISION_ACTION_TYPES: DecisionActionType[] = [
  'create_scenario',
  'activate_scenario',
  'run_optimize',
  'apply_hub',
  'apply_territory',
  'apply_roadmap',
  'optimize_timing',
  'apply_bom',
  'apply_bids',
  'apply_sensitivity',
  'handoff_export',
  'share',
]

export const DECISION_ACTION_LABELS: Record<DecisionActionType, string> = {
  create_scenario: 'Create scenario',
  activate_scenario: 'Activate scenario',
  run_optimize: 'Run optimize',
  apply_hub: 'Apply hub design',
  apply_territory: 'Apply territory',
  apply_roadmap: 'Apply roadmap',
  optimize_timing: 'Optimize CapEx timing',
  apply_bom: 'Apply BOM',
  apply_bids: 'Apply bids',
  apply_sensitivity: 'Apply sensitivity',
  handoff_export: 'Handoff export',
  share: 'Share',
}

export type DecisionLogEntry = {
  id: string
  /** ISO timestamp */
  at: string
  action: DecisionActionType
  summary: string
  scenarioId?: string
  actor: DecisionActor
}

export type DecisionLogExport = {
  format: 'flowform-decision-log'
  version: 1
  exportedAt: string
  projectId?: string
  projectName?: string
  entries: DecisionLogEntry[]
}

function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

export function appendDecisionEntry(
  log: DecisionLogEntry[],
  args: {
    action: DecisionActionType
    summary: string
    scenarioId?: string
    actor?: DecisionActor
    at?: string
  },
): DecisionLogEntry[] {
  const summary = args.summary.trim()
  if (!summary) return log
  const entry: DecisionLogEntry = {
    id: uid('dec'),
    at: args.at ?? new Date().toISOString(),
    action: args.action,
    summary,
    scenarioId: args.scenarioId,
    actor: args.actor ?? { ...DECISION_ACTOR_LOCAL },
  }
  return [...log, entry]
}

export function filterDecisionLog(
  log: DecisionLogEntry[],
  action: DecisionActionType | 'all',
): DecisionLogEntry[] {
  const filtered =
    action === 'all' ? log : log.filter((e) => e.action === action)
  return [...filtered].sort(
    (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime(),
  )
}

export function clearDecisionLog(): DecisionLogEntry[] {
  return []
}

export function buildDecisionLogExport(
  log: DecisionLogEntry[],
  meta?: { projectId?: string; projectName?: string },
): DecisionLogExport {
  return {
    format: 'flowform-decision-log',
    version: 1,
    exportedAt: new Date().toISOString(),
    projectId: meta?.projectId,
    projectName: meta?.projectName,
    entries: [...log],
  }
}

export function downloadDecisionLogJson(
  log: DecisionLogEntry[],
  meta?: { projectId?: string; projectName?: string; fileStem?: string },
): void {
  const payload = buildDecisionLogExport(log, meta)
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json',
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  const stem =
    meta?.fileStem ??
    (meta?.projectName
      ? meta.projectName.replace(/[^\w.-]+/g, '_')
      : 'flowform')
  a.download = `${stem || 'flowform'}.decision-log.json`
  a.click()
  URL.revokeObjectURL(url)
}

export function formatDecisionWhen(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  } catch {
    return iso
  }
}
