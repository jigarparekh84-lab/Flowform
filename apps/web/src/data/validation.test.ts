/** FF-108: guardrail helpers (blocking reason + shortfall tables). */
import assert from 'node:assert/strict'
import { blockingReason, shortfallTables, type ValidationResult } from './validation'

const v: ValidationResult = {
  ok: false, blocking: true, errorCount: 2, warningCount: 0,
  issues: [
    { code: 'NO_DEMAND', level: 'error', message: 'There is no customer demand to serve.', entities: [], fix: 'Add demand.' },
    { code: 'NO_FACILITIES', level: 'error', message: 'No DCs.', entities: [], fix: null },
  ],
  shortfalls: { laneCapacity: [], minThroughput: [] },
}
assert.equal(blockingReason(v), 'Run blocked — There is no customer demand to serve. Fix: Add demand. (+1 more)')
assert.equal(blockingReason({ ...v, issues: [] }), '')

// Hints exactly as the engine returns them for sample with l9 cap 1000 (G-INF golden)
const t = shortfallTables([
  { code: 'MIN_THROUGHPUT_CONFLICT', shortfalls: [{ facilityId: 'n2', capacityMin: 10800, feasibleThroughput: 10200, gap: 600 }] },
  { code: 'LANE_CAPACITY_CONFLICT', shortfalls: [{ laneId: 'l9', from: 'n2', to: 'n6', capacityUnits: 1000, requiredFlow: 2280, shortBy: 1280 }] },
  { code: 'OTHER' },
])
assert.equal(t.minThroughput[0].gap, 600)
assert.equal(t.laneCapacity[0].shortBy, 1280)
assert.deepEqual(shortfallTables(undefined), { laneCapacity: [], minThroughput: [] })
console.log('validation: ok')
