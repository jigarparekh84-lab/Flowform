/**
 * Regression checks for the D-0x defect fixes that live in the web data layer (tsx).
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { scoreResilience } from './resilience'
import type { UploadedNetwork } from './csvParsers'
import type { NetworkConstraints, Scenario } from './sampleNetwork'

const sample = JSON.parse(
  readFileSync(new URL('../../public/samples/na-footprint-2027.flowform.json', import.meta.url), 'utf8'),
).state as { network: UploadedNetwork; constraints: NetworkConstraints; scenarios: Scenario[] }

const baseline = sample.scenarios.find((s) => s.id === 'baseline') ?? sample.scenarios[0]

// D-08: on Baseline only genuine single points of failure are critical.
const r = scoreResilience({
  network: sample.network,
  constraints: sample.constraints,
  scenario: baseline,
  thresholdPct: 95,
})
console.log('resilience', r.score, r.baselineServicePct, r.ranked.map((n) => `${n.nodeId}:${n.serviceAfterPct}/${n.dropPp}`).join(' '), 'critical', r.critical.map((c) => c.nodeId).join(','))
assert.ok(r.critical.length < r.facilityCount, 'not every site may be critical')
for (const c of r.critical) assert.ok(c.dropPp > 0, `${c.nodeId} critical with 0pp drop`)
const reno = r.ranked.find((n) => n.nodeId === 'n8')
assert.ok(reno && reno.dropPp === 0, 'Reno serves nobody within radius → no drop')
assert.ok(!r.critical.some((c) => c.nodeId === 'n8'), 'Reno is not a SPOF')
assert.ok(r.critical.some((c) => c.nodeId === 'n1'), 'Austin (sole plant) is a SPOF')
assert.ok(r.baselineServicePct > 95, 'lanes count as reachability')

// A site whose loss costs nothing is never critical, even below threshold.
const tight = scoreResilience({
  network: sample.network,
  constraints: { ...sample.constraints, serviceRadiusMiles: 1 },
  scenario: baseline,
  thresholdPct: 99.9,
})
for (const c of tight.critical) assert.ok(c.dropPp >= 0.5)

console.log('defectFixes: ok')

// Baseline KPIs come from the API's as-is costing, not the $48.2M seed.
import('./baselineKpis').then(({ baselineKpisFromApi }) => {
  const k = baselineKpisFromApi({
    status: 'Optimal',
    kpis: { servicePct: 100, capexUsedM: 0, costM: 99.0, co2Kt: 2703.5 },
  })
  assert.ok(k)
  assert.equal(k.cost.value, '$99.0M')
  assert.equal(k.co2.value, '2703.5 kt')
  assert.equal(baselineKpisFromApi({ status: 'Infeasible' }), null)
  console.log('baselineKpis: ok')
})
