/**
 * Depth 7 — helpers for MIP lane capacity + transport mode choice results
 * (Compare mode mix / binding lane chips, Network lane styling).
 */

import type {
  OptimizeLaneCapacityRow,
  OptimizeMeta,
} from './sampleNetwork'

export const MODE_COLORS: Record<string, string> = {
  truck: '#38bdf8',
  rail: '#34d399',
  intermodal: '#fbbf24',
  ocean: '#818cf8',
  air: '#f87171',
  parcel: '#c084fc',
}

export function modeColor(mode: string | null | undefined): string {
  return MODE_COLORS[String(mode ?? '').toLowerCase()] ?? '#94a3b8'
}

export function laneCapLabel(r: OptimizeLaneCapacityRow): string {
  const lane = r.laneId ?? `${r.from}→${r.to}`
  return r.mode ? `${lane} · ${r.mode}` : lane
}

/** Shadow prices are $M per unit; tiny values read better in exponent form. */
export function formatPi(pi: number | null | undefined): string {
  if (pi == null) return '—'
  if (pi === 0) return '0'
  return Math.abs(pi) < 0.001 ? pi.toExponential(1) : pi.toFixed(4)
}

export type MipLaneStyle = {
  utilizationPct: number | null
  binding: boolean
  volume: number
  modes: string
}

/** laneId → utilization / binding / mode split from the MIP result. */
export function mipLaneStyleMap(
  meta: OptimizeMeta | undefined | null,
): Map<string, MipLaneStyle> {
  const out = new Map<string, MipLaneStyle>()
  for (const row of meta?.laneUtilization ?? []) {
    if (!row.laneId) continue
    out.set(row.laneId, {
      utilizationPct: row.utilizationPct,
      binding: row.binding,
      volume: row.volume,
      modes: row.modes
        .filter((m) => m.volume > 0)
        .map((m) => `${m.mode} ${Math.round(m.volume).toLocaleString()}`)
        .join(' / '),
    })
  }
  return out
}

/** Stroke color for a lane given MIP utilization (null = keep default). */
export function mipLaneColor(style: MipLaneStyle | undefined): string | null {
  if (!style) return null
  if (style.binding) return '#f87171'
  if ((style.utilizationPct ?? 0) >= 80) return '#fbbf24'
  return null
}
