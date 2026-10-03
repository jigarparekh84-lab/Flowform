/**
 * Enterprise data model (depth slice 2) — formal pack schema + strict validation.
 * Sites, SKUs/groups, demand by SKU+customer, lanes, BOM, cost factors.
 * Validated packs feed the fixed-charge multi-echelon MIP payload.
 */

import type { BomRow, BomState } from './bom'
import type { UploadedNetwork } from './csvParsers'
import { buildValidation, latLngToXY } from './csvParsers'
import type { EmissionFactor } from './emissions'
import { DEFAULT_EMISSION_FACTORS } from './emissions'
import type { ProductMixState } from './productGroups'
import type {
  FacilityConstraint,
  FacilityStatus,
  NetworkConstraints,
  NetworkLane,
  NetworkNode,
  NodeKind,
} from './sampleNetwork'

export const ENTERPRISE_SCHEMA_VERSION = 'enterprise-data-v1' as const
export const ENTERPRISE_PACK_FORMAT = 'flowform-enterprise-pack' as const

export type EnterpriseSiteStatus = FacilityStatus

export type EnterpriseSite = {
  id: string
  name: string
  kind: NodeKind
  lat?: number
  lng?: number
  /** Canvas fallback when lat/lng absent. */
  x?: number
  y?: number
  region?: string
  capacityMin: number
  capacityMax: number
  /** Fixed CapEx $M to open (0 if already open / sunk). */
  fixedCostM: number
  fixedOpexM?: number
  status: EnterpriseSiteStatus
  /** Product or group ids this site may handle (omit = all). */
  capableProductIds?: string[]
  capacityByProduct?: Record<string, number>
}

export type EnterpriseSku = {
  id: string
  name: string
  code: string
  groupId?: string
  handling?: string
}

export type EnterpriseProductGroup = {
  id: string
  name: string
  code: string
  color?: string
  description?: string
}

/** Demand by SKU + customer (customer = demand-kind site). */
export type EnterpriseDemand = {
  id: string
  customerId: string
  skuId: string
  volume: number
}

export type EnterpriseLane = {
  id: string
  from: string
  to: string
  /** Primary / headline mode (legacy single-mode lanes). */
  mode: string
  costPerUnit: number
  leadDays: number
  /** Lane throughput capacity (units) — caps the total across all modes. */
  capacity: number
  co2Kg?: number
  /**
   * Depth 7: transport mode alternatives (e.g. Truck / Rail / Intermodal).
   * The MIP chooses the split subject to per-mode capacity, transit vs
   * maxLeadTimeDays, optional fixed activation charge, and lane capacity.
   */
  modes?: EnterpriseLaneMode[]
}

export type EnterpriseLaneMode = {
  mode: string
  costPerUnit: number
  leadDays: number
  capacity?: number
  co2KgPerUnit?: number
  fixedCostM?: number
}

/** Modes the planning factors / emissions table know about. */
export const KNOWN_LANE_MODES = [
  'Truck',
  'Rail',
  'Intermodal',
  'Ocean',
  'Air',
  'Parcel',
] as const

export type EnterpriseBomRow = {
  id: string
  parentSkuId: string
  childSkuId: string
  qtyPerUnit: number
  plantId?: string | null
  supplierId?: string | null
}

export type EnterpriseCostFactors = {
  emissionKgPerTonMileByMode: Record<string, number>
  transportCostScale?: number
  uncoveredPenaltyM?: number
}

export type EnterprisePack = {
  format: typeof ENTERPRISE_PACK_FORMAT
  schemaVersion: typeof ENTERPRISE_SCHEMA_VERSION
  name?: string
  sites: EnterpriseSite[]
  skus: EnterpriseSku[]
  productGroups: EnterpriseProductGroup[]
  demand: EnterpriseDemand[]
  lanes: EnterpriseLane[]
  bom: EnterpriseBomRow[]
  costFactors: EnterpriseCostFactors
  /** Optional optimize globals carried with the pack. */
  globals?: {
    serviceTargetPct?: number
    serviceRadiusMiles?: number
    capexBudgetM?: number
    maxFacilities?: number
    hardServiceConstraints?: boolean
    maxLeadTimeDays?: number
    aggregateProductsByGroup?: boolean | 'auto' | 'always' | 'never'
    maxProductCommodities?: number
    enforceLaneCapacity?: boolean
    carbonPricePerTonne?: number
  }
}

export type ValidationErrorCode =
  | 'EMPTY_PACK'
  | 'DUPLICATE_SITE_ID'
  | 'DUPLICATE_SKU_ID'
  | 'DUPLICATE_LANE_ID'
  | 'DUPLICATE_DEMAND_ID'
  | 'DUPLICATE_BOM_ID'
  | 'DUPLICATE_GROUP_ID'
  | 'ORPHAN_DEMAND_CUSTOMER'
  | 'ORPHAN_DEMAND_SKU'
  | 'LANE_FROM_MISSING'
  | 'LANE_TO_MISSING'
  | 'CAPACITY_NONPOSITIVE'
  | 'CAPACITY_MIN_GT_MAX'
  | 'DEMAND_VOLUME_NONPOSITIVE'
  | 'LANE_COST_NEGATIVE'
  | 'LANE_CAPACITY_NONPOSITIVE'
  | 'LANE_MODE_EMPTY'
  | 'LANE_MODE_UNKNOWN'
  | 'LANE_MODE_DUPLICATE'
  | 'LANE_MODE_COST_NEGATIVE'
  | 'LANE_MODE_LEAD_INVALID'
  | 'LANE_MODE_CAPACITY_NONPOSITIVE'
  | 'LANE_MODE_FIXED_COST_NEGATIVE'
  | 'LANE_MODE_CO2_NEGATIVE'
  | 'LANE_MODE_CAPACITY_BELOW_LANE'
  | 'LANE_ROUTE_DUPLICATE'
  | 'FIXED_COST_NEGATIVE'
  | 'BOM_ORPHAN_PARENT'
  | 'BOM_ORPHAN_CHILD'
  | 'BOM_QTY_NONPOSITIVE'
  | 'BOM_CYCLE'
  | 'BOM_PLANT_MISSING'
  | 'BOM_SUPPLIER_MISSING'
  | 'GEOCODE_GAP'
  | 'UNKNOWN_SITE_KIND'
  | 'INVALID_SITE_STATUS'
  | 'ORPHAN_SKU_GROUP'
  | 'SCHEMA_MISMATCH'

export type EnterpriseValidationIssue = {
  level: 'error' | 'warn' | 'info'
  code: ValidationErrorCode
  message: string
  /** Entity id when applicable. */
  entityId?: string
  /** Human fix-it hint. */
  hint: string
}

export type EnterpriseValidationScorecard = {
  schemaVersion: string
  ok: boolean
  score: number
  errorCount: number
  warnCount: number
  infoCount: number
  geocodeCoveragePct: number
  siteCount: number
  demandRowCount: number
  demandVolumeTotal: number
  laneCount: number
  skuCount: number
  bomRowCount: number
  orphanDemandCount: number
  missingEndpointCount: number
  capacityIssues: number
  bomCycleDetected: boolean
  /** Depth 7: lanes carrying a modes[] array + total mode options. */
  multiModeLaneCount: number
  laneModeOptionCount: number
  issues: EnterpriseValidationIssue[]
}

const FACILITY_KINDS: NodeKind[] = ['plant', 'dc', 'candidate', 'supplier']
const VALID_KINDS: NodeKind[] = [
  'plant',
  'dc',
  'demand',
  'supplier',
  'candidate',
]
const VALID_STATUS: EnterpriseSiteStatus[] = ['open', 'closed', 'candidate']

function parseVolFromCapacity(capacity: string): number {
  const m = capacity.replace(/,/g, '').match(/([\d.]+)/)
  if (!m) return 1000
  let v = parseFloat(m[1])
  if (/k/i.test(capacity)) v *= 1000
  return v
}

function detectBomCycles(rows: EnterpriseBomRow[]): string[][] {
  const adj = new Map<string, Set<string>>()
  for (const r of rows) {
    if (!r.parentSkuId || !r.childSkuId) continue
    if (!adj.has(r.parentSkuId)) adj.set(r.parentSkuId, new Set())
    adj.get(r.parentSkuId)!.add(r.childSkuId)
  }
  const cycles: string[][] = []
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const stack: string[] = []

  function dfs(node: string) {
    if (visiting.has(node)) {
      const ix = stack.indexOf(node)
      cycles.push(ix >= 0 ? [...stack.slice(ix), node] : [node, node])
      return
    }
    if (visited.has(node)) return
    visiting.add(node)
    stack.push(node)
    for (const next of adj.get(node) ?? []) dfs(next)
    stack.pop()
    visiting.delete(node)
    visited.add(node)
  }

  for (const id of adj.keys()) dfs(id)
  return cycles
}

/** Strict validation with actionable error codes + fix-it hints. */
export function validateEnterprisePack(
  pack: EnterprisePack | null | undefined,
): EnterpriseValidationScorecard {
  const issues: EnterpriseValidationIssue[] = []

  if (!pack || !Array.isArray(pack.sites)) {
    issues.push({
      level: 'error',
      code: 'EMPTY_PACK',
      message: 'Enterprise pack is missing or has no sites array.',
      hint: 'Import a flowform-enterprise-pack JSON or build from the active network.',
    })
    return scorecardFromIssues(issues, pack)
  }

  if (
    pack.format !== ENTERPRISE_PACK_FORMAT ||
    pack.schemaVersion !== ENTERPRISE_SCHEMA_VERSION
  ) {
    issues.push({
      level: 'warn',
      code: 'SCHEMA_MISMATCH',
      message: `Expected format ${ENTERPRISE_PACK_FORMAT} @ ${ENTERPRISE_SCHEMA_VERSION}; got ${pack.format ?? '?'} @ ${pack.schemaVersion ?? '?'}.`,
      hint: 'Re-export from Data room or bump the pack to the current schema version.',
    })
  }

  if (pack.sites.length === 0 && pack.demand.length === 0) {
    issues.push({
      level: 'error',
      code: 'EMPTY_PACK',
      message: 'Pack has zero sites and zero demand rows.',
      hint: 'Add facility/demand sites or import a sample pack.',
    })
  }

  const siteIds = new Set<string>()
  let geocodeHits = 0
  let geocodeTotal = 0
  let capacityIssues = 0

  for (const s of pack.sites) {
    if (siteIds.has(s.id)) {
      issues.push({
        level: 'error',
        code: 'DUPLICATE_SITE_ID',
        message: `Duplicate site id "${s.id}".`,
        entityId: s.id,
        hint: `Rename or merge site "${s.id}" so every id is unique.`,
      })
    }
    siteIds.add(s.id)

    if (!VALID_KINDS.includes(s.kind)) {
      issues.push({
        level: 'error',
        code: 'UNKNOWN_SITE_KIND',
        message: `Site "${s.id}" has unknown kind "${String(s.kind)}".`,
        entityId: s.id,
        hint: 'Use plant | dc | demand | supplier | candidate.',
      })
    }
    if (!VALID_STATUS.includes(s.status)) {
      issues.push({
        level: 'error',
        code: 'INVALID_SITE_STATUS',
        message: `Site "${s.id}" has invalid status "${String(s.status)}".`,
        entityId: s.id,
        hint: 'Use open | closed | candidate.',
      })
    }

    geocodeTotal++
    if (
      s.lat != null &&
      s.lng != null &&
      Number.isFinite(s.lat) &&
      Number.isFinite(s.lng)
    ) {
      geocodeHits++
    } else if (FACILITY_KINDS.includes(s.kind) || s.kind === 'demand') {
      issues.push({
        level: 'warn',
        code: 'GEOCODE_GAP',
        message: `Site "${s.id}" (${s.name}) missing lat/lng.`,
        entityId: s.id,
        hint: 'Add WGS84 lat/lng so MapLibre + distance/CO2 are accurate.',
      })
    }

    if (FACILITY_KINDS.includes(s.kind)) {
      if (s.capacityMax <= 0) {
        capacityIssues++
        issues.push({
          level: 'error',
          code: 'CAPACITY_NONPOSITIVE',
          message: `Site "${s.id}" capacityMax must be > 0 (got ${s.capacityMax}).`,
          entityId: s.id,
          hint: 'Set capacityMax to a positive throughput (units).',
        })
      }
      if (s.capacityMin < 0) {
        capacityIssues++
        issues.push({
          level: 'error',
          code: 'CAPACITY_NONPOSITIVE',
          message: `Site "${s.id}" capacityMin must be >= 0 (got ${s.capacityMin}).`,
          entityId: s.id,
          hint: 'Set capacityMin to 0 or a positive minimum throughput.',
        })
      }
      if (s.capacityMin > s.capacityMax && s.capacityMax > 0) {
        capacityIssues++
        issues.push({
          level: 'error',
          code: 'CAPACITY_MIN_GT_MAX',
          message: `Site "${s.id}" capacityMin (${s.capacityMin}) > capacityMax (${s.capacityMax}).`,
          entityId: s.id,
          hint: 'Lower capacityMin or raise capacityMax.',
        })
      }
      if (s.fixedCostM < 0) {
        issues.push({
          level: 'error',
          code: 'FIXED_COST_NEGATIVE',
          message: `Site "${s.id}" fixedCostM is negative.`,
          entityId: s.id,
          hint: 'Use >= 0 CapEx $M (0 if already open / sunk).',
        })
      }
    }
  }

  const groupIds = new Set<string>()
  for (const g of pack.productGroups) {
    if (groupIds.has(g.id)) {
      issues.push({
        level: 'error',
        code: 'DUPLICATE_GROUP_ID',
        message: `Duplicate product group id "${g.id}".`,
        entityId: g.id,
        hint: 'Make product group ids unique.',
      })
    }
    groupIds.add(g.id)
  }

  const skuIds = new Set<string>()
  for (const sku of pack.skus) {
    if (skuIds.has(sku.id)) {
      issues.push({
        level: 'error',
        code: 'DUPLICATE_SKU_ID',
        message: `Duplicate SKU id "${sku.id}".`,
        entityId: sku.id,
        hint: 'Make SKU ids unique.',
      })
    }
    skuIds.add(sku.id)
    if (sku.groupId && groupIds.size > 0 && !groupIds.has(sku.groupId)) {
      issues.push({
        level: 'warn',
        code: 'ORPHAN_SKU_GROUP',
        message: `SKU "${sku.id}" references missing group "${sku.groupId}".`,
        entityId: sku.id,
        hint: 'Add the product group or clear groupId on the SKU.',
      })
    }
  }

  const demandIds = new Set<string>()
  let orphanDemandCount = 0
  let demandVolumeTotal = 0
  for (const d of pack.demand) {
    if (demandIds.has(d.id)) {
      issues.push({
        level: 'error',
        code: 'DUPLICATE_DEMAND_ID',
        message: `Duplicate demand id "${d.id}".`,
        entityId: d.id,
        hint: 'Make demand row ids unique (e.g. dem-{customer}-{sku}).',
      })
    }
    demandIds.add(d.id)

    if (!siteIds.has(d.customerId)) {
      orphanDemandCount++
      issues.push({
        level: 'error',
        code: 'ORPHAN_DEMAND_CUSTOMER',
        message: `Demand "${d.id}" customer "${d.customerId}" is not a site.`,
        entityId: d.id,
        hint: 'Add a demand-kind site with that id, or retarget customerId.',
      })
    } else {
      const cust = pack.sites.find((s) => s.id === d.customerId)
      if (cust && cust.kind !== 'demand') {
        issues.push({
          level: 'warn',
          code: 'ORPHAN_DEMAND_CUSTOMER',
          message: `Demand "${d.id}" customer "${d.customerId}" is kind "${cust.kind}", not demand.`,
          entityId: d.id,
          hint: 'Point demand at a site with kind=demand.',
        })
      }
    }

    if (skuIds.size > 0 && !skuIds.has(d.skuId)) {
      orphanDemandCount++
      issues.push({
        level: 'error',
        code: 'ORPHAN_DEMAND_SKU',
        message: `Demand "${d.id}" SKU "${d.skuId}" is not in skus[].`,
        entityId: d.id,
        hint: 'Add the SKU to skus[] or fix skuId.',
      })
    }

    if (!(d.volume > 0)) {
      issues.push({
        level: 'error',
        code: 'DEMAND_VOLUME_NONPOSITIVE',
        message: `Demand "${d.id}" volume must be > 0 (got ${d.volume}).`,
        entityId: d.id,
        hint: 'Set a positive volume or remove the row.',
      })
    } else {
      demandVolumeTotal += d.volume
    }
  }

  const laneIds = new Set<string>()
  const routeModes = new Map<string, string>()
  let missingEndpointCount = 0
  for (const lane of pack.lanes) {
    if (laneIds.has(lane.id)) {
      issues.push({
        level: 'error',
        code: 'DUPLICATE_LANE_ID',
        message: `Duplicate lane id "${lane.id}".`,
        entityId: lane.id,
        hint: 'Make lane ids unique.',
      })
    }
    laneIds.add(lane.id)

    if (!siteIds.has(lane.from)) {
      missingEndpointCount++
      issues.push({
        level: 'error',
        code: 'LANE_FROM_MISSING',
        message: `Lane "${lane.id}" from "${lane.from}" is not a site.`,
        entityId: lane.id,
        hint: 'Add the origin site or correct the from id.',
      })
    }
    if (!siteIds.has(lane.to)) {
      missingEndpointCount++
      issues.push({
        level: 'error',
        code: 'LANE_TO_MISSING',
        message: `Lane "${lane.id}" to "${lane.to}" is not a site.`,
        entityId: lane.id,
        hint: 'Add the destination site or correct the to id.',
      })
    }
    if (lane.costPerUnit < 0) {
      issues.push({
        level: 'error',
        code: 'LANE_COST_NEGATIVE',
        message: `Lane "${lane.id}" costPerUnit is negative.`,
        entityId: lane.id,
        hint: 'Set costPerUnit >= 0 ($/unit).',
      })
    }
    if (!(lane.capacity > 0)) {
      capacityIssues++
      issues.push({
        level: 'error',
        code: 'LANE_CAPACITY_NONPOSITIVE',
        message: `Lane "${lane.id}" capacity must be > 0 (got ${lane.capacity}).`,
        entityId: lane.id,
        hint: 'Set a positive lane capacity (units) or a large planning default.',
      })
    }

    // Depth 7 — lane mode options
    if (lane.modes !== undefined) {
      if (!Array.isArray(lane.modes) || lane.modes.length === 0) {
        issues.push({
          level: 'warn',
          code: 'LANE_MODE_EMPTY',
          message: `Lane "${lane.id}" has an empty modes list.`,
          entityId: lane.id,
          hint: 'Remove modes[] (single-mode lane) or add Truck / Rail / Intermodal options.',
        })
      } else {
        const seenModes = new Set<string>()
        let modeCapSum = 0
        let allModesCapped = true
        for (const m of lane.modes) {
          const label = String(m?.mode ?? '').trim()
          const key = label.toLowerCase()
          const ref = `${lane.id}/${label || '?'}`
          if (!label) {
            issues.push({
              level: 'error',
              code: 'LANE_MODE_UNKNOWN',
              message: `Lane "${lane.id}" has a mode option without a mode name.`,
              entityId: lane.id,
              hint: `Set mode to one of ${KNOWN_LANE_MODES.join(', ')}.`,
            })
          } else if (
            !KNOWN_LANE_MODES.some((k) => k.toLowerCase() === key)
          ) {
            issues.push({
              level: 'warn',
              code: 'LANE_MODE_UNKNOWN',
              message: `Lane "${lane.id}" mode "${label}" is not a known planning mode.`,
              entityId: ref,
              hint: `Known modes: ${KNOWN_LANE_MODES.join(', ')} (custom modes use Truck CO₂ factors).`,
            })
          }
          if (key && seenModes.has(key)) {
            issues.push({
              level: 'error',
              code: 'LANE_MODE_DUPLICATE',
              message: `Lane "${lane.id}" lists mode "${label}" more than once.`,
              entityId: ref,
              hint: 'Keep one option per mode per lane (the optimizer uses the first).',
            })
          }
          if (key) seenModes.add(key)
          if (!(Number.isFinite(m.costPerUnit) && m.costPerUnit >= 0)) {
            issues.push({
              level: 'error',
              code: 'LANE_MODE_COST_NEGATIVE',
              message: `Lane "${ref}" costPerUnit must be ≥ 0 (got ${m.costPerUnit}).`,
              entityId: ref,
              hint: 'Set the per-mode $/unit rate.',
            })
          }
          if (!(Number.isFinite(m.leadDays) && m.leadDays >= 0)) {
            issues.push({
              level: 'error',
              code: 'LANE_MODE_LEAD_INVALID',
              message: `Lane "${ref}" leadDays must be a number ≥ 0 (got ${m.leadDays}).`,
              entityId: ref,
              hint: 'Set transit days — used against maxLeadTimeDays for hard service.',
            })
          }
          if (m.capacity != null) {
            if (!(m.capacity > 0)) {
              capacityIssues++
              issues.push({
                level: 'error',
                code: 'LANE_MODE_CAPACITY_NONPOSITIVE',
                message: `Lane "${ref}" capacity must be > 0 (got ${m.capacity}).`,
                entityId: ref,
                hint: 'Omit capacity for an uncapacitated mode or set a positive limit.',
              })
            } else {
              modeCapSum += m.capacity
            }
          } else {
            allModesCapped = false
          }
          if (m.fixedCostM != null && !(m.fixedCostM >= 0)) {
            issues.push({
              level: 'error',
              code: 'LANE_MODE_FIXED_COST_NEGATIVE',
              message: `Lane "${ref}" fixedCostM must be ≥ 0 (got ${m.fixedCostM}).`,
              entityId: ref,
              hint: 'Fixed activation charge in $M (0 = no charge).',
            })
          }
          if (m.co2KgPerUnit != null && !(m.co2KgPerUnit >= 0)) {
            issues.push({
              level: 'error',
              code: 'LANE_MODE_CO2_NEGATIVE',
              message: `Lane "${ref}" co2KgPerUnit must be ≥ 0 (got ${m.co2KgPerUnit}).`,
              entityId: ref,
              hint: 'kg CO₂ per unit shipped on this mode.',
            })
          }
        }
        if (allModesCapped && lane.capacity > 0 && modeCapSum < lane.capacity) {
          issues.push({
            level: 'info',
            code: 'LANE_MODE_CAPACITY_BELOW_LANE',
            message: `Lane "${lane.id}" mode capacities sum to ${modeCapSum} < lane capacity ${lane.capacity}; mode caps bind first.`,
            entityId: lane.id,
            hint: 'Effective lane capacity = min(lane capacity, Σ mode capacities).',
          })
        }
      }
    }

    const routeKey = `${lane.from}→${lane.to}|${String(lane.mode ?? '').toLowerCase()}`
    if (!lane.modes?.length) {
      if (routeModes.has(routeKey)) {
        issues.push({
          level: 'warn',
          code: 'LANE_ROUTE_DUPLICATE',
          message: `Lanes "${routeModes.get(routeKey)}" and "${lane.id}" repeat ${lane.from}→${lane.to} with the same mode.`,
          entityId: lane.id,
          hint: 'The optimizer keeps the last row; use distinct modes (they become alternatives) or merge into modes[].',
        })
      } else {
        routeModes.set(routeKey, lane.id)
      }
    }
  }

  const bomIds = new Set<string>()
  for (const row of pack.bom) {
    if (bomIds.has(row.id)) {
      issues.push({
        level: 'error',
        code: 'DUPLICATE_BOM_ID',
        message: `Duplicate BOM row id "${row.id}".`,
        entityId: row.id,
        hint: 'Make BOM row ids unique.',
      })
    }
    bomIds.add(row.id)

    if (skuIds.size > 0 && !skuIds.has(row.parentSkuId)) {
      issues.push({
        level: 'error',
        code: 'BOM_ORPHAN_PARENT',
        message: `BOM "${row.id}" parent SKU "${row.parentSkuId}" missing.`,
        entityId: row.id,
        hint: 'Add the finished-good SKU or fix parentSkuId.',
      })
    }
    if (skuIds.size > 0 && !skuIds.has(row.childSkuId)) {
      issues.push({
        level: 'error',
        code: 'BOM_ORPHAN_CHILD',
        message: `BOM "${row.id}" child SKU "${row.childSkuId}" missing.`,
        entityId: row.id,
        hint: 'Add the component/RM SKU or fix childSkuId.',
      })
    }
    if (!(row.qtyPerUnit > 0)) {
      issues.push({
        level: 'error',
        code: 'BOM_QTY_NONPOSITIVE',
        message: `BOM "${row.id}" qtyPerUnit must be > 0.`,
        entityId: row.id,
        hint: 'Set qty of child per one parent unit to a positive number.',
      })
    }
    if (row.plantId && !siteIds.has(row.plantId)) {
      issues.push({
        level: 'error',
        code: 'BOM_PLANT_MISSING',
        message: `BOM "${row.id}" plant "${row.plantId}" is not a site.`,
        entityId: row.id,
        hint: 'Point plantId at an existing plant site.',
      })
    }
    if (row.supplierId && !siteIds.has(row.supplierId)) {
      issues.push({
        level: 'error',
        code: 'BOM_SUPPLIER_MISSING',
        message: `BOM "${row.id}" supplier "${row.supplierId}" is not a site.`,
        entityId: row.id,
        hint: 'Point supplierId at an existing supplier site.',
      })
    }
  }

  const cycles = detectBomCycles(pack.bom)
  const bomCycleDetected = cycles.length > 0
  for (const cyc of cycles.slice(0, 5)) {
    issues.push({
      level: 'error',
      code: 'BOM_CYCLE',
      message: `BOM cycle detected: ${cyc.join(' -> ')}.`,
      hint: 'Break the cycle — a parent cannot eventually require itself as a child.',
    })
  }

  return scorecardFromIssues(issues, pack, {
    geocodeHits,
    geocodeTotal,
    orphanDemandCount,
    missingEndpointCount,
    capacityIssues,
    bomCycleDetected,
    demandVolumeTotal,
  })
}

function scorecardFromIssues(
  issues: EnterpriseValidationIssue[],
  pack?: EnterprisePack | null,
  extra?: {
    geocodeHits?: number
    geocodeTotal?: number
    orphanDemandCount?: number
    missingEndpointCount?: number
    capacityIssues?: number
    bomCycleDetected?: boolean
    demandVolumeTotal?: number
  },
): EnterpriseValidationScorecard {
  const errorCount = issues.filter((i) => i.level === 'error').length
  const warnCount = issues.filter((i) => i.level === 'warn').length
  const infoCount = issues.filter((i) => i.level === 'info').length
  const geocodeTotal = extra?.geocodeTotal ?? 0
  const geocodeHits = extra?.geocodeHits ?? 0
  const geocodeCoveragePct =
    geocodeTotal === 0 ? 0 : Math.round((geocodeHits / geocodeTotal) * 100)

  let score = 100
  score -= errorCount * 12
  score -= warnCount * 3
  score -= Math.max(0, 100 - geocodeCoveragePct) / 4
  if (extra?.bomCycleDetected) score -= 15
  score = Math.min(100, Math.max(0, Math.round(score)))

  return {
    schemaVersion: pack?.schemaVersion ?? ENTERPRISE_SCHEMA_VERSION,
    ok: errorCount === 0 && (pack?.sites?.length ?? 0) > 0,
    score,
    errorCount,
    warnCount,
    infoCount,
    geocodeCoveragePct,
    siteCount: pack?.sites?.length ?? 0,
    demandRowCount: pack?.demand?.length ?? 0,
    demandVolumeTotal: Math.round(extra?.demandVolumeTotal ?? 0),
    laneCount: pack?.lanes?.length ?? 0,
    skuCount: pack?.skus?.length ?? 0,
    bomRowCount: pack?.bom?.length ?? 0,
    orphanDemandCount: extra?.orphanDemandCount ?? 0,
    missingEndpointCount: extra?.missingEndpointCount ?? 0,
    capacityIssues: extra?.capacityIssues ?? 0,
    bomCycleDetected: extra?.bomCycleDetected ?? false,
    multiModeLaneCount: (pack?.lanes ?? []).filter(
      (l) => Array.isArray(l.modes) && l.modes.length > 0,
    ).length,
    laneModeOptionCount: (pack?.lanes ?? []).reduce(
      (n, l) => n + (Array.isArray(l.modes) ? l.modes.length : 0),
      0,
    ),
    issues,
  }
}

/** Build enterprise pack from live studio state. */
export function buildEnterprisePack(args: {
  network: UploadedNetwork
  constraints: NetworkConstraints
  productMix: ProductMixState
  bom: BomState
  emissionFactors: EmissionFactor[]
  name?: string
}): EnterprisePack {
  const { network, constraints, productMix, bom, emissionFactors, name } = args
  const cmap = new Map(constraints.facilities.map((f) => [f.nodeId, f]))

  const sites: EnterpriseSite[] = network.nodes.map((n) => {
    const c = cmap.get(n.id)
    const vol =
      n.kind === 'demand'
        ? (network.demandVolume[n.id] ?? parseVolFromCapacity(n.capacity))
        : parseVolFromCapacity(n.capacity)
    const isFac = FACILITY_KINDS.includes(n.kind)
    const status: EnterpriseSiteStatus =
      c?.status ??
      (n.kind === 'candidate' ? 'candidate' : 'open')
    const facCap = productMix.facilityCaps.find((f) => f.nodeId === n.id)
    return {
      id: n.id,
      name: n.name,
      kind: n.kind,
      lat: n.lat,
      lng: n.lng,
      x: n.x,
      y: n.y,
      region: n.region,
      capacityMin: isFac ? (c?.capacityMin ?? Math.round(vol * 0.6)) : 0,
      capacityMax: isFac ? (c?.capacityMax ?? Math.round(vol * 1.25)) : vol,
      fixedCostM: isFac
        ? (c?.fixedCapexM ??
          (n.kind === 'candidate' ? 6 : n.kind === 'plant' ? 8 : 4))
        : 0,
      fixedOpexM: c?.fixedOpexM,
      status: n.kind === 'demand' || n.kind === 'supplier' ? 'open' : status,
      ...(isFac && (c?.capableProductIds?.length || facCap?.capableGroupIds?.length)
        ? {
            capableProductIds:
              c?.capableProductIds ??
              facCap?.capableGroupIds ??
              undefined,
          }
        : {}),
      ...(isFac &&
      (c?.capacityByProduct ||
        (facCap && Object.keys(facCap.capacityByGroup || {}).length > 0))
        ? {
            capacityByProduct:
              c?.capacityByProduct ?? facCap?.capacityByGroup ?? undefined,
          }
        : {}),
    }
  })

  const productGroups: EnterpriseProductGroup[] = productMix.groups.map(
    (g) => ({
      id: g.id,
      name: g.name,
      code: g.code,
      color: g.color,
      description: g.description,
    }),
  )

  const skus: EnterpriseSku[] = productMix.groups.map((g) => ({
    id: `sku-${g.id}`,
    name: g.name,
    code: g.code,
    groupId: g.id,
    handling: g.handling,
  }))

  const skuIdSet = new Set(skus.map((s) => s.id))
  for (const share of bom.fgShares) {
    if (!skuIdSet.has(share.finishedGoodId)) {
      skus.push({
        id: share.finishedGoodId,
        name: share.finishedGoodName,
        code: share.finishedGoodId.toUpperCase().slice(0, 6),
        groupId: productMix.groups[0]?.id,
      })
      skuIdSet.add(share.finishedGoodId)
    }
  }
  for (const row of bom.rows) {
    if (!skuIdSet.has(row.finishedGoodId)) {
      skus.push({
        id: row.finishedGoodId,
        name: row.finishedGoodName,
        code: row.finishedGoodId.toUpperCase().slice(0, 6),
      })
      skuIdSet.add(row.finishedGoodId)
    }
    if (!skuIdSet.has(row.componentId)) {
      skus.push({
        id: row.componentId,
        name: row.componentName,
        code: row.componentId.toUpperCase().slice(0, 6),
      })
      skuIdSet.add(row.componentId)
    }
  }

  const demand: EnterpriseDemand[] = []
  const demandNodes = network.nodes.filter((n) => n.kind === 'demand')
  for (const n of demandNodes) {
    const total = network.demandVolume[n.id] ?? parseVolFromCapacity(n.capacity)
    const mix = productMix.demandMix.find((m) => m.nodeId === n.id)
    if (mix && productMix.groups.length > 0) {
      let allocated = 0
      productMix.groups.forEach((g, ix) => {
        const share = mix.shares[g.id] ?? 0
        const isLast = ix === productMix.groups.length - 1
        const vol = isLast
          ? Math.max(0, Math.round(total - allocated))
          : Math.round((total * share) / 100)
        allocated += vol
        if (vol > 0) {
          demand.push({
            id: `dem-${n.id}-${g.id}`,
            customerId: n.id,
            skuId: `sku-${g.id}`,
            volume: vol,
          })
        }
      })
    } else if (bom.fgShares.length > 0) {
      let allocated = 0
      bom.fgShares.forEach((s, ix) => {
        const isLast = ix === bom.fgShares.length - 1
        const vol = isLast
          ? Math.max(0, Math.round(total - allocated))
          : Math.round((total * s.sharePct) / 100)
        allocated += vol
        if (vol > 0) {
          demand.push({
            id: `dem-${n.id}-${s.finishedGoodId}`,
            customerId: n.id,
            skuId: s.finishedGoodId,
            volume: vol,
          })
        }
      })
    } else {
      const skuId = skus[0]?.id ?? 'sku-default'
      demand.push({
        id: `dem-${n.id}`,
        customerId: n.id,
        skuId,
        volume: Math.max(1, Math.round(total)),
      })
    }
  }

  const lanes: EnterpriseLane[] = network.lanes.map((l) => ({
    id: l.id,
    from: l.from,
    to: l.to,
    mode: l.mode,
    costPerUnit: l.costPerUnit,
    leadDays: l.leadDays,
    capacity: l.capacityUnits && l.capacityUnits > 0 ? l.capacityUnits : 1_000_000,
    co2Kg: l.co2Kg,
    ...(l.modes?.length ? { modes: l.modes.map((m) => ({ ...m })) } : {}),
  }))

  const bomRows: EnterpriseBomRow[] = bom.rows.map((r) => ({
    id: r.id,
    parentSkuId: r.finishedGoodId,
    childSkuId: r.componentId,
    qtyPerUnit: r.qtyPerUnit,
    plantId: r.plantId,
    supplierId: r.preferredSupplierId,
  }))

  const emissionKgPerTonMileByMode: Record<string, number> = {}
  for (const f of emissionFactors) {
    emissionKgPerTonMileByMode[f.mode] = f.kgPerTonMile
  }

  return {
    format: ENTERPRISE_PACK_FORMAT,
    schemaVersion: ENTERPRISE_SCHEMA_VERSION,
    name: name ?? 'Active network',
    sites,
    skus,
    productGroups,
    demand,
    lanes,
    bom: bomRows,
    costFactors: {
      emissionKgPerTonMileByMode,
      transportCostScale: 1,
      uncoveredPenaltyM: 80,
    },
    globals: {
      serviceTargetPct: constraints.serviceTargetPct,
      serviceRadiusMiles: constraints.serviceRadiusMiles,
      capexBudgetM: constraints.capexBudgetM,
      maxFacilities: constraints.maxFacilities,
      ...(constraints.hardServiceConstraints != null
        ? { hardServiceConstraints: constraints.hardServiceConstraints }
        : {}),
      ...(constraints.maxLeadTimeDays != null
        ? { maxLeadTimeDays: constraints.maxLeadTimeDays }
        : {}),
      ...(constraints.aggregateProductsByGroup != null
        ? { aggregateProductsByGroup: constraints.aggregateProductsByGroup }
        : {}),
      ...(constraints.maxProductCommodities != null
        ? { maxProductCommodities: constraints.maxProductCommodities }
        : {}),
      ...(constraints.enforceLaneCapacity != null
        ? { enforceLaneCapacity: constraints.enforceLaneCapacity }
        : {}),
      ...(constraints.carbonPricePerTonne != null
        ? { carbonPricePerTonne: constraints.carbonPricePerTonne }
        : {}),
    },
  }
}

/** Aggregate demand volume by customer site (sum across SKUs). */
export function demandVolumeByCustomer(
  pack: EnterprisePack,
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const d of pack.demand) {
    out[d.customerId] = (out[d.customerId] ?? 0) + d.volume
  }
  return out
}

/** Convert pack -> UploadedNetwork for the map / Data room. */
export function packToUploadedNetwork(pack: EnterprisePack): UploadedNetwork {
  const demandVolume = demandVolumeByCustomer(pack)
  const nodes: NetworkNode[] = pack.sites.map((s) => {
    let x = s.x ?? 50
    let y = s.y ?? 50
    if (s.lat != null && s.lng != null) {
      const xy = latLngToXY(s.lat, s.lng)
      x = xy.x
      y = xy.y
    }
    const vol =
      s.kind === 'demand'
        ? (demandVolume[s.id] ?? s.capacityMax)
        : s.capacityMax
    return {
      id: s.id,
      name: s.name,
      kind: s.kind,
      region: s.region ?? '—',
      capacity:
        s.kind === 'dc'
          ? `${Math.round(vol / 1000)}k pallet`
          : vol >= 1000
            ? `${(vol / 1000).toFixed(1)}k u/wk`
            : `${Math.round(vol)} u/wk`,
      x,
      y,
      ...(s.lat != null && s.lng != null ? { lat: s.lat, lng: s.lng } : {}),
    }
  })

  const lanes: NetworkLane[] = pack.lanes.map((l) => ({
    id: l.id,
    from: l.from,
    to: l.to,
    mode: l.mode,
    costPerUnit: l.costPerUnit,
    leadDays: l.leadDays,
    co2Kg: l.co2Kg ?? 10,
    capacityUnits: l.capacity,
    ...(l.modes?.length ? { modes: l.modes.map((m) => ({ ...m })) } : {}),
  }))

  let geocodeHits = 0
  for (const n of nodes) {
    if (n.lat != null && n.lng != null) geocodeHits++
  }

  const issues: { level: 'error' | 'warn' | 'info'; message: string }[] = []
  const validation = buildValidation(
    nodes,
    lanes,
    demandVolume,
    issues,
    geocodeHits,
    nodes.length,
  )

  return {
    nodes,
    lanes,
    demandVolume,
    source: 'upload',
    fileNames: {},
    validation,
  }
}

/** Convert pack facilities -> NetworkConstraints. */
export function packToConstraints(pack: EnterprisePack): NetworkConstraints {
  const facilities: FacilityConstraint[] = pack.sites
    .filter((s) => FACILITY_KINDS.includes(s.kind))
    .map((s) => ({
      nodeId: s.id,
      status: s.status,
      capacityMin: s.capacityMin,
      capacityMax: s.capacityMax,
      fixedCapexM: s.fixedCostM,
      ...(s.fixedOpexM != null ? { fixedOpexM: s.fixedOpexM } : {}),
      ...(s.capableProductIds?.length
        ? { capableProductIds: s.capableProductIds }
        : {}),
      ...(s.capacityByProduct
        ? { capacityByProduct: s.capacityByProduct }
        : {}),
    }))

  const g = pack.globals ?? {}
  return {
    serviceTargetPct: g.serviceTargetPct ?? 95,
    serviceRadiusMiles: g.serviceRadiusMiles ?? 250,
    capexBudgetM: g.capexBudgetM ?? 30,
    maxFacilities: g.maxFacilities ?? Math.max(3, Math.min(8, facilities.length)),
    ...(g.hardServiceConstraints != null
      ? { hardServiceConstraints: g.hardServiceConstraints }
      : {}),
    ...(g.maxLeadTimeDays != null ? { maxLeadTimeDays: g.maxLeadTimeDays } : {}),
    ...(g.aggregateProductsByGroup != null
      ? { aggregateProductsByGroup: g.aggregateProductsByGroup }
      : {}),
    ...(g.maxProductCommodities != null
      ? { maxProductCommodities: g.maxProductCommodities }
      : {}),
    ...(g.enforceLaneCapacity != null
      ? { enforceLaneCapacity: g.enforceLaneCapacity }
      : {}),
    ...(g.carbonPricePerTonne != null
      ? { carbonPricePerTonne: g.carbonPricePerTonne }
      : {}),
    facilities,
  }
}

/** Convert pack BOM -> BomState-compatible rows (partial). */
export function packToBomRows(pack: EnterprisePack): BomRow[] {
  const skuName = new Map(pack.skus.map((s) => [s.id, s.name]))
  return pack.bom.map((r) => ({
    id: r.id,
    finishedGoodId: r.parentSkuId,
    finishedGoodName: skuName.get(r.parentSkuId) ?? r.parentSkuId,
    componentId: r.childSkuId,
    componentName: skuName.get(r.childSkuId) ?? r.childSkuId,
    componentKind: 'rm',
    qtyPerUnit: r.qtyPerUnit,
    preferredSupplierId: r.supplierId ?? null,
    plantId: r.plantId ?? null,
  }))
}

export type OptimizePayloadFromPack = {
  network: {
    nodes: NetworkNode[]
    lanes: NetworkLane[]
    demandVolume: Record<string, number>
    bomDemand: {
      supplierId: string
      plantId: string
      qtyPerUnit: number
    }[]
    demandByProduct?: {
      customerId: string
      productId: string
      skuId?: string
      volume: number
    }[]
    skus?: EnterpriseSku[]
    productGroups?: EnterpriseProductGroup[]
  }
  constraints: NetworkConstraints
  bom: { rows: BomRow[] }
  enterpriseSchemaVersion: string
  validationOk: boolean
  validationScore: number
}

/**
 * Wire validated pack into MIP optimize payload — capacities, fixed costs,
 * aggregated demand, and BOM supplier->plant arcs.
 */
export function packToOptimizePayload(
  pack: EnterprisePack,
  scorecard?: EnterpriseValidationScorecard,
): OptimizePayloadFromPack {
  const card = scorecard ?? validateEnterprisePack(pack)
  const network = packToUploadedNetwork(pack)
  const constraints = packToConstraints(pack)
  const bomRows = packToBomRows(pack)

  const bomDemand: OptimizePayloadFromPack['network']['bomDemand'] = []
  const seen = new Set<string>()
  for (const r of pack.bom) {
    if (!r.supplierId || !r.plantId) continue
    const key = `${r.supplierId}|${r.plantId}|${r.childSkuId}`
    if (seen.has(key)) continue
    seen.add(key)
    bomDemand.push({
      supplierId: r.supplierId,
      plantId: r.plantId,
      qtyPerUnit: r.qtyPerUnit,
    })
  }

  const demandByProduct = pack.demand
    .filter((d) => d.volume > 0 && d.skuId)
    .map((d) => ({
      customerId: d.customerId,
      productId: d.skuId,
      skuId: d.skuId,
      volume: d.volume,
    }))

  return {
    network: {
      nodes: network.nodes,
      lanes: network.lanes,
      demandVolume: network.demandVolume,
      bomDemand,
      ...(demandByProduct.length ? { demandByProduct } : {}),
      ...(pack.skus.length ? { skus: pack.skus } : {}),
      ...(pack.productGroups.length
        ? { productGroups: pack.productGroups }
        : {}),
    },
    constraints,
    bom: { rows: bomRows },
    enterpriseSchemaVersion: ENTERPRISE_SCHEMA_VERSION,
    validationOk: card.ok,
    validationScore: card.score,
  }
}

export function parseEnterprisePackJson(
  raw: unknown,
): { pack: EnterprisePack; scorecard: EnterpriseValidationScorecard } | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Partial<EnterprisePack>
  if (
    obj.format !== ENTERPRISE_PACK_FORMAT &&
    !(Array.isArray(obj.sites) && Array.isArray(obj.demand))
  ) {
    return null
  }
  const pack: EnterprisePack = {
    format: ENTERPRISE_PACK_FORMAT,
    schemaVersion:
      (obj.schemaVersion as typeof ENTERPRISE_SCHEMA_VERSION) ||
      ENTERPRISE_SCHEMA_VERSION,
    name: obj.name,
    sites: Array.isArray(obj.sites) ? (obj.sites as EnterpriseSite[]) : [],
    skus: Array.isArray(obj.skus) ? (obj.skus as EnterpriseSku[]) : [],
    productGroups: Array.isArray(obj.productGroups)
      ? (obj.productGroups as EnterpriseProductGroup[])
      : [],
    demand: Array.isArray(obj.demand) ? (obj.demand as EnterpriseDemand[]) : [],
    lanes: Array.isArray(obj.lanes) ? (obj.lanes as EnterpriseLane[]) : [],
    bom: Array.isArray(obj.bom) ? (obj.bom as EnterpriseBomRow[]) : [],
    costFactors: obj.costFactors ?? {
      emissionKgPerTonMileByMode: Object.fromEntries(
        DEFAULT_EMISSION_FACTORS.map((f) => [f.mode, f.kgPerTonMile]),
      ),
    },
    globals: obj.globals,
  }
  return { pack, scorecard: validateEnterprisePack(pack) }
}

export function downloadEnterprisePack(pack: EnterprisePack, filename?: string) {
  const blob = new Blob([JSON.stringify(pack, null, 2)], {
    type: 'application/json',
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download =
    filename ??
    `${(pack.name ?? 'enterprise-pack').replace(/[^\w.-]+/g, '_')}.enterprise.json`
  a.click()
  URL.revokeObjectURL(url)
}

export function emissionFactorsFromPack(
  pack: EnterprisePack,
): EmissionFactor[] {
  const entries = Object.entries(
    pack.costFactors.emissionKgPerTonMileByMode ?? {},
  )
  if (entries.length === 0) return DEFAULT_EMISSION_FACTORS.map((f) => ({ ...f }))
  return entries.map(([mode, kg]) => ({
    mode,
    kgPerTonMile: kg,
    notes: 'From enterprise pack cost factors',
  }))
}

/**
 * Depth 7: Truck / Intermodal / Rail options for stress plant→DC lanes.
 * Integer-milli math keeps the JSON identical to the checked-in samples.
 */
export function stressLaneModes(cost: number, lead: number): EnterpriseLaneMode[] {
  const cm = Math.round(cost * 1000)
  return [
    { mode: 'Truck', costPerUnit: cm / 1000, leadDays: lead, capacity: 30000, co2KgPerUnit: 12 },
    {
      mode: 'Intermodal',
      costPerUnit: (cm * 82) / 100 / 1000,
      leadDays: lead + 1,
      capacity: 20000,
      co2KgPerUnit: 5,
      fixedCostM: 0.02,
    },
    {
      mode: 'Rail',
      costPerUnit: (cm * 7) / 10 / 1000,
      leadDays: lead + 2,
      capacity: 15000,
      co2KgPerUnit: 2.5,
      fixedCostM: 0.05,
    },
  ]
}

/** Generate a larger stress sample (100+ demand nodes) for public/samples. */
export function generateStressSamplePack(opts?: {
  demandCount?: number
  dcCount?: number
  plantCount?: number
  name?: string
}): EnterprisePack {
  const demandCount = opts?.demandCount ?? 120
  const dcCount = opts?.dcCount ?? 8
  const plantCount = opts?.plantCount ?? 3
  const sites: EnterpriseSite[] = []
  const demand: EnterpriseDemand[] = []
  const lanes: EnterpriseLane[] = []

  const plants = [
    { name: 'Austin Plant', lat: 30.27, lng: -97.74 },
    { name: 'Columbus Plant', lat: 39.96, lng: -82.99 },
    { name: 'Ontario Plant', lat: 34.06, lng: -117.65 },
  ]
  for (let i = 0; i < plantCount; i++) {
    const p = plants[i % plants.length]
    const id = `plt-${i + 1}`
    sites.push({
      id,
      name: i < plants.length ? p.name : `Plant ${i + 1}`,
      kind: 'plant',
      lat: p.lat + (i > 2 ? (i % 5) * 0.4 : 0),
      lng: p.lng + (i > 2 ? (i % 3) * 0.5 : 0),
      region: 'NA',
      capacityMin: 5000,
      capacityMax: 80000,
      fixedCostM: 0,
      fixedOpexM: 1.2,
      status: 'open',
    })
  }

  const dcSeeds = [
    { name: 'Atlanta DC', lat: 33.75, lng: -84.39 },
    { name: 'Dallas DC', lat: 32.78, lng: -96.8 },
    { name: 'Chicago DC', lat: 41.88, lng: -87.63 },
    { name: 'Reno DC', lat: 39.53, lng: -119.81 },
    { name: 'Newark DC', lat: 40.74, lng: -74.17 },
    { name: 'Denver DC', lat: 39.74, lng: -104.99 },
    { name: 'Seattle DC', lat: 47.61, lng: -122.33 },
    { name: 'Miami DC', lat: 25.76, lng: -80.19 },
    { name: 'Kansas City Cand', lat: 39.1, lng: -94.58 },
    { name: 'Phoenix Cand', lat: 33.45, lng: -112.07 },
  ]
  for (let i = 0; i < dcCount; i++) {
    const seed = dcSeeds[i % dcSeeds.length]
    const id = `dc-${i + 1}`
    const isCand = i >= dcCount - 2
    sites.push({
      id,
      name: seed.name,
      kind: isCand ? 'candidate' : 'dc',
      lat: seed.lat,
      lng: seed.lng,
      region: 'NA',
      capacityMin: 0,
      capacityMax: 25000,
      fixedCostM: isCand ? 6 : 0,
      fixedOpexM: 0.7,
      status: isCand ? 'candidate' : 'open',
    })
  }

  sites.push({
    id: 'sup-1',
    name: 'Monterrey Sup',
    kind: 'supplier',
    lat: 25.67,
    lng: -100.31,
    region: 'MX',
    capacityMin: 0,
    capacityMax: 100000,
    fixedCostM: 0,
    status: 'open',
  })

  const latMin = 26
  const latMax = 48
  const lngMin = -122
  const lngMax = -72
  const cols = Math.ceil(Math.sqrt(demandCount * 1.6))
  const rows = Math.ceil(demandCount / cols)
  let n = 0
  for (let r = 0; r < rows && n < demandCount; r++) {
    for (let c = 0; c < cols && n < demandCount; c++) {
      n++
      const id = `dem-${n}`
      const lat = latMin + ((latMax - latMin) * (r + 0.5)) / rows
      const lng = lngMin + ((lngMax - lngMin) * (c + 0.5)) / cols
      const volume = Math.round(400 + ((n * 37) % 900) + (n % 7) * 50)
      sites.push({
        id,
        name: `Market ${n}`,
        kind: 'demand',
        lat: Math.round(lat * 100) / 100,
        lng: Math.round(lng * 100) / 100,
        region: lng < -100 ? 'West' : lng < -90 ? 'Central' : 'East',
        capacityMin: 0,
        capacityMax: volume,
        fixedCostM: 0,
        status: 'open',
      })
      demand.push({
        id: `drow-${n}-fg`,
        customerId: id,
        skuId: 'sku-fg-a',
        volume: Math.round(volume * 0.6),
      })
      demand.push({
        id: `drow-${n}-fgb`,
        customerId: id,
        skuId: 'sku-fg-b',
        volume: Math.round(volume * 0.4),
      })
    }
  }

  let laneN = 0
  const plantIds = sites.filter((s) => s.kind === 'plant').map((s) => s.id)
  const dcIds = sites
    .filter((s) => s.kind === 'dc' || s.kind === 'candidate')
    .map((s) => s.id)
  for (const p of plantIds) {
    for (const d of dcIds) {
      laneN++
      lanes.push({
        id: `ln-${laneN}`,
        from: p,
        to: d,
        mode: laneN % 3 === 0 ? 'Rail' : 'Truck',
        costPerUnit: 0.4 + (laneN % 10) * 0.05,
        leadDays: 2 + (laneN % 5),
        capacity: 50000,
        co2Kg: 10,
        modes: stressLaneModes(0.4 + (laneN % 10) * 0.05, 2 + (laneN % 5)),
      })
    }
  }
  lanes.push({
    id: `ln-sup`,
    from: 'sup-1',
    to: plantIds[0]!,
    mode: 'Truck',
    costPerUnit: 1.1,
    leadDays: 3,
    capacity: 80000,
    co2Kg: 18,
  })

  const dcs = sites.filter((s) => s.kind === 'dc' || s.kind === 'candidate')
  for (const dem of sites.filter((s) => s.kind === 'demand')) {
    const ranked = [...dcs]
      .map((dc) => ({
        dc,
        d:
          Math.abs((dc.lat ?? 0) - (dem.lat ?? 0)) +
          Math.abs((dc.lng ?? 0) - (dem.lng ?? 0)),
      }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 2)
    for (const { dc, d } of ranked) {
      laneN++
      lanes.push({
        id: `ln-${laneN}`,
        from: dc.id,
        to: dem.id,
        mode: 'Truck',
        costPerUnit: 0.25 + d * 0.02,
        leadDays: 1 + Math.floor(d / 5),
        capacity: 20000,
        co2Kg: 6,
      })
    }
  }

  return {
    format: ENTERPRISE_PACK_FORMAT,
    schemaVersion: ENTERPRISE_SCHEMA_VERSION,
    name: opts?.name ?? `Stress ${demandCount} demand nodes`,
    sites,
    skus: [
      { id: 'sku-fg-a', name: 'Finished Good A', code: 'FGA', groupId: 'ambient' },
      { id: 'sku-fg-b', name: 'Finished Good B', code: 'FGB', groupId: 'chilled' },
      { id: 'sku-rm-1', name: 'Resin RM', code: 'RM1', groupId: 'ambient' },
    ],
    productGroups: [
      { id: 'ambient', name: 'Ambient', code: 'AMB', color: '#34d399' },
      { id: 'chilled', name: 'Chilled', code: 'CHL', color: '#38bdf8' },
    ],
    demand,
    lanes,
    bom: [
      {
        id: 'bom-1',
        parentSkuId: 'sku-fg-a',
        childSkuId: 'sku-rm-1',
        qtyPerUnit: 1.2,
        plantId: plantIds[0],
        supplierId: 'sup-1',
      },
      {
        id: 'bom-2',
        parentSkuId: 'sku-fg-b',
        childSkuId: 'sku-rm-1',
        qtyPerUnit: 0.8,
        plantId: plantIds[0],
        supplierId: 'sup-1',
      },
    ],
    costFactors: {
      emissionKgPerTonMileByMode: Object.fromEntries(
        DEFAULT_EMISSION_FACTORS.map((f) => [f.mode, f.kgPerTonMile]),
      ),
      transportCostScale: 1,
      uncoveredPenaltyM: 80,
    },
    globals: {
      serviceTargetPct: 92,
      serviceRadiusMiles: 400,
      capexBudgetM: 40,
      maxFacilities: 10,
    },
  }
}
