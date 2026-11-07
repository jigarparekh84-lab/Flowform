/**
 * Generates apps/api/tests/fixtures/enterprise-pack-parity.json.
 *
 * The Python port in apps/engine/flowform_engine/pack_validation.py must return
 * exactly what this validator returns — same issues, same order, same scorecard —
 * including for malformed input, where the TS side relies on JavaScript coercion
 * (`undefined` vs `null`, `Number("  ") === 0`, template-literal number
 * formatting). The fixture records that ground truth; the Python test replays it.
 *
 * Regenerate after an intentional change to either side:
 *
 *   cd apps/web && npm run gen:pack-parity
 *
 * The fixture is checked in, so the Python suite needs no Node at test time.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { validateEnterprisePack } from '../src/data/enterprisePack'

const here = dirname(fileURLToPath(import.meta.url))
const samplesDir = resolve(here, '../public/samples')
const outFile = resolve(here, '../../api/tests/fixtures/enterprise-pack-parity.json')

function sample(name: string): unknown {
  return JSON.parse(readFileSync(resolve(samplesDir, name), 'utf8'))
}

/** Packs that exercise the validator's branches, including hostile coercion. */
const synthetic: Array<{ name: string; pack: unknown }> = [
  { name: 'null', pack: null },
  { name: 'undefined', pack: undefined },
  { name: 'empty-object', pack: {} },
  { name: 'sites-not-array', pack: { sites: 'nope' } },
  { name: 'empty-sites', pack: { sites: [] } },
  { name: 'empty-sites-and-demand', pack: { sites: [], demand: [] } },
  {
    name: 'schema-mismatch',
    pack: { format: 'other', schemaVersion: 2, sites: [{ id: 'a', kind: 'dc', status: 'open' }] },
  },
  {
    name: 'schema-nullish',
    pack: { format: null, schemaVersion: undefined, sites: [{ id: 'a', kind: 'dc', status: 'open' }] },
  },
  {
    name: 'site-field-errors',
    pack: {
      format: 'flowform-enterprise-pack',
      schemaVersion: 'enterprise-data-v1',
      sites: [
        { id: 'a', name: 'A', kind: 'dc', status: 'open', lat: 40, lng: -80, capacityMax: 5000 },
        { id: 'a', name: 'Dup', kind: 'dc', status: 'open', lat: 41, lng: -81, capacityMax: 5000 },
        { id: 'b', kind: 'warehouse', status: 'weird', capacityMax: 0 },
        { id: 'c', kind: 'plant', status: 'open', capacityMax: -5, capacityMin: 10 },
        { id: 'd', kind: 'candidate', status: 'candidate', capacityMax: 100, capacityMin: 200 },
        { id: 'e', kind: 'dc', status: 'open', capacityMax: 100, fixedCostM: -3 },
        { id: 'f', kind: 'dc', status: 'open', capacityMax: '  ' , lat: null, lng: null },
      ],
      demand: [],
    },
  },
  {
    name: 'sku-group-weights',
    pack: {
      format: 'flowform-enterprise-pack',
      schemaVersion: 'enterprise-data-v1',
      sites: [
        { id: 'p1', kind: 'plant', status: 'open', lat: 1, lng: 1, capacityMax: 10000 },
        { id: 'd1', kind: 'demand', status: 'open', lat: 2, lng: 2 },
      ],
      productGroups: [
        { id: 'g1', name: 'Ambient', unitWeightKg: 20 },
        { id: 'g1', name: 'Dup', unitWeightKg: 20 },
        { id: 'g2', name: 'Bad', unitWeightKg: 0 },
        { id: 'g3', name: 'Implausible', unitWeightKg: 100000 },
        { id: 'g4', name: 'Stringy', unitWeightKg: '25' },
      ],
      skus: [
        { id: 's1', groupId: 'g1', unitWeightKg: 20 },
        { id: 's1', groupId: 'g1', unitWeightKg: 20 },
        { id: 's2', groupId: 'missing' },
        { id: 's3', groupId: 'g2', unitWeightKg: -1 },
        { id: 's4', groupId: 'g3', unitWeightKg: 0.001 },
        { id: 's5', groupId: 'g4', unitWeightKg: '30' },
        { id: 's6', unitWeightKg: null },
      ],
      demand: [
        { id: 'dm1', customerId: 'd1', skuId: 's1', volume: 100 },
        { id: 'dm2', customerId: 'nope', skuId: 's1', volume: 100 },
        { id: 'dm3', customerId: 'p1', skuId: 's1', volume: 100 },
        { id: 'dm4', customerId: 'd1', skuId: 'nosku', volume: 100 },
        { id: 'dm5', customerId: 'd1', skuId: 's1', volume: 0 },
        { id: 'dm6', customerId: 'd1', skuId: 's1', volume: -5 },
        { id: 'dm7', customerId: 'd1', skuId: 's1', volume: '250' },
      ],
      lanes: [
        { id: 'l1', from: 'p1', to: 'd1', costPerUnit: 2, capacityUnits: 1000 },
        { id: 'l2', from: 'p1', to: 'nope', costPerUnit: 2 },
        { id: 'l3', from: 'nope', to: 'd1', costPerUnit: -1 },
        { id: 'l4', from: 'p1', to: 'd1', costPerUnit: 2, modes: [{ mode: 'Truck' }, { mode: 'Rail' }] },
        { id: 'l4', from: 'p1', to: 'd1' },
      ],
    },
  },
  {
    name: 'bom-cycles-and-orphans',
    pack: {
      format: 'flowform-enterprise-pack',
      schemaVersion: 'enterprise-data-v1',
      sites: [
        { id: 'p1', kind: 'plant', status: 'open', lat: 1, lng: 1, capacityMax: 10000 },
        { id: 'sup1', kind: 'supplier', status: 'open', lat: 0, lng: 0 },
        { id: 'd1', kind: 'demand', status: 'open', lat: 2, lng: 2 },
      ],
      skus: [
        { id: 'fg', groupId: 'g1' },
        { id: 'comp', groupId: 'g1' },
        { id: 'rm', groupId: 'g1' },
      ],
      productGroups: [{ id: 'g1', unitWeightKg: 20 }],
      demand: [{ id: 'dm1', customerId: 'd1', skuId: 'fg', volume: 10 }],
      bom: [
        { id: 'b1', parentSkuId: 'fg', childSkuId: 'comp', qtyPerUnit: 2, plantId: 'p1', supplierId: 'sup1' },
        { id: 'b1', parentSkuId: 'fg', childSkuId: 'comp', qtyPerUnit: 2 },
        { id: 'b2', parentSkuId: 'missing', childSkuId: 'rm', qtyPerUnit: 1 },
        { id: 'b3', parentSkuId: 'comp', childSkuId: 'missing', qtyPerUnit: 1 },
        { id: 'b4', parentSkuId: 'comp', childSkuId: 'rm', qtyPerUnit: 0 },
        { id: 'b5', parentSkuId: 'comp', childSkuId: 'rm', qtyPerUnit: 1, plantId: 'nope' },
        { id: 'b6', parentSkuId: 'comp', childSkuId: 'rm', qtyPerUnit: 1, supplierId: 'nope2' },
        { id: 'b7', parentSkuId: 'rm', childSkuId: 'comp', qtyPerUnit: 1 },
      ],
    },
  },
  {
    name: 'coercion-edges',
    pack: {
      format: 'flowform-enterprise-pack',
      schemaVersion: 'enterprise-data-v1',
      sites: [
        { id: 1, kind: 'dc', status: 'open', lat: '40', lng: '-80', capacityMax: '5000' },
        { id: true, kind: 'dc', status: 'open', lat: 1e21, lng: -1e21, capacityMax: null },
        { id: null, kind: 'dc', status: null, capacityMax: '12k' },
        { id: '', kind: 'demand', status: 'open', lat: 0, lng: 0 },
      ],
      demand: [
        { id: null, customerId: true, skuId: null, volume: '1e3' },
        { id: undefined, customerId: 1, skuId: undefined, volume: null },
      ],
      skus: [{ id: 1, unitWeightKg: 20 }, { id: true, unitWeightKg: 20 }],
      lanes: [{ id: 1, from: 1, to: true, costPerUnit: 'abc' }],
    },
  },
]

const cases = [
  { name: 'sample-na-footprint', pack: sample('na-footprint-2027.flowform.json') },
  { name: 'sample-stress-120', pack: sample('stress-120-demand.enterprise.json') },
  { name: 'sample-stress-200', pack: sample('stress-200-demand.enterprise.json') },
  ...synthetic,
].map(({ name, pack }) => ({
  name,
  // JSON round-trip: the fixture is JSON, so `undefined` fields must be dropped
  // exactly as the Python side will see them (absent, not null).
  pack: JSON.parse(JSON.stringify(pack ?? null)),
  scorecard: JSON.parse(JSON.stringify(validateEnterprisePack(pack as never))),
}))

writeFileSync(outFile, `${JSON.stringify(cases, null, 2)}\n`, 'utf8')
console.log(`wrote ${cases.length} parity cases → ${outFile}`)
