/** FF-115: narrative numbers all trace to result fields. Values from G-S / G-EXP-S goldens. */
import assert from 'node:assert/strict'
import { buildRunNarrative, untracedNumbers } from './narrative'
import type { OptimizeMeta } from './sampleNetwork'

const names: Record<string, string> = { n8: 'Reno DC', n3: 'Atlanta DC', n2: 'Columbus DC' }
const meta = {
  heuristic: 'pulp-highs', status: 'Optimal', openedIds: [], closedIds: ['n8'], servicePct: 100, capexUsedM: 0,
  objectiveBreakdown: { totalM: 98.2706, transportM: 95.6706, fixedCapexM: 0, fixedOpexM: 2.6, uncoveredPenaltyM: 0 },
  explain: { facilities: [
    { facilityId: 'n3', name: 'Atlanta DC', open: true, flipCostM: 0.8504 },
    { facilityId: 'n2', name: 'Columbus DC', open: true, flipCostM: null },
  ] },
} as unknown as OptimizeMeta

const n = buildRunNarrative(meta, (id) => names[id] ?? id)
console.log(n.headline)
n.sentences.forEach((s) => console.log(' -', s.text))
assert.equal(n.headline, 'Change the network: $98.27M at 100.0% service.')
assert.ok(n.sentences.some((s) => s.text === 'Recommendation: close Reno DC.'))
assert.ok(n.sentences.some((s) => s.text === 'Closing Atlanta DC instead would add $850k to total cost.'))
for (const s of n.sentences) assert.deepEqual(untracedNumbers(s), [], s.text)

const withCapex = buildRunNarrative({ ...meta, openedIds: ['k'], closedIds: [], objectiveBreakdown: { ...meta.objectiveBreakdown!, fixedCapexM: 6, uncoveredPenaltyM: 0.3 } })
for (const s of withCapex.sentences) assert.deepEqual(untracedNumbers(s), [], s.text)
assert.ok(withCapex.sentences[0].text.includes('$6.00M one-off investment') && withCapex.sentences[0].text.includes('$300k penalty'))

// A sentence with an invented number is caught.
assert.deepEqual(untracedNumbers({ text: 'Saves $5.00M.', sources: [{ field: 'x', value: 4 }] }), ['$5.00M'])

const inf = buildRunNarrative({ ...meta, status: 'Infeasible', infeasibilityReport: { status: 'Infeasible', summary: 'l9 cap 1000 vs needed 2280', hints: [] } })
assert.ok(inf.headline.startsWith('No feasible network'))
for (const s of inf.sentences) assert.deepEqual(untracedNumbers(s), [], s.text)
console.log('narrative: ok')
