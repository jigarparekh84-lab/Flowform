/**
 * Multi-echelon lite inventory policy — per DC/plant safety stock.
 * Formulas: simple z·σ·√LT, or ASCM combined demand + lead-time uncertainty.
 */

import type { UploadedNetwork } from './csvParsers'
import type { NetworkNode } from './sampleNetwork'

export type SafetyStockFormula = 'simple' | 'ascm-combined'

export type InventoryNodePolicy = {
  nodeId: string
  /** Fill-rate / cycle service target 0–100. */
  serviceTargetPct: number
  /** Replenishment lead time (days). */
  leadTimeDays: number
  /** Demand standard deviation (units / day). */
  demandSigma: number
  /** Mean daily demand (units / day) — used by ASCM combined. */
  meanDemandPerDay: number
  /** Lead-time σ (days) — used by ASCM combined. */
  leadTimeSigma: number
  /** Holding cost $ per unit per year. */
  holdingCostPerUnit: number
}

export type InventoryPolicyState = {
  formula: SafetyStockFormula
  nodes: InventoryNodePolicy[]
}

export type InventoryNodeResult = InventoryNodePolicy & {
  name: string
  kind: string
  region: string
  z: number
  safetyStockUnits: number
  inventoryDollars: number
}

export type InventoryRollup = {
  formula: SafetyStockFormula
  nodes: InventoryNodeResult[]
  totalUnits: number
  totalDollars: number
  /** Millions USD for KPI display. */
  totalDollarsM: number
}

/** Approximate Φ⁻¹(p) for p in (0.5, 1) via Acklam rational approximation. */
export function normInv(p: number): number {
  const clamped = Math.min(0.9999, Math.max(0.5001, p))
  // For service levels we use upper tail; symmetric around 0.5
  const pp = clamped
  // Coefficients from Peter Acklam's approximation
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.383577459334652e2, -3.066479806614716e1, 2.506628277459239e0,
  ]
  const b = [
    -5.447609879822406e1, 1.615858368580577e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1,
  ]
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838e0,
    -2.549732539343734e0, 4.374664141464968e0, 2.938163982698783e0,
  ]
  const d = [
    7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996e0,
    3.754408661907416e0,
  ]
  const plow = 0.02425
  const phigh = 1 - plow
  let q: number
  let r: number
  if (pp < plow) {
    q = Math.sqrt(-2 * Math.log(pp))
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    )
  }
  if (pp <= phigh) {
    q = pp - 0.5
    r = q * q
    return (
      ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
    )
  }
  q = Math.sqrt(-2 * Math.log(1 - pp))
  return -(
    (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
    ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  )
}

export function zFromServicePct(serviceTargetPct: number): number {
  const p = Math.min(99.99, Math.max(50.01, serviceTargetPct)) / 100
  return Math.round(normInv(p) * 1000) / 1000
}

/** Simple: SS = z · σ_d · √LT */
export function safetyStockSimple(
  z: number,
  demandSigma: number,
  leadTimeDays: number,
): number {
  const lt = Math.max(0, leadTimeDays)
  return Math.max(0, z * demandSigma * Math.sqrt(lt))
}

/**
 * ASCM-style combined uncertainty:
 * SS = z · √(LT · σ_d² + d̄² · σ_LT²)
 */
export function safetyStockAscmCombined(
  z: number,
  demandSigma: number,
  leadTimeDays: number,
  meanDemandPerDay: number,
  leadTimeSigma: number,
): number {
  const lt = Math.max(0, leadTimeDays)
  const varDemand = lt * demandSigma * demandSigma
  const varLead =
    meanDemandPerDay * meanDemandPerDay * leadTimeSigma * leadTimeSigma
  return Math.max(0, z * Math.sqrt(varDemand + varLead))
}

function parseVolume(capacity: string): number {
  const m = capacity.replace(/,/g, '').match(/([\d.]+)/)
  if (!m) return 1000
  let v = parseFloat(m[1])
  if (/k/i.test(capacity)) v *= 1000
  return v
}

function stockNodes(nodes: NetworkNode[]): NetworkNode[] {
  return nodes.filter((n) => n.kind === 'dc' || n.kind === 'plant')
}

/** Seed policies for each DC/plant from network + inbound lead times. */
export function defaultInventoryPolicies(
  network: UploadedNetwork,
): InventoryPolicyState {
  const facilities = stockNodes(network.nodes)
  const demandTotal =
    Object.values(network.demandVolume).reduce((s, v) => s + v, 0) || 1
  const nodes: InventoryNodePolicy[] = facilities.map((n, i) => {
    const inbound = network.lanes.filter((l) => l.to === n.id)
    const avgLead =
      inbound.length > 0
        ? inbound.reduce((s, l) => s + l.leadDays, 0) / inbound.length
        : 3 + (i % 3)
    const cap = parseVolume(n.capacity)
    // Share of weekly demand attributed to this site (rough).
    const share = cap / facilities.reduce((s, f) => s + parseVolume(f.capacity), 0)
    const weekly = demandTotal * share
    const meanPerDay = weekly / 7
    const demandSigma = Math.max(5, meanPerDay * (0.18 + (i % 4) * 0.03))
    return {
      nodeId: n.id,
      serviceTargetPct: 95,
      leadTimeDays: Math.round(avgLead * 10) / 10,
      demandSigma: Math.round(demandSigma * 10) / 10,
      meanDemandPerDay: Math.round(meanPerDay * 10) / 10,
      leadTimeSigma: Math.round(avgLead * 0.2 * 10) / 10,
      holdingCostPerUnit: n.kind === 'plant' ? 12 : 18,
    }
  })
  return { formula: 'ascm-combined', nodes }
}

/** Merge existing policies with network (add missing, drop removed). */
export function mergeInventoryPolicies(
  prev: InventoryPolicyState | null | undefined,
  network: UploadedNetwork,
): InventoryPolicyState {
  const fresh = defaultInventoryPolicies(network)
  if (!prev) return fresh
  const byId = new Map(prev.nodes.map((n) => [n.nodeId, n]))
  return {
    formula: prev.formula ?? fresh.formula,
    nodes: fresh.nodes.map((n) => {
      const old = byId.get(n.nodeId)
      return old ? { ...n, ...old, nodeId: n.nodeId } : n
    }),
  }
}

export function computeInventoryRollup(
  policy: InventoryPolicyState,
  network: UploadedNetwork,
): InventoryRollup {
  const nodeMap = new Map(network.nodes.map((n) => [n.id, n]))
  const results: InventoryNodeResult[] = policy.nodes.map((p) => {
    const n = nodeMap.get(p.nodeId)
    const z = zFromServicePct(p.serviceTargetPct)
    const ss =
      policy.formula === 'simple'
        ? safetyStockSimple(z, p.demandSigma, p.leadTimeDays)
        : safetyStockAscmCombined(
            z,
            p.demandSigma,
            p.leadTimeDays,
            p.meanDemandPerDay,
            p.leadTimeSigma,
          )
    const units = Math.round(ss)
    const dollars = units * p.holdingCostPerUnit
    return {
      ...p,
      name: n?.name ?? p.nodeId,
      kind: n?.kind ?? 'dc',
      region: n?.region ?? '—',
      z,
      safetyStockUnits: units,
      inventoryDollars: Math.round(dollars),
    }
  })
  const totalUnits = results.reduce((s, r) => s + r.safetyStockUnits, 0)
  const totalDollars = results.reduce((s, r) => s + r.inventoryDollars, 0)
  return {
    formula: policy.formula,
    nodes: results,
    totalUnits,
    totalDollars,
    totalDollarsM: Math.round((totalDollars / 1_000_000) * 1000) / 1000,
  }
}

export function formatInvDollars(dollars: number): string {
  if (dollars >= 1_000_000) return `$${(dollars / 1_000_000).toFixed(2)}M`
  if (dollars >= 1000) return `$${(dollars / 1000).toFixed(0)}k`
  return `$${dollars.toFixed(0)}`
}

export function formatInvUnits(units: number): string {
  if (units >= 1000) return `${(units / 1000).toFixed(1)}k u`
  return `${units} u`
}
