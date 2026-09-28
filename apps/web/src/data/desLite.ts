/**
 * DES-lite — simple Monte Carlo service-level simulation.
 * Lead-time noise + demand noise → fill rate / late demand % for a scenario.
 * Not a full discrete-event simulator; intentionally lightweight for Compare.
 */

import type { UploadedNetwork } from './csvParsers'
import type {
  DesLiteResult,
  NetworkConstraints,
  NetworkLane,
  NetworkNode,
  Scenario,
} from './sampleNetwork'

export type { DesLiteResult }

export type DesLiteParams = {
  trials?: number
  /** Coefficient of variation on demand (e.g. 0.15 = ±15% typical). */
  demandNoise?: number
  /** Coefficient of variation on lead time. */
  leadNoise?: number
  /** Demand is late when realized lead exceeds this many days. */
  serviceTargetDays?: number
  seed?: number
}

const MILES_PER_UNIT = 12
const DEFAULT_TRIALS = 200
const DEFAULT_DEMAND_NOISE = 0.15
const DEFAULT_LEAD_NOISE = 0.2
const DEFAULT_SERVICE_DAYS = 5

/** Mulberry32 — deterministic PRNG from seed. */
function mulberry32(seed: number): () => number {
  let t = seed >>> 0
  return () => {
    t = (t + 0x6d2b79f5) >>> 0
    let r = Math.imul(t ^ (t >>> 15), 1 | t)
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r)
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

/** Box–Muller normal(0,1) from uniform RNG. */
function randn(rng: () => number): number {
  let u = 0
  let v = 0
  while (u === 0) u = rng()
  while (v === 0) v = rng()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

function parseVolume(capacity: string): number {
  const m = capacity.replace(/,/g, '').match(/([\d.]+)/)
  if (!m) return 1000
  let v = parseFloat(m[1])
  if (/k/i.test(capacity)) v *= 1000
  return v
}

function distMiles(a: NetworkNode, b: NetworkNode): number {
  return Math.hypot(a.x - b.x, a.y - b.y) * MILES_PER_UNIT
}

type Assignment = {
  demandId: string
  facilityId: string
  meanDemand: number
  meanLeadDays: number
  facilityCap: number
}

function openFacilityIds(
  nodes: NetworkNode[],
  constraints: NetworkConstraints,
  scenario: Scenario,
): Set<string> {
  const open = new Set<string>()
  const cmap = new Map(constraints.facilities.map((f) => [f.nodeId, f]))
  for (const n of nodes) {
    if (n.kind !== 'dc' && n.kind !== 'plant' && n.kind !== 'candidate') continue
    const st = cmap.get(n.id)?.status
    if (st === 'closed') continue
    if (st === 'open' || (st == null && n.kind !== 'candidate')) {
      open.add(n.id)
    }
  }
  // Optimize / compose overrides
  const meta = scenario.optimizeMeta
  if (meta) {
    for (const id of meta.closedIds) open.delete(id)
    for (const id of meta.openedIds) open.add(id)
  }
  if (open.size === 0) {
    for (const n of nodes) {
      if (n.kind === 'dc' || n.kind === 'plant') open.add(n.id)
    }
  }
  return open
}

function leadForPair(
  fromId: string,
  toId: string,
  lanes: NetworkLane[],
  from: NetworkNode,
  to: NetworkNode,
): number {
  const lane = lanes.find(
    (l) =>
      (l.from === fromId && l.to === toId) ||
      (l.from === toId && l.to === fromId),
  )
  if (lane) return Math.max(0.5, lane.leadDays)
  // ~1 day per 80 miles, floor 1
  return Math.max(1, distMiles(from, to) / 80)
}

function buildAssignments(
  network: UploadedNetwork,
  constraints: NetworkConstraints,
  scenario: Scenario,
): Assignment[] {
  const { nodes, lanes, demandVolume } = network
  const open = openFacilityIds(nodes, constraints, scenario)
  const facilities = nodes.filter((n) => open.has(n.id))
  const cmap = new Map(constraints.facilities.map((f) => [f.nodeId, f]))
  const demands = nodes.filter((n) => n.kind === 'demand')

  // Prefer MIP flows when present
  const flowAssign = new Map<string, string>()
  const flows = scenario.optimizeMeta?.flows
  if (flows?.length) {
    const best = new Map<string, { from: string; volume: number }>()
    for (const f of flows) {
      const prev = best.get(f.to)
      if (!prev || f.volume > prev.volume) {
        best.set(f.to, { from: f.from, volume: f.volume })
      }
    }
    for (const [to, v] of best) flowAssign.set(to, v.from)
  }

  const out: Assignment[] = []
  for (const d of demands) {
    const meanDemand = demandVolume[d.id] ?? parseVolume(d.capacity)
    let fac =
      (flowAssign.get(d.id)
        ? facilities.find((f) => f.id === flowAssign.get(d.id))
        : undefined) ?? null
    if (!fac && facilities.length) {
      fac = facilities.reduce((best, f) =>
        distMiles(f, d) < distMiles(best, d) ? f : best,
      )
    }
    if (!fac) continue
    const capMax =
      cmap.get(fac.id)?.capacityMax ?? parseVolume(fac.capacity) * 1.5
    out.push({
      demandId: d.id,
      facilityId: fac.id,
      meanDemand,
      meanLeadDays: leadForPair(fac.id, d.id, lanes, fac, d),
      facilityCap: capMax,
    })
  }
  return out
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0
  const ix = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  return sorted[ix]
}

/**
 * Run Monte Carlo DES-lite for the active scenario's footprint.
 */
export function runDesLiteSim(args: {
  network: UploadedNetwork
  constraints: NetworkConstraints
  scenario: Scenario
  params?: DesLiteParams
}): DesLiteResult {
  const trials = Math.max(20, Math.min(2000, args.params?.trials ?? DEFAULT_TRIALS))
  const demandNoise = args.params?.demandNoise ?? DEFAULT_DEMAND_NOISE
  const leadNoise = args.params?.leadNoise ?? DEFAULT_LEAD_NOISE
  const serviceTargetDays =
    args.params?.serviceTargetDays ?? DEFAULT_SERVICE_DAYS
  const seed = args.params?.seed ?? 42
  const rng = mulberry32(seed)

  const assignments = buildAssignments(
    args.network,
    args.constraints,
    args.scenario,
  )

  // Share facility capacity across assigned demand (proportional).
  const capShare = new Map<string, number>()
  const demandByFac = new Map<string, number>()
  for (const a of assignments) {
    demandByFac.set(a.facilityId, (demandByFac.get(a.facilityId) ?? 0) + a.meanDemand)
  }
  for (const a of assignments) {
    const total = demandByFac.get(a.facilityId) ?? a.meanDemand
    const share = total > 0 ? a.meanDemand / total : 1
    capShare.set(a.demandId, a.facilityCap * share)
  }

  let onTimeVol = 0
  let lateVol = 0
  let shortVol = 0
  const leadSamples: number[] = []
  const trialFill: number[] = []

  for (let t = 0; t < trials; t++) {
    let tOn = 0
    let tLate = 0
    let tShort = 0
    for (const a of assignments) {
      const demNoise = 1 + demandNoise * randn(rng)
      const ltNoise = 1 + leadNoise * randn(rng)
      const demand = Math.max(0, a.meanDemand * demNoise)
      const lead = Math.max(0.25, a.meanLeadDays * ltNoise)
      leadSamples.push(lead)
      const cap = capShare.get(a.demandId) ?? a.facilityCap
      const served = Math.min(demand, Math.max(0, cap))
      const short = Math.max(0, demand - served)
      tShort += short
      if (lead > serviceTargetDays) {
        tLate += served
      } else {
        tOn += served
      }
    }
    const denom = tOn + tLate + tShort
    trialFill.push(denom > 0 ? (tOn / denom) * 100 : 100)
    onTimeVol += tOn
    lateVol += tLate
    shortVol += tShort
  }

  const total = onTimeVol + lateVol + shortVol
  const fillRatePct = total > 0 ? (onTimeVol / total) * 100 : 100
  const lateDemandPct = total > 0 ? ((lateVol + shortVol) / total) * 100 : 0
  const leadsSorted = [...leadSamples].sort((a, b) => a - b)
  const meanLeadDays =
    leadsSorted.length > 0
      ? leadsSorted.reduce((s, x) => s + x, 0) / leadsSorted.length
      : 0

  // Histogram of trial fill rates
  const bins = [
    { label: '<80%', lo: 0, hi: 80, count: 0 },
    { label: '80–90%', lo: 80, hi: 90, count: 0 },
    { label: '90–95%', lo: 90, hi: 95, count: 0 },
    { label: '95–98%', lo: 95, hi: 98, count: 0 },
    { label: '≥98%', lo: 98, hi: 101, count: 0 },
  ]
  for (const f of trialFill) {
    const b = bins.find((x) => f >= x.lo && f < x.hi) ?? bins[bins.length - 1]
    b.count += 1
  }

  return {
    runAt: new Date().toISOString(),
    trials,
    fillRatePct: Math.round(fillRatePct * 10) / 10,
    lateDemandPct: Math.round(lateDemandPct * 10) / 10,
    meanLeadDays: Math.round(meanLeadDays * 100) / 100,
    p95LeadDays: Math.round(percentile(leadsSorted, 0.95) * 100) / 100,
    demandNoisePct: Math.round(demandNoise * 100),
    leadNoisePct: Math.round(leadNoise * 100),
    serviceTargetDays,
    seed,
    fillRateBins: bins.map(({ label, count }) => ({ label, count })),
  }
}
