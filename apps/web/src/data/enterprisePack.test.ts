/**
 * Enterprise pack validation + MIP payload wiring tests.
 * Run: npm run test:enterprise
 */
import assert from 'node:assert/strict'
import {
  buildEnterprisePack,
  generateStressSamplePack,
  packToOptimizePayload,
  validateEnterprisePack,
  type EnterprisePack,
} from './enterprisePack'
import { sampleUploadedNetwork } from './csvParsers'
import { defaultConstraintsFromNetwork } from './optimize'
import { defaultProductMix } from './productGroups'
import { defaultBom } from './bom'
import { DEFAULT_EMISSION_FACTORS } from './emissions'

function basePack(): EnterprisePack {
  const network = sampleUploadedNetwork()
  const constraints = defaultConstraintsFromNetwork(network)
  const productMix = defaultProductMix(network)
  const bom = defaultBom(network)
  return buildEnterprisePack({
    network,
    constraints,
    productMix,
    bom,
    emissionFactors: DEFAULT_EMISSION_FACTORS,
    name: 'test',
  })
}

function testValidSamplePack() {
  const pack = basePack()
  const card = validateEnterprisePack(pack)
  assert.equal(card.schemaVersion, 'enterprise-data-v1')
  assert.ok(card.siteCount > 0)
  assert.equal(card.errorCount, 0, JSON.stringify(card.issues.filter((i) => i.level === 'error'), null, 2))
  assert.ok(card.ok)
  assert.ok(card.score >= 70)
}

function testDuplicateSiteId() {
  const pack = basePack()
  pack.sites.push({ ...pack.sites[0]!, id: pack.sites[0]!.id })
  const card = validateEnterprisePack(pack)
  assert.ok(card.issues.some((i) => i.code === 'DUPLICATE_SITE_ID'))
  assert.ok(!card.ok)
}

function testOrphanDemand() {
  const pack = basePack()
  pack.demand.push({
    id: 'orphan-1',
    customerId: 'no-such-customer',
    skuId: pack.skus[0]?.id ?? 'sku-x',
    volume: 100,
  })
  const card = validateEnterprisePack(pack)
  assert.ok(card.issues.some((i) => i.code === 'ORPHAN_DEMAND_CUSTOMER'))
}

function testLaneEndpointMissing() {
  const pack = basePack()
  pack.lanes.push({
    id: 'bad-lane',
    from: 'missing-a',
    to: 'missing-b',
    mode: 'Truck',
    costPerUnit: 1,
    leadDays: 2,
    capacity: 1000,
  })
  const card = validateEnterprisePack(pack)
  assert.ok(card.issues.some((i) => i.code === 'LANE_FROM_MISSING'))
  assert.ok(card.issues.some((i) => i.code === 'LANE_TO_MISSING'))
}

function testCapacityNonpositive() {
  const pack = basePack()
  const fac = pack.sites.find((s) => s.kind === 'dc' || s.kind === 'plant')
  assert.ok(fac)
  fac!.capacityMax = 0
  const card = validateEnterprisePack(pack)
  assert.ok(card.issues.some((i) => i.code === 'CAPACITY_NONPOSITIVE'))
}

function testBomCycle() {
  const pack = basePack()
  pack.skus.push(
    { id: 'sku-cycle-a', name: 'A', code: 'A' },
    { id: 'sku-cycle-b', name: 'B', code: 'B' },
  )
  pack.bom.push(
    {
      id: 'cyc-1',
      parentSkuId: 'sku-cycle-a',
      childSkuId: 'sku-cycle-b',
      qtyPerUnit: 1,
    },
    {
      id: 'cyc-2',
      parentSkuId: 'sku-cycle-b',
      childSkuId: 'sku-cycle-a',
      qtyPerUnit: 1,
    },
  )
  const card = validateEnterprisePack(pack)
  assert.ok(card.bomCycleDetected)
  assert.ok(card.issues.some((i) => i.code === 'BOM_CYCLE'))
}

function testGeocodeGap() {
  const pack = basePack()
  const s = pack.sites[0]!
  delete s.lat
  delete s.lng
  const card = validateEnterprisePack(pack)
  assert.ok(card.issues.some((i) => i.code === 'GEOCODE_GAP'))
}

function testOptimizePayloadWiring() {
  const pack = basePack()
  const payload = packToOptimizePayload(pack)
  assert.equal(payload.enterpriseSchemaVersion, 'enterprise-data-v1')
  assert.ok(payload.validationOk)
  assert.ok(payload.constraints.facilities.length > 0)
  for (const f of payload.constraints.facilities) {
    assert.ok(f.capacityMax > 0)
    assert.ok(f.fixedCapexM >= 0)
  }
  assert.ok(Object.keys(payload.network.demandVolume).length > 0)
  // BOM arcs when suppliers+plants linked
  if (pack.bom.some((b) => b.supplierId && b.plantId)) {
    assert.ok(payload.network.bomDemand.length > 0)
  }
}

function testStressSample() {
  const pack = generateStressSamplePack({ demandCount: 120 })
  const demandSites = pack.sites.filter((s) => s.kind === 'demand')
  assert.ok(demandSites.length >= 100)
  const card = validateEnterprisePack(pack)
  assert.equal(card.errorCount, 0, JSON.stringify(card.issues.filter((i) => i.level === 'error').slice(0, 5), null, 2))
  assert.ok(card.ok)
}

const tests: [string, () => void][] = [
  ['valid sample pack', testValidSamplePack],
  ['duplicate site id', testDuplicateSiteId],
  ['orphan demand', testOrphanDemand],
  ['lane endpoints missing', testLaneEndpointMissing],
  ['capacity nonpositive', testCapacityNonpositive],
  ['BOM cycle', testBomCycle],
  ['geocode gap', testGeocodeGap],
  ['optimize payload wiring', testOptimizePayloadWiring],
  ['stress sample 120 demand', testStressSample],
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
if (failed) {
  console.error(`\n${failed} failed`)
  process.exit(1)
}
console.log(`\n${tests.length} passed`)
