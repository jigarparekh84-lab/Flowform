/**
 * Regenerate the stress enterprise packs from the same generator the app uses.
 * Run from repo root:
 *   cd apps/web && npx --yes tsx ../../scripts/generate-stress-packs.mts
 * Writes apps/web/public/samples/ and apps/api/tests/fixtures/ (identical copies).
 */
import { writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { generateStressSamplePack } from '../apps/web/src/data/enterprisePack'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
for (const n of [120, 200]) {
  const pack = generateStressSamplePack({ demandCount: n })
  const body = JSON.stringify(pack, null, 2)
  for (const dir of ['apps/web/public/samples', 'apps/api/tests/fixtures']) {
    const out = resolve(root, dir, `stress-${n}-demand.enterprise.json`)
    writeFileSync(out, body)
    console.log('wrote', out)
  }
}
