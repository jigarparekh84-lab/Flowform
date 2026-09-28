/**
 * Lane rate tables + carrier bid comparison.
 * Bids per lane (or corridor) with mode, $/unit or $/mile, transit, capacity.
 * Compare cheapest / fastest / balanced; apply selected bid onto network lane cost.
 */

import type { UploadedNetwork } from './csvParsers'
import { haversineMiles, nodeLatLng } from './geo'
import { normalizeMode } from './modeMix'
import type { NetworkLane, NetworkNode } from './sampleNetwork'

export type RateUnit = 'per_unit' | 'per_mile'

export type BidStrategy = 'cheapest' | 'fastest' | 'balanced'

export type RateBid = {
  id: string
  carrier: string
  mode: string
  /** Dollar amount; meaning depends on rateUnit. */
  rate: number
  rateUnit: RateUnit
  transitDays: number
  /** Weekly capacity (units). */
  capacityUnits: number
  notes?: string
}

export type LaneRateTable = {
  laneId: string
  /** Display corridor e.g. "Austin Plant → Columbus DC". */
  corridorLabel: string
  bids: RateBid[]
  /** Bid currently applied (or preferred) on this lane. */
  selectedBidId: string | null
}

export type LaneRatesState = {
  tables: LaneRateTable[]
  compareStrategy: BidStrategy
}

export type RankedBid = {
  bid: RateBid
  /** Effective $/unit after converting $/mile when needed. */
  effectiveCostPerUnit: number
  miles: number
  rank: number
  /** Lower is better for all strategies. */
  score: number
  isWinner: boolean
  isSelected: boolean
}

export type LaneBidSummary = {
  laneId: string
  corridorLabel: string
  mode: string
  currentCost: number
  currentLeadDays: number
  miles: number
  bids: RankedBid[]
  winner: RankedBid | null
  selected: RankedBid | null
  /** Delta if winner applied vs current lane cost. */
  savingsPerUnit: number
}

const CARRIERS = [
  'SwiftLane',
  'NorthStar Freight',
  'RailLink NA',
  'BlueOcean Lines',
  'AeroCargo Express',
  'Intermodal Hub Co',
] as const

function uid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`
}

export function corridorLabelFor(
  lane: NetworkLane,
  nodes: NetworkNode[],
): string {
  const from = nodes.find((n) => n.id === lane.from)?.name ?? lane.from
  const to = nodes.find((n) => n.id === lane.to)?.name ?? lane.to
  return `${from} → ${to}`
}

export function laneMiles(lane: NetworkLane, nodes: NetworkNode[]): number {
  const a = nodes.find((n) => n.id === lane.from)
  const b = nodes.find((n) => n.id === lane.to)
  if (!a || !b) return 0
  return Math.round(haversineMiles(nodeLatLng(a), nodeLatLng(b)))
}

/** Convert bid into effective $/unit given lane miles. */
export function effectiveCostPerUnit(bid: RateBid, miles: number): number {
  if (bid.rateUnit === 'per_unit') {
    return Math.round(bid.rate * 100) / 100
  }
  const m = Math.max(1, miles)
  return Math.round(bid.rate * m * 100) / 100
}

export function strategyLabel(s: BidStrategy): string {
  switch (s) {
    case 'cheapest':
      return 'Cheapest'
    case 'fastest':
      return 'Fastest'
    case 'balanced':
      return 'Balanced'
  }
}

/**
 * Rank bids for a lane. Score is always lower-better.
 * balanced = 0.55·norm(cost) + 0.45·norm(transit) within the set.
 */
export function rankBids(
  bids: RateBid[],
  miles: number,
  strategy: BidStrategy,
  selectedBidId: string | null,
): RankedBid[] {
  if (bids.length === 0) return []

  const withCost = bids.map((bid) => ({
    bid,
    effectiveCostPerUnit: effectiveCostPerUnit(bid, miles),
    miles,
  }))

  const costs = withCost.map((x) => x.effectiveCostPerUnit)
  const days = withCost.map((x) => x.bid.transitDays)
  const minC = Math.min(...costs)
  const maxC = Math.max(...costs)
  const minD = Math.min(...days)
  const maxD = Math.max(...days)
  const spanC = Math.max(0.01, maxC - minC)
  const spanD = Math.max(0.01, maxD - minD)

  const scored = withCost.map((x) => {
    let score: number
    if (strategy === 'cheapest') {
      score = x.effectiveCostPerUnit
    } else if (strategy === 'fastest') {
      score = x.bid.transitDays
    } else {
      const nC = (x.effectiveCostPerUnit - minC) / spanC
      const nD = (x.bid.transitDays - minD) / spanD
      score = 0.55 * nC + 0.45 * nD
    }
    return {
      ...x,
      score,
      rank: 0,
      isWinner: false,
      isSelected: selectedBidId === x.bid.id,
    }
  })

  scored.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score
    // Tie-break: cheaper, then faster, then carrier name
    if (a.effectiveCostPerUnit !== b.effectiveCostPerUnit) {
      return a.effectiveCostPerUnit - b.effectiveCostPerUnit
    }
    if (a.bid.transitDays !== b.bid.transitDays) {
      return a.bid.transitDays - b.bid.transitDays
    }
    return a.bid.carrier.localeCompare(b.bid.carrier)
  })

  return scored.map((row, i) => ({
    ...row,
    rank: i + 1,
    isWinner: i === 0,
  }))
}

/** Seed 2–3 sample bids around the current lane rate. */
function sampleBidsForLane(lane: NetworkLane, miles: number): RateBid[] {
  const base = lane.costPerUnit
  const mode = normalizeMode(lane.mode)
  const lead = Math.max(1, lane.leadDays)

  // Primary: incumbent-ish per-unit near current cost
  const incumbent: RateBid = {
    id: uid('bid'),
    carrier: CARRIERS[hashPick(lane.id, 0) % CARRIERS.length],
    mode,
    rate: Math.round(base * 100) / 100,
    rateUnit: 'per_unit',
    transitDays: lead,
    capacityUnits: 8000 + (hashPick(lane.id, 1) % 5) * 1000,
    notes: 'Incumbent contract',
  }

  // Challenger: slightly cheaper, slower or same mode
  const challengerRate = Math.round(base * 0.88 * 100) / 100
  const challenger: RateBid = {
    id: uid('bid'),
    carrier: CARRIERS[(hashPick(lane.id, 2) + 1) % CARRIERS.length],
    mode,
    rate: challengerRate,
    rateUnit: 'per_unit',
    transitDays: lead + 1 + (hashPick(lane.id, 3) % 2),
    capacityUnits: 5000 + (hashPick(lane.id, 4) % 4) * 1500,
    notes: 'Spot / secondary',
  }

  // Premium or $/mile alternative
  const premium: RateBid = {
    id: uid('bid'),
    carrier: CARRIERS[(hashPick(lane.id, 5) + 2) % CARRIERS.length],
    mode: mode === 'Road' && hashPick(lane.id, 6) % 3 === 0 ? 'Rail' : mode,
    rate:
      miles > 80
        ? Math.round((base / Math.max(1, miles)) * 1000) / 1000
        : Math.round(base * 1.18 * 100) / 100,
    rateUnit: miles > 80 ? 'per_mile' : 'per_unit',
    transitDays: Math.max(1, lead - (hashPick(lane.id, 7) % 2)),
    capacityUnits: 3000 + (hashPick(lane.id, 8) % 3) * 2000,
    notes: miles > 80 ? '$/mile quote' : 'Expedite',
  }

  return [incumbent, challenger, premium]
}

function hashPick(seed: string, salt: number): number {
  let h = salt * 31
  for (let i = 0; i < seed.length; i++) {
    h = (h * 33 + seed.charCodeAt(i)) >>> 0
  }
  return h
}

export function defaultLaneRates(network: UploadedNetwork): LaneRatesState {
  const tables: LaneRateTable[] = network.lanes.map((lane) => {
    const miles = laneMiles(lane, network.nodes)
    return {
      laneId: lane.id,
      corridorLabel: corridorLabelFor(lane, network.nodes),
      bids: sampleBidsForLane(lane, miles),
      selectedBidId: null,
    }
  })
  return { tables, compareStrategy: 'balanced' }
}

/** Keep existing tables where possible; seed missing lanes. */
export function mergeLaneRates(
  prev: LaneRatesState | undefined,
  network: UploadedNetwork,
): LaneRatesState {
  if (!prev || !prev.tables) return defaultLaneRates(network)
  const byLane = new Map(prev.tables.map((t) => [t.laneId, t]))
  const tables: LaneRateTable[] = network.lanes.map((lane) => {
    const existing = byLane.get(lane.id)
    const label = corridorLabelFor(lane, network.nodes)
    if (existing) {
      return {
        ...existing,
        corridorLabel: label,
        bids: existing.bids.length
          ? existing.bids
          : sampleBidsForLane(lane, laneMiles(lane, network.nodes)),
      }
    }
    const miles = laneMiles(lane, network.nodes)
    return {
      laneId: lane.id,
      corridorLabel: label,
      bids: sampleBidsForLane(lane, miles),
      selectedBidId: null,
    }
  })
  return {
    tables,
    compareStrategy: prev.compareStrategy ?? 'balanced',
  }
}

export function tableForLane(
  state: LaneRatesState,
  laneId: string,
): LaneRateTable | undefined {
  return state.tables.find((t) => t.laneId === laneId)
}

export function summarizeLaneBids(
  state: LaneRatesState,
  network: UploadedNetwork,
  strategy?: BidStrategy,
): LaneBidSummary[] {
  const strat = strategy ?? state.compareStrategy
  return state.tables.map((table) => {
    const lane = network.lanes.find((l) => l.id === table.laneId)
    const miles = lane
      ? laneMiles(lane, network.nodes)
      : 0
    const ranked = rankBids(table.bids, miles, strat, table.selectedBidId)
    const winner = ranked.find((r) => r.isWinner) ?? null
    const selected = ranked.find((r) => r.isSelected) ?? null
    const currentCost = lane?.costPerUnit ?? 0
    const savings =
      winner != null
        ? Math.round((currentCost - winner.effectiveCostPerUnit) * 100) / 100
        : 0
    return {
      laneId: table.laneId,
      corridorLabel: table.corridorLabel,
      mode: lane?.mode ?? '—',
      currentCost,
      currentLeadDays: lane?.leadDays ?? 0,
      miles,
      bids: ranked,
      winner,
      selected,
      savingsPerUnit: savings,
    }
  })
}

/**
 * Apply a bid onto a network lane: cost, transit, and mode.
 */
export function applyBidToLane(
  lane: NetworkLane,
  bid: RateBid,
  nodes: NetworkNode[],
): NetworkLane {
  const miles = laneMiles(lane, nodes)
  const costPerUnit = effectiveCostPerUnit(bid, miles)
  return {
    ...lane,
    mode: normalizeMode(bid.mode),
    costPerUnit,
    leadDays: Math.max(1, Math.round(bid.transitDays)),
  }
}

export function updateBidInState(
  state: LaneRatesState,
  laneId: string,
  bidId: string,
  patch: Partial<Omit<RateBid, 'id'>>,
): LaneRatesState {
  return {
    ...state,
    tables: state.tables.map((t) => {
      if (t.laneId !== laneId) return t
      return {
        ...t,
        bids: t.bids.map((b) => (b.id === bidId ? { ...b, ...patch } : b)),
      }
    }),
  }
}

export function addBidToLane(
  state: LaneRatesState,
  laneId: string,
  bid?: Partial<RateBid>,
): LaneRatesState {
  return {
    ...state,
    tables: state.tables.map((t) => {
      if (t.laneId !== laneId) return t
      const next: RateBid = {
        id: uid('bid'),
        carrier: bid?.carrier ?? 'New carrier',
        mode: bid?.mode ?? 'Road',
        rate: bid?.rate ?? 1,
        rateUnit: bid?.rateUnit ?? 'per_unit',
        transitDays: bid?.transitDays ?? 3,
        capacityUnits: bid?.capacityUnits ?? 5000,
        notes: bid?.notes,
      }
      return { ...t, bids: [...t.bids, next] }
    }),
  }
}

export function removeBidFromLane(
  state: LaneRatesState,
  laneId: string,
  bidId: string,
): LaneRatesState {
  return {
    ...state,
    tables: state.tables.map((t) => {
      if (t.laneId !== laneId) return t
      const bids = t.bids.filter((b) => b.id !== bidId)
      return {
        ...t,
        bids,
        selectedBidId:
          t.selectedBidId === bidId ? null : t.selectedBidId,
      }
    }),
  }
}

export function setSelectedBid(
  state: LaneRatesState,
  laneId: string,
  bidId: string | null,
): LaneRatesState {
  return {
    ...state,
    tables: state.tables.map((t) =>
      t.laneId === laneId ? { ...t, selectedBidId: bidId } : t,
    ),
  }
}

/** Network-wide rollup for Compare tab. */
export function bidCompareRollup(summaries: LaneBidSummary[]): {
  laneCount: number
  bidCount: number
  totalSavingsPerUnit: number
  lanesWithSavings: number
  avgWinnerCost: number
  avgCurrentCost: number
} {
  const bidCount = summaries.reduce((s, x) => s + x.bids.length, 0)
  const totalSavings = summaries.reduce((s, x) => s + x.savingsPerUnit, 0)
  const lanesWithSavings = summaries.filter((x) => x.savingsPerUnit > 0).length
  const avgWinner =
    summaries.length === 0
      ? 0
      : summaries.reduce(
          (s, x) => s + (x.winner?.effectiveCostPerUnit ?? x.currentCost),
          0,
        ) / summaries.length
  const avgCurrent =
    summaries.length === 0
      ? 0
      : summaries.reduce((s, x) => s + x.currentCost, 0) / summaries.length
  return {
    laneCount: summaries.length,
    bidCount,
    totalSavingsPerUnit: Math.round(totalSavings * 100) / 100,
    lanesWithSavings,
    avgWinnerCost: Math.round(avgWinner * 100) / 100,
    avgCurrentCost: Math.round(avgCurrent * 100) / 100,
  }
}
