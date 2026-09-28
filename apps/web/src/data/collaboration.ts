/**
 * Collaboration stubs — per-scenario comments + read-only share pack.
 * Comments live in project localStorage (ProjectSnapshot.comments).
 */

import {
  exportProjectJson,
  type ProjectExportFile,
  type ProjectMeta,
  type ProjectSnapshot,
} from './projects'

export type ScenarioComment = {
  id: string
  scenarioId: string
  author: string
  /** ISO timestamp */
  createdAt: string
  body: string
}

export type SharePack = {
  format: 'flowform-share'
  version: 1
  readonly: true
  createdAt: string
  /** Deep-link stub (not a live server URL). */
  deepLink: string
  meta: Pick<ProjectMeta, 'id' | 'name'>
  /** Read-only project export embed. */
  project: ProjectExportFile
}

function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

export function commentsForScenario(
  comments: ScenarioComment[],
  scenarioId: string,
): ScenarioComment[] {
  return comments
    .filter((c) => c.scenarioId === scenarioId)
    .sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    )
}

export function addComment(
  comments: ScenarioComment[],
  args: { scenarioId: string; author: string; body: string },
): ScenarioComment[] {
  const body = args.body.trim()
  if (!body) return comments
  const next: ScenarioComment = {
    id: uid('cmt'),
    scenarioId: args.scenarioId,
    author: args.author.trim() || 'You',
    createdAt: new Date().toISOString(),
    body,
  }
  return [...comments, next]
}

export function deleteComment(
  comments: ScenarioComment[],
  id: string,
): ScenarioComment[] {
  return comments.filter((c) => c.id !== id)
}

/** Build a stub deep-link (clipboard). Not served by a backend. */
export function buildShareDeepLink(meta: ProjectMeta): string {
  const params = new URLSearchParams({
    v: '1',
    project: meta.id,
    name: meta.name,
    readonly: '1',
  })
  return `flowform://share?${params.toString()}`
}

export function buildSharePack(
  projectId: string,
  snapshotOverride?: ProjectSnapshot,
): SharePack | null {
  const project = exportProjectJson(projectId)
  if (!project) return null
  if (snapshotOverride) {
    project.state = snapshotOverride
  }
  const deepLink = buildShareDeepLink(project.meta)
  return {
    format: 'flowform-share',
    version: 1,
    readonly: true,
    createdAt: new Date().toISOString(),
    deepLink,
    meta: { id: project.meta.id, name: project.meta.name },
    project,
  }
}

export function downloadSharePack(pack: SharePack): void {
  const blob = new Blob([JSON.stringify(pack, null, 2)], {
    type: 'application/json',
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${pack.meta.name.replace(/[^\w.-]+/g, '_') || 'flowform'}.share.json`
  a.click()
  URL.revokeObjectURL(url)
}

export async function copyShareDeepLink(meta: ProjectMeta): Promise<boolean> {
  const link = buildShareDeepLink(meta)
  try {
    await navigator.clipboard.writeText(link)
    return true
  } catch {
    return false
  }
}

export function formatCommentWhen(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}
