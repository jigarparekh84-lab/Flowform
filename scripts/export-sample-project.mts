/**
 * One-shot: build a flowform-project export from the same builders the app uses.
 * Run from repo root:
 *   cd apps/web && npx vite-node ../../scripts/export-sample-project.mts
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { sampleUploadedNetwork } from '../apps/web/src/data/csvParsers'
import { defaultConstraintsFromNetwork } from '../apps/web/src/data/optimize'
import {
  INITIAL_SCENARIOS,
  type AssumptionItem,
  type BriefState,
} from '../apps/web/src/data/sampleNetwork'
import { DEFAULT_EMISSION_FACTORS } from '../apps/web/src/data/emissions'
import { defaultInventoryPolicies } from '../apps/web/src/data/inventoryPolicy'
import { defaultProductMix } from '../apps/web/src/data/productGroups'
import { defaultLaneRates } from '../apps/web/src/data/laneRates'
import { defaultBom } from '../apps/web/src/data/bom'
import { defaultCapexRoadmap } from '../apps/web/src/data/capexRoadmap'
import type { ProjectExportFile, ProjectSnapshot } from '../apps/web/src/data/projects'

const DEFAULT_ASSUMPTIONS: AssumptionItem[] = [
  { id: 'a1', label: 'Demand is FY27 steady-state (no promotional spikes)', checked: true },
  { id: 'a2', label: 'Service radius uses Euclidean miles on canvas map', checked: true },
  { id: 'a3', label: 'CapEx is overnight build — no phased construction', checked: true },
  { id: 'a4', label: 'Optimize prefers API MIP (PuLP) when available; else heuristic v1', checked: true },
  { id: 'a5', label: 'Lane rates held constant vs Reference', checked: false },
  { id: 'a6', label: 'CO₂ factors are planning estimates only', checked: true },
]

function defaultBrief(scenarios: typeof INITIAL_SCENARIOS): BriefState {
  const baseline = scenarios.find((s) => s.id === 'baseline')
  const alts = scenarios.filter((s) => s.id !== 'baseline').slice(0, 2)
  return {
    recommendedScenarioId: alts[0]?.id ?? null,
    comparedIds: [baseline?.id, ...alts.map((s) => s.id)].filter(
      (x): x is string => !!x,
    ),
    assumptions: structuredClone(DEFAULT_ASSUMPTIONS),
    notes:
      'Sample pack: NA Footprint 2027 — built-in network, Baseline + East Coast DC / Nearshore MX / Lean Lanes what-ifs. Import via Projects → Import JSON.',
    sentToHandoffAt: null,
  }
}

const now = new Date().toISOString()
const net = sampleUploadedNetwork()
const scenarios = structuredClone(INITIAL_SCENARIOS)

const state: ProjectSnapshot = {
  version: 1,
  horizon: 'FY27',
  scenarios,
  activeScenarioId: scenarios[0].id,
  deltas: [],
  network: net,
  constraints: defaultConstraintsFromNetwork(net),
  brief: defaultBrief(scenarios),
  handoffPayload: null,
  emissionFactors: structuredClone(DEFAULT_EMISSION_FACTORS),
  lastCandidates: [],
  theme: 'dark',
  inventoryPolicies: defaultInventoryPolicies(net),
  comments: [],
  productMix: defaultProductMix(net),
  laneRates: defaultLaneRates(net),
  bom: defaultBom(net),
  capexRoadmap: defaultCapexRoadmap(net),
  decisionLog: [],
}

const payload: ProjectExportFile = {
  format: 'flowform-project',
  version: 1,
  meta: {
    id: 'proj-sample-na-footprint-2027',
    name: 'NA Footprint 2027 (sample)',
    createdAt: now,
    updatedAt: now,
  },
  state,
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const outDir = resolve(__dirname, '../apps/web/public/samples')
mkdirSync(outDir, { recursive: true })
const outPath = resolve(outDir, 'na-footprint-2027.flowform.json')
writeFileSync(outPath, JSON.stringify(payload, null, 2) + '\n', 'utf8')
console.log(`Wrote ${outPath}`)
console.log(
  `nodes=${state.network.nodes.length} lanes=${state.network.lanes.length} scenarios=${state.scenarios.length}`,
)
