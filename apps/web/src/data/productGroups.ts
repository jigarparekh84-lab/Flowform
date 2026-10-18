/**
 * Multi-commodity / product groups on the network.
 * Demand & lanes tagged by group; facilities carry capable flags + capacity by group.
 */

import type { UploadedNetwork } from './csvParsers'
import type { KpiSnapshot, NetworkLane, NetworkNode } from './sampleNetwork'

export type ProductGroupId = string

export type ProductHandling =
  | 'ambient'
  | 'chilled'
  | 'frozen'
  | 'hazmat'
  | 'standard'

export type ProductCatalogId = 'temp-handling' | 'mfg-stage'

export type ProductGroup = {
  id: ProductGroupId
  name: string
  code: string
  color: string
  description: string
  handling: ProductHandling
}

export type DemandProductMix = {
  nodeId: string
  /** Volume share 0–100 by group id (should sum ≈ 100). */
  shares: Record<ProductGroupId, number>
}

export type LaneProductTag = {
  laneId: string
  /** Groups this lane may carry. Empty = all groups. */
  groupIds: ProductGroupId[]
}

export type FacilityProductCap = {
  nodeId: string
  capableGroupIds: ProductGroupId[]
  /** Dedicated capacity units by group (0 = none dedicated). */
  capacityByGroup: Record<ProductGroupId, number>
}

export type ProductMixState = {
  catalog: ProductCatalogId
  groups: ProductGroup[]
  demandMix: DemandProductMix[]
  laneTags: LaneProductTag[]
  facilityCaps: FacilityProductCap[]
  /** Network / Compare filter — null means All. */
  filterGroupId: ProductGroupId | null
}

export type ProductGroupRollup = {
  groupId: ProductGroupId
  name: string
  code: string
  color: string
  demandVolume: number
  demandSharePct: number
  capableFacilities: number
  taggedLanes: number
  capacityUnits: number
  /** Rough cost allocation from scenario KPI × demand share. */
  costM: number
  co2Kt: number
  servicePct: number
}

/** Temperature / handling catalog (default sample). */
export const TEMP_HANDLING_GROUPS: ProductGroup[] = [
  {
    id: 'ambient',
    name: 'Ambient',
    code: 'AMB',
    color: '#34d399',
    description: 'Dry / ambient finished goods — no cold chain.',
    handling: 'ambient',
  },
  {
    id: 'chilled',
    name: 'Chilled',
    code: 'CHL',
    color: '#38bdf8',
    description: 'Refrigerated SKUs requiring 2–8°C lanes & DCs.',
    handling: 'chilled',
  },
  {
    id: 'hazmat',
    name: 'Hazmat',
    code: 'HAZ',
    color: '#f87171',
    description: 'Regulated / hazardous commodities — limited lanes.',
    handling: 'hazmat',
  },
]

/** Manufacturing stage catalog (Finished / WIP / RM). */
export const MFG_STAGE_GROUPS: ProductGroup[] = [
  {
    id: 'finished',
    name: 'Finished',
    code: 'FG',
    color: '#34d399',
    description: 'Finished goods ready for customer demand.',
    handling: 'standard',
  },
  {
    id: 'wip',
    name: 'WIP',
    code: 'WIP',
    color: '#fbbf24',
    description: 'Work-in-process between plants and finishing DCs.',
    handling: 'standard',
  },
  {
    id: 'rm',
    name: 'Raw material',
    code: 'RM',
    color: '#a78bfa',
    description: 'Inbound raw materials from suppliers.',
    handling: 'standard',
  },
]

export function groupsForCatalog(catalog: ProductCatalogId): ProductGroup[] {
  return catalog === 'mfg-stage'
    ? structuredClone(MFG_STAGE_GROUPS)
    : structuredClone(TEMP_HANDLING_GROUPS)
}

function parseVolume(capacity: string): number {
  const m = capacity.replace(/,/g, '').match(/([\d.]+)/)
  if (!m) return 1000
  let v = parseFloat(m[1])
  if (/k/i.test(capacity)) v *= 1000
  return v
}

function normalizeShares(
  shares: Record<string, number>,
  groupIds: string[],
): Record<string, number> {
  const out: Record<string, number> = {}
  let sum = 0
  for (const id of groupIds) {
    const v = Math.max(0, shares[id] ?? 0)
    out[id] = v
    sum += v
  }
  if (sum <= 0) {
    // Equal split fallback
    const each = Math.round((100 / groupIds.length) * 10) / 10
    for (const id of groupIds) out[id] = each
    return out
  }
  if (Math.abs(sum - 100) < 0.5) return out
  for (const id of groupIds) {
    out[id] = Math.round((out[id] / sum) * 1000) / 10
  }
  return out
}

function seedDemandMix(
  network: UploadedNetwork,
  groups: ProductGroup[],
): DemandProductMix[] {
  const groupIds = groups.map((g) => g.id)
  const demands = network.nodes.filter((n) => n.kind === 'demand')
  return demands.map((n, i) => {
    // Vary mix by demand node for sample richness
    let shares: Record<string, number>
    if (groups[0]?.id === 'ambient') {
      // Temp-handling: Chicago more ambient, NYC more chilled, Dallas more hazmat-ish
      if (i % 3 === 0) shares = { ambient: 62, chilled: 28, hazmat: 10 }
      else if (i % 3 === 1) shares = { ambient: 48, chilled: 40, hazmat: 12 }
      else shares = { ambient: 55, chilled: 25, hazmat: 20 }
    } else {
      if (i % 3 === 0) shares = { finished: 70, wip: 20, rm: 10 }
      else if (i % 3 === 1) shares = { finished: 55, wip: 30, rm: 15 }
      else shares = { finished: 60, wip: 25, rm: 15 }
    }
    // Keep only known group keys
    const clipped: Record<string, number> = {}
    for (const id of groupIds) clipped[id] = shares[id] ?? 0
    return { nodeId: n.id, shares: normalizeShares(clipped, groupIds) }
  })
}

function seedLaneTags(
  network: UploadedNetwork,
  groups: ProductGroup[],
): LaneProductTag[] {
  const ids = groups.map((g) => g.id)
  return network.lanes.map((l, i) => {
    // Most lanes carry all; some specialized
    if (ids.includes('hazmat') && i % 4 === 3) {
      return { laneId: l.id, groupIds: ['ambient', 'hazmat'] }
    }
    if (ids.includes('chilled') && i % 5 === 1) {
      return { laneId: l.id, groupIds: ['ambient', 'chilled'] }
    }
    if (ids.includes('rm') && i === 0) {
      return { laneId: l.id, groupIds: ['rm', 'wip'] }
    }
    if (ids.includes('finished') && i % 3 === 2) {
      return { laneId: l.id, groupIds: ['finished', 'wip'] }
    }
    return { laneId: l.id, groupIds: [...ids] }
  })
}

function seedFacilityCaps(
  network: UploadedNetwork,
  groups: ProductGroup[],
): FacilityProductCap[] {
  const facilities = network.nodes.filter(
    (n) => n.kind === 'dc' || n.kind === 'plant' || n.kind === 'candidate',
  )
  const groupIds = groups.map((g) => g.id)
  return facilities.map((n, i) => {
    const total = parseVolume(n.capacity)
    const capable =
      // Plants typically handle all; some DCs skip hazmat / rm
      n.kind === 'plant'
        ? [...groupIds]
        : groupIds.filter((id) => {
            if (id === 'hazmat' && i % 2 === 0) return false
            if (id === 'rm' && n.kind === 'dc' && i % 3 === 0) return false
            return true
          })
    // Per-group caps are enforced by the MIP (shared by every SKU in the
    // group). Default each capable group to the full site capacity so the cap
    // only binds once a planner lowers it; the site total still applies.
    const capacityByGroup: Record<string, number> = {}
    for (const id of groupIds) {
      capacityByGroup[id] = capable.includes(id) ? Math.round(total) : 0
    }
    return {
      nodeId: n.id,
      capableGroupIds: capable,
      capacityByGroup,
    }
  })
}

/** Build default product mix for a network + catalog. */
export function defaultProductMix(
  network: UploadedNetwork,
  catalog: ProductCatalogId = 'temp-handling',
): ProductMixState {
  const groups = groupsForCatalog(catalog)
  return {
    catalog,
    groups,
    demandMix: seedDemandMix(network, groups),
    laneTags: seedLaneTags(network, groups),
    facilityCaps: seedFacilityCaps(network, groups),
    filterGroupId: null,
  }
}

/** Merge existing mix onto a (possibly new) network; preserve edits where ids match. */
export function mergeProductMix(
  prev: ProductMixState | null | undefined,
  network: UploadedNetwork,
): ProductMixState {
  const catalog = prev?.catalog ?? 'temp-handling'
  const fresh = defaultProductMix(network, catalog)
  if (!prev) return fresh

  // Prefer previous group definitions if same catalog & non-empty
  const groups =
    prev.catalog === catalog && prev.groups.length > 0
      ? prev.groups
      : fresh.groups
  const groupIds = groups.map((g) => g.id)

  const demandById = new Map(prev.demandMix.map((d) => [d.nodeId, d]))
  const laneById = new Map(prev.laneTags.map((l) => [l.laneId, l]))
  const facById = new Map(prev.facilityCaps.map((f) => [f.nodeId, f]))

  return {
    catalog,
    groups,
    demandMix: fresh.demandMix.map((d) => {
      const old = demandById.get(d.nodeId)
      if (!old) return d
      const shares: Record<string, number> = {}
      for (const id of groupIds) shares[id] = old.shares[id] ?? 0
      return { nodeId: d.nodeId, shares: normalizeShares(shares, groupIds) }
    }),
    laneTags: fresh.laneTags.map((l) => {
      const old = laneById.get(l.laneId)
      if (!old) return l
      return {
        laneId: l.laneId,
        groupIds: old.groupIds.filter((id) => groupIds.includes(id)),
      }
    }),
    facilityCaps: fresh.facilityCaps.map((f) => {
      const old = facById.get(f.nodeId)
      if (!old) return f
      const capable = old.capableGroupIds.filter((id) => groupIds.includes(id))
      const capacityByGroup: Record<string, number> = {}
      for (const id of groupIds) {
        capacityByGroup[id] = old.capacityByGroup[id] ?? 0
      }
      return {
        nodeId: f.nodeId,
        capableGroupIds: capable.length > 0 ? capable : f.capableGroupIds,
        capacityByGroup,
      }
    }),
    filterGroupId:
      prev.filterGroupId && groupIds.includes(prev.filterGroupId)
        ? prev.filterGroupId
        : null,
  }
}

export function switchProductCatalog(
  network: UploadedNetwork,
  catalog: ProductCatalogId,
): ProductMixState {
  return defaultProductMix(network, catalog)
}

export function groupById(
  state: ProductMixState,
  id: ProductGroupId | null | undefined,
): ProductGroup | undefined {
  if (!id) return undefined
  return state.groups.find((g) => g.id === id)
}

export function demandSharesForNode(
  state: ProductMixState,
  nodeId: string,
): Record<ProductGroupId, number> {
  const row = state.demandMix.find((d) => d.nodeId === nodeId)
  if (row) return row.shares
  const out: Record<string, number> = {}
  const each = Math.round((100 / Math.max(1, state.groups.length)) * 10) / 10
  for (const g of state.groups) out[g.id] = each
  return out
}

export function laneGroups(
  state: ProductMixState,
  laneId: string,
): ProductGroupId[] {
  const tag = state.laneTags.find((l) => l.laneId === laneId)
  if (!tag || tag.groupIds.length === 0) return state.groups.map((g) => g.id)
  return tag.groupIds
}

export function facilityCapFor(
  state: ProductMixState,
  nodeId: string,
): FacilityProductCap | undefined {
  return state.facilityCaps.find((f) => f.nodeId === nodeId)
}

/** Does this node participate under the active product filter? */
export function nodeMatchesProductFilter(
  node: NetworkNode,
  state: ProductMixState,
  filterId: ProductGroupId | null = state.filterGroupId,
): boolean {
  if (!filterId) return true
  if (node.kind === 'demand') {
    return (demandSharesForNode(state, node.id)[filterId] ?? 0) > 0
  }
  if (
    node.kind === 'dc' ||
    node.kind === 'plant' ||
    node.kind === 'candidate'
  ) {
    const cap = facilityCapFor(state, node.id)
    return !!cap?.capableGroupIds.includes(filterId)
  }
  // Suppliers: visible if any outbound lane carries the group
  return true
}

export function laneMatchesProductFilter(
  lane: NetworkLane,
  state: ProductMixState,
  filterId: ProductGroupId | null = state.filterGroupId,
): boolean {
  if (!filterId) return true
  const groups = laneGroups(state, lane.id)
  return groups.includes(filterId)
}

/** Volume of demand for one group (absolute units). */
export function demandVolumeForGroup(
  state: ProductMixState,
  network: UploadedNetwork,
  groupId: ProductGroupId,
): number {
  let total = 0
  for (const d of state.demandMix) {
    const vol = network.demandVolume[d.nodeId] ?? 0
    const share = (d.shares[groupId] ?? 0) / 100
    total += vol * share
  }
  return Math.round(total)
}

export function totalDemandVolume(network: UploadedNetwork): number {
  return Object.values(network.demandVolume).reduce((s, v) => s + v, 0) || 0
}

/** Parse "$48.2M" / "12.4 kt" / "94.1%" loosely. */
function parseNum(value: string): number {
  const m = value.replace(/,/g, '').match(/([\d.]+)/)
  return m ? parseFloat(m[1]) : 0
}

/** KPI rollup by product group from demand shares × scenario KPIs. */
export function rollupByProductGroup(
  state: ProductMixState,
  network: UploadedNetwork,
  kpis: KpiSnapshot,
): ProductGroupRollup[] {
  const totalVol = totalDemandVolume(network) || 1
  const costM = parseNum(kpis.cost.value)
  const co2Kt = parseNum(kpis.co2.value)
  const servicePct = parseNum(kpis.service.value)

  return state.groups.map((g) => {
    const demandVolume = demandVolumeForGroup(state, network, g.id)
    const demandSharePct =
      Math.round((demandVolume / totalVol) * 1000) / 10
    const capableFacilities = state.facilityCaps.filter((f) =>
      f.capableGroupIds.includes(g.id),
    ).length
    const taggedLanes = state.laneTags.filter((l) => {
      if (l.groupIds.length === 0) return true
      return l.groupIds.includes(g.id)
    }).length
    const capacityUnits = state.facilityCaps.reduce(
      (s, f) => s + (f.capacityByGroup[g.id] ?? 0),
      0,
    )
    const share = demandSharePct / 100
    return {
      groupId: g.id,
      name: g.name,
      code: g.code,
      color: g.color,
      demandVolume,
      demandSharePct,
      capableFacilities,
      taggedLanes,
      capacityUnits,
      costM: Math.round(costM * share * 10) / 10,
      co2Kt: Math.round(co2Kt * share * 10) / 10,
      servicePct: Math.round(servicePct * 10) / 10,
    }
  })
}

export function formatGroupCodes(
  state: ProductMixState,
  groupIds: ProductGroupId[],
): string {
  if (groupIds.length === 0 || groupIds.length === state.groups.length) {
    return 'All'
  }
  return groupIds
    .map((id) => state.groups.find((g) => g.id === id)?.code ?? id)
    .join(', ')
}

export function catalogLabel(catalog: ProductCatalogId): string {
  return catalog === 'mfg-stage'
    ? 'Finished / WIP / RM'
    : 'Ambient / Chilled / Hazmat'
}
