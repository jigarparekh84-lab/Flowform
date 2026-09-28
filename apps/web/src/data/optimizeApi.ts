/**
 * Client for Flowform Optimize API (apps/api).
 * Falls back to client heuristic when unreachable.
 */

import type { UploadedNetwork } from './csvParsers'
import type { NetworkConstraints, Scenario } from './sampleNetwork'

export const DEFAULT_API_BASE =
  (typeof import.meta !== 'undefined' &&
    (import.meta as ImportMeta & { env?: { VITE_API_URL?: string } }).env
      ?.VITE_API_URL) ||
  'http://127.0.0.1:5182'

export type ApiOptimizeResponse = {
  ok: boolean
  solver: string
  status: string
  openedIds: string[]
  closedIds: string[]
  keptOpenIds: string[]
  openIds?: string[]
  flows: {
    from: string
    to: string
    volume: number
    miles?: number
  }[]
  kpis: {
    servicePct: number
    capexUsedM: number
    costM: number
    co2Kt: number
    uncoveredDemand: number
    targetPct?: number
  }
  log: string[]
}

export async function checkApiHealth(
  baseUrl: string = DEFAULT_API_BASE,
  timeoutMs = 1200,
): Promise<boolean> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/health`, {
      signal: ctrl.signal,
    })
    if (!res.ok) return false
    const body = (await res.json()) as { status?: string }
    return body.status === 'ok'
  } catch {
    return false
  } finally {
    clearTimeout(t)
  }
}

export async function postOptimize(args: {
  network: UploadedNetwork
  constraints: NetworkConstraints
  reference: Scenario
  baseUrl?: string
}): Promise<ApiOptimizeResponse> {
  const base = (args.baseUrl ?? DEFAULT_API_BASE).replace(/\/$/, '')
  const res = await fetch(`${base}/optimize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      network: {
        nodes: args.network.nodes,
        lanes: args.network.lanes,
        demandVolume: args.network.demandVolume,
      },
      constraints: args.constraints,
      reference: {
        id: args.reference.id,
        name: args.reference.name,
        kpis: args.reference.kpis,
      },
    }),
  })
  if (!res.ok) {
    let detail = res.statusText
    try {
      const err = (await res.json()) as { detail?: string }
      if (err.detail) detail = err.detail
    } catch {
      /* ignore */
    }
    throw new Error(`API optimize ${res.status}: ${detail}`)
  }
  return (await res.json()) as ApiOptimizeResponse
}
