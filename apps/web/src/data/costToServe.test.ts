/**
 * Lightweight CTS fidelity checks (tsx).
 */
import assert from 'node:assert/strict'
import {
  computeCostToServe,
  computeCostToServeFromMip,
} from './costToServe'
import type { NetworkNode, Scenario } from './sampleNetwork'

const nodes: NetworkNode[] = [
  {
    id: 'dc1',
    name: 'Atlanta DC',
    kind: 'dc',
    region: 'East',
    capacity: '20k',
    x: 50,
    y: 50,
  },
  {
    id: 'd1',
    name: 'Customer A',
    kind: 'demand',
    region: 'East',
    capacity: '5k',
    x: 55,
    y: 50,
  },
  {
    id: 'd2',
    name: 'Customer B',
    kind: 'demand',
    region: 'East',
    capacity: '3k',
    x: 60,
    y: 50,
  },
]

function mipScenario(): Scenario {
  return {
    id: 'opt-1',
    name: 'MIP test',
    tag: 'Optimize',
    kpis: {
      cost: { value: '$12.0M', delta: '—', better: true },
      service: { value: '100%', delta: '—', better: true },
      capex: { value: '$0M', delta: '—', better: true },
      co2: { value: '5.0kt', delta: '—', better: true },
      risk: { value: 'Low', delta: '—', better: true },
    },
    optimizeMeta: {
      heuristic: 'pulp-highs',
      openedIds: [],
      closedIds: [],
      servicePct: 100,
      capexUsedM: 0,
      model: 'fixed-charge-multi-echelon-v1',
      status: 'Optimal',
      solveSeconds: 0.02,
      objectiveBreakdown: {
        totalM: 3.5,
        transportM: 2.5,
        fixedCapexM: 0,
        fixedOpexM: 1.0,
        uncoveredPenaltyM: 0,
      },
      openFacilities: [
        {
          id: 'dc1',
          name: 'Atlanta DC',
          kind: 'dc',
          fixedCapexM: 0,
          fixedOpexM: 1.0,
          throughput: 8000,
          capacityMax: 20000,
          utilizationPct: 40,
        },
      ],
      flows: [
        {
          from: 'dc1',
          to: 'd1',
          volume: 5000,
          echelon: 'dc→customer',
          unitCost: 0.0003,
          transportCostM: 1.5,
        },
        {
          from: 'dc1',
          to: 'd2',
          volume: 3000,
          echelon: 'dc→customer',
          unitCost: 0.000333,
          transportCostM: 1.0,
        },
      ],
    },
  }
}

function testMipCtsFidelity() {
  const scenario = mipScenario()
  const result = computeCostToServeFromMip({
    scenario,
    nodes,
    demandVolume: { d1: 5000, d2: 3000 },
  })
  assert.ok(result)
  assert.equal(result!.source, 'mip')
  assert.ok((result!.fidelityGapM ?? 99) < 0.05)
  assert.ok(Math.abs(result!.transportTotalM - 2.5) < 0.05)
  assert.ok(Math.abs(result!.variableTotalM - 3.5) < 0.05)
  const a = result!.rows.find((r) => r.id === 'd1')
  assert.ok(a)
  assert.equal(a!.serviceDcId, 'dc1')
  assert.equal(a!.serviceDc, 'Atlanta DC')
}

function testComputePrefersMip() {
  const scenario = mipScenario()
  const result = computeCostToServe({
    scenario,
    nodes,
    lanes: [],
    demandVolume: { d1: 5000, d2: 3000 },
  })
  assert.equal(result.source, 'mip')
  assert.ok(result.rows.every((r) => r.serviceDcId === 'dc1'))
}

const tests: [string, () => void][] = [
  ['MIP CTS fidelity vs objective', testMipCtsFidelity],
  ['computeCostToServe prefers MIP', testComputePrefersMip],
]

let failed = 0
for (const [name, fn] of tests) {
  try {
    fn()
    console.log(`ok  - ${name}`)
  } catch (err) {
    failed++
    console.error(`FAIL - ${name}`)
    console.error(err)
  }
}
if (failed) process.exit(1)
console.log(`\n${tests.length - failed}/${tests.length} passed`)
