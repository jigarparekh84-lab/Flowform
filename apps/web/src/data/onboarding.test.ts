/**
 * FF-110: wizard builder. "ZIP list + 3 DC addresses → valid model". Also
 * writes/compares apps/api/tests/fixtures/onboarding-starter.enterprise.json so
 * the API test suite proves the starter model solves.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { buildStarterModel, resolveLocation } from './onboarding'
import { validateEnterprisePack } from './enterprisePack'

assert.equal(resolveLocation('Dallas, TX')?.precision, 'metro')
assert.equal(resolveLocation('30301')?.label, '30301 (Atlanta, GA)')
assert.equal(resolveLocation('59001')?.precision, 'approximate')
assert.equal(resolveLocation('41.9, -87.6')?.precision, 'exact')
assert.equal(resolveLocation('Atlantis'), null)

export const STARTER_ANSWERS = {
  projectName: 'Wizard starter',
  products: 'Ambient goods, 8\nChilled',
  customers: ['10001, 4000', '60601, 3500', '90012, 5000', '75201, 3000', '30303, 2500', '98101, 1500', '33101', '80202, 1200', '02108, 2200', '85004, 1800', 'Atlantis, 99'].join('\n'),
  sites: 'Columbus, OH, existing, 12000\nReno, NV, existing\nAtlanta, GA, candidate, 9000',
  question: 'keep-or-close' as const,
}

const m = buildStarterModel(STARTER_ANSWERS)
const card = validateEnterprisePack(m.pack)
assert.equal(card.errorCount, 0, JSON.stringify(card.issues?.filter((i) => i.level === 'error')))
assert.equal(m.pack.sites.filter((s) => s.kind === 'demand').length, 10)
assert.deepEqual(m.skipped, ['Customer “Atlantis, 99” — location not recognised'])
assert.ok(m.assumptions.some((a) => a.includes('1 customer(s) without a volume')))
assert.ok(m.assumptions.some((a) => a.includes('supply source')))
assert.ok(m.pack.sites.some((s) => s.kind === 'candidate'))
assert.equal(m.pack.demand.reduce((t, d) => t + d.volume, 0), 4000 + 3500 + 5000 + 3000 + 2500 + 1500 + 1000 + 1200 + 2200 + 1800)

const add = buildStarterModel({ ...STARTER_ANSWERS, sites: 'Columbus, OH\nReno, NV', question: 'add-site' })
assert.ok(add.pack.sites.filter((s) => s.kind === 'candidate').length >= 5)
assert.equal(add.pack.globals?.maxFacilities, 3)
assert.equal(buildStarterModel({ ...STARTER_ANSWERS, question: 'consolidate' }).pack.globals?.maxFacilities, 1)

const fixture = new URL('../../../api/tests/fixtures/onboarding-starter.enterprise.json', import.meta.url)
const text = JSON.stringify(m.pack, null, 2) + '\n'
if (process.env.UPDATE_FIXTURES || !existsSync(fixture)) writeFileSync(fixture, text)
assert.equal(readFileSync(fixture, 'utf8'), text, 'onboarding fixture drifted — rerun with UPDATE_FIXTURES=1')
console.log('onboarding: ok', m.assumptions.length, 'assumptions')
