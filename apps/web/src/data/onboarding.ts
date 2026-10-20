/**
 * Onboarding wizard model builder (FF-110). Four plain answers →
 * enterprise-data-v1 pack with every default labelled "assumed".
 *
 * Locations are resolved offline (no geocoding service): "City, ST" against a
 * built-in metro table, US ZIPs by 3-digit prefix (then by first-digit zone,
 * flagged approximate), or explicit "lat, lng".
 */
import {
  DEFAULT_COST_SCALING,
  ENTERPRISE_PACK_FORMAT,
  ENTERPRISE_SCHEMA_VERSION,
  type EnterpriseDemand,
  type EnterpriseLane,
  type EnterprisePack,
  type EnterpriseSite,
} from './enterprisePack'

/** Dispatch on window to open the onboarding wizard from any room. */
export const START_WIZARD_EVENT = 'flowform:start-wizard'

type Metro = { name: string; st: string; lat: number; lng: number; zip3: string[] }

/* Major US metros (city-centre coordinates) + their principal ZIP3 prefixes. */
export const METROS: Metro[] = [
  { name: 'New York', st: 'NY', lat: 40.71, lng: -74.01, zip3: ['100', '101', '102', '103', '104', '110', '111', '112', '113', '114', '116'] },
  { name: 'Newark', st: 'NJ', lat: 40.74, lng: -74.17, zip3: ['070', '071', '072', '073', '074', '075', '076', '077', '078', '079'] },
  { name: 'Boston', st: 'MA', lat: 42.36, lng: -71.06, zip3: ['021', '022', '017', '018', '019', '020', '023', '024'] },
  { name: 'Philadelphia', st: 'PA', lat: 39.95, lng: -75.17, zip3: ['190', '191', '193', '194', '080', '081'] },
  { name: 'Pittsburgh', st: 'PA', lat: 40.44, lng: -80.0, zip3: ['150', '151', '152', '153', '154'] },
  { name: 'Baltimore', st: 'MD', lat: 39.29, lng: -76.61, zip3: ['210', '211', '212', '214'] },
  { name: 'Washington', st: 'DC', lat: 38.91, lng: -77.04, zip3: ['200', '202', '203', '204', '205', '206', '207', '208', '209', '220', '221', '222', '223'] },
  { name: 'Richmond', st: 'VA', lat: 37.54, lng: -77.44, zip3: ['230', '231', '232'] },
  { name: 'Charlotte', st: 'NC', lat: 35.23, lng: -80.84, zip3: ['280', '281', '282'] },
  { name: 'Raleigh', st: 'NC', lat: 35.78, lng: -78.64, zip3: ['275', '276', '277'] },
  { name: 'Atlanta', st: 'GA', lat: 33.75, lng: -84.39, zip3: ['300', '301', '302', '303', '311'] },
  { name: 'Jacksonville', st: 'FL', lat: 30.33, lng: -81.66, zip3: ['320', '322'] },
  { name: 'Orlando', st: 'FL', lat: 28.54, lng: -81.38, zip3: ['327', '328', '347'] },
  { name: 'Tampa', st: 'FL', lat: 27.95, lng: -82.46, zip3: ['335', '336', '337', '346'] },
  { name: 'Miami', st: 'FL', lat: 25.76, lng: -80.19, zip3: ['330', '331', '332', '333', '334'] },
  { name: 'Nashville', st: 'TN', lat: 36.16, lng: -86.78, zip3: ['370', '371', '372'] },
  { name: 'Memphis', st: 'TN', lat: 35.15, lng: -90.05, zip3: ['380', '381'] },
  { name: 'Louisville', st: 'KY', lat: 38.25, lng: -85.76, zip3: ['400', '401', '402'] },
  { name: 'Columbus', st: 'OH', lat: 39.96, lng: -83.0, zip3: ['430', '431', '432'] },
  { name: 'Cleveland', st: 'OH', lat: 41.5, lng: -81.69, zip3: ['440', '441', '442', '443'] },
  { name: 'Cincinnati', st: 'OH', lat: 39.1, lng: -84.51, zip3: ['450', '451', '452'] },
  { name: 'Detroit', st: 'MI', lat: 42.33, lng: -83.05, zip3: ['480', '481', '482', '483'] },
  { name: 'Indianapolis', st: 'IN', lat: 39.77, lng: -86.16, zip3: ['460', '461', '462'] },
  { name: 'Chicago', st: 'IL', lat: 41.88, lng: -87.63, zip3: ['600', '601', '602', '603', '604', '605', '606', '607', '608'] },
  { name: 'Milwaukee', st: 'WI', lat: 43.04, lng: -87.91, zip3: ['530', '531', '532'] },
  { name: 'Minneapolis', st: 'MN', lat: 44.98, lng: -93.27, zip3: ['550', '551', '553', '554', '555'] },
  { name: 'St. Louis', st: 'MO', lat: 38.63, lng: -90.2, zip3: ['630', '631', '633'] },
  { name: 'Kansas City', st: 'MO', lat: 39.1, lng: -94.58, zip3: ['640', '641', '660', '661', '662'] },
  { name: 'Omaha', st: 'NE', lat: 41.26, lng: -95.93, zip3: ['680', '681'] },
  { name: 'Dallas', st: 'TX', lat: 32.78, lng: -96.8, zip3: ['750', '751', '752', '753', '754', '760', '761', '762'] },
  { name: 'Houston', st: 'TX', lat: 29.76, lng: -95.37, zip3: ['770', '771', '772', '773', '774', '775'] },
  { name: 'Austin', st: 'TX', lat: 30.27, lng: -97.74, zip3: ['786', '787', '733'] },
  { name: 'San Antonio', st: 'TX', lat: 29.42, lng: -98.49, zip3: ['780', '781', '782'] },
  { name: 'Oklahoma City', st: 'OK', lat: 35.47, lng: -97.52, zip3: ['730', '731'] },
  { name: 'New Orleans', st: 'LA', lat: 29.95, lng: -90.07, zip3: ['700', '701'] },
  { name: 'Denver', st: 'CO', lat: 39.74, lng: -104.99, zip3: ['800', '801', '802', '803', '804', '805'] },
  { name: 'Salt Lake City', st: 'UT', lat: 40.76, lng: -111.89, zip3: ['840', '841'] },
  { name: 'Phoenix', st: 'AZ', lat: 33.45, lng: -112.07, zip3: ['850', '851', '852', '853'] },
  { name: 'Las Vegas', st: 'NV', lat: 36.17, lng: -115.14, zip3: ['889', '890', '891'] },
  { name: 'Reno', st: 'NV', lat: 39.53, lng: -119.81, zip3: ['894', '895', '897'] },
  { name: 'Los Angeles', st: 'CA', lat: 34.05, lng: -118.24, zip3: ['900', '901', '902', '903', '904', '905', '906', '907', '908', '910', '911', '912', '913', '914', '915', '916', '917', '918'] },
  { name: 'San Diego', st: 'CA', lat: 32.72, lng: -117.16, zip3: ['919', '920', '921'] },
  { name: 'Riverside', st: 'CA', lat: 33.95, lng: -117.4, zip3: ['922', '923', '924', '925'] },
  { name: 'Sacramento', st: 'CA', lat: 38.58, lng: -121.49, zip3: ['956', '957', '958'] },
  { name: 'San Francisco', st: 'CA', lat: 37.77, lng: -122.42, zip3: ['940', '941', '943', '944', '945', '946', '947', '948', '949', '950', '951'] },
  { name: 'Portland', st: 'OR', lat: 45.52, lng: -122.68, zip3: ['970', '971', '972'] },
  { name: 'Seattle', st: 'WA', lat: 47.61, lng: -122.33, zip3: ['980', '981', '982', '983', '984'] },
]

/* First ZIP digit → rough zone centroid (approximate fallback). */
const ZIP_ZONES: Record<string, [number, number]> = {
  '0': [42.4, -72.0], '1': [41.5, -76.0], '2': [37.0, -78.5], '3': [32.0, -84.5], '4': [40.0, -84.5],
  '5': [44.0, -93.5], '6': [39.5, -93.0], '7': [31.5, -96.5], '8': [39.0, -108.0], '9': [38.0, -120.5],
}

export type ResolvedLocation = {
  label: string
  lat: number
  lng: number
  /** exact = user coordinates / metro match; approximate = ZIP zone fallback */
  precision: 'exact' | 'metro' | 'approximate'
}

export function resolveLocation(text: string): ResolvedLocation | null {
  const t = text.trim()
  if (!t) return null
  const ll = t.match(/^(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)$/)
  if (ll) {
    const lat = Number(ll[1])
    const lng = Number(ll[2])
    if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { label: `${lat}, ${lng}`, lat, lng, precision: 'exact' }
  }
  const zip = t.match(/^(\d{5})(?:-\d{4})?$/)
  if (zip) {
    const z3 = zip[1].slice(0, 3)
    const m = METROS.find((x) => x.zip3.includes(z3))
    if (m) return { label: `${zip[1]} (${m.name}, ${m.st})`, lat: m.lat, lng: m.lng, precision: 'metro' }
    const zone = ZIP_ZONES[zip[1][0]]
    return { label: `${zip[1]} (approx.)`, lat: zone[0], lng: zone[1], precision: 'approximate' }
  }
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '')
  const [city, st] = t.split(',').map((s) => s.trim())
  const m =
    METROS.find((x) => norm(x.name) === norm(city) && (!st || x.st.toLowerCase() === st.toLowerCase())) ??
    METROS.find((x) => norm(x.name) === norm(city))
  return m ? { label: `${m.name}, ${m.st}`, lat: m.lat, lng: m.lng, precision: 'metro' } : null
}

export function milesBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 3958.8
  const r = (d: number) => (d * Math.PI) / 180
  const dLat = r(b.lat - a.lat)
  const dLng = r(b.lng - a.lng)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

export type OnboardingQuestion = 'keep-or-close' | 'add-site' | 'consolidate'

export const QUESTION_LABELS: Record<OnboardingQuestion, string> = {
  'keep-or-close': 'Which of my sites should stay open?',
  'add-site': 'Where should I add a new site?',
  consolidate: 'Can I serve everyone with one fewer site?',
}

export type OnboardingAnswers = {
  projectName?: string
  /** Q1 — what you sell: one product family per line, optional ", <kg per unit>". */
  products: string
  /** Q2 — where customers are: one per line "<ZIP | City, ST | lat, lng>[, <volume per year>]". */
  customers: string
  /** Q3 — where sites are: one per line "<location>[, existing|candidate|plant][, <capacity>]". */
  sites: string
  /** Q4 — which question to answer. */
  question: OnboardingQuestion
}

export type StarterModel = {
  pack: EnterprisePack
  /** Plain-language list of every default we filled in. */
  assumptions: string[]
  /** Lines we could not use (unknown location, bad number). */
  skipped: string[]
}

/* ---- labelled defaults ---- */
export const ASSUMED = {
  unitWeightKg: 10,
  customerVolume: 1000,
  outboundRatePerUnitMile: 0.0018,
  inboundRatePerUnitMile: 0.0012,
  minLaneCostPerUnit: 0.15,
  milesPerLeadDay: 500,
  existingOpexM: 0.7,
  candidateCapexM: 5,
  candidateOpexM: 0.7,
  siteCapacityShareOfDemand: 0.6,
  serviceTargetPct: 95,
  serviceRadiusMiles: 600,
  capexBudgetM: 50,
} as const

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'x'
const lines = (s: string) => s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d

/** Split "<location>, rest…" — location may itself contain a comma ("Dallas, TX" or "lat, lng"). */
function splitLocation(line: string): { loc: ResolvedLocation | null; rest: string[] } {
  const parts = line.split(',').map((p) => p.trim())
  for (const take of [2, 1]) {
    if (parts.length < take) continue
    const loc = resolveLocation(parts.slice(0, take).join(', '))
    if (loc) return { loc, rest: parts.slice(take) }
  }
  return { loc: null, rest: parts.slice(1) }
}

export function buildStarterModel(a: OnboardingAnswers): StarterModel {
  const assumptions: string[] = []
  const skipped: string[] = []

  // Q1 products
  const groups = lines(a.products).map((l) => {
    const [name, kg] = l.split(',').map((x) => x.trim())
    const w = Number(kg)
    return { name: name || 'Products', kg: Number.isFinite(w) && w > 0 ? w : null }
  })
  if (!groups.length) {
    groups.push({ name: 'Products', kg: null })
    assumptions.push('One product family "Products" (none given).')
  }
  if (groups.some((g) => g.kg == null)) assumptions.push(`Unit weight ${ASSUMED.unitWeightKg} kg where not given.`)
  const productGroups = groups.map((g) => ({ id: `grp-${slug(g.name)}`, name: g.name, code: slug(g.name).slice(0, 6).toUpperCase(), unitWeightKg: g.kg ?? ASSUMED.unitWeightKg }))
  const skus = productGroups.map((g) => ({ id: `sku-${g.id.slice(4)}`, name: g.name, code: g.code, groupId: g.id, unitWeightKg: g.unitWeightKg }))

  // Q2 customers
  const sites: EnterpriseSite[] = []
  const demand: EnterpriseDemand[] = []
  let assumedVol = 0
  let approx = 0
  lines(a.customers).forEach((l, i) => {
    const { loc, rest } = splitLocation(l)
    if (!loc) return void skipped.push(`Customer “${l}” — location not recognised`)
    const v = Number((rest[0] ?? '').replace(/[_\s]/g, ''))
    const vol = Number.isFinite(v) && v > 0 ? v : (assumedVol++, ASSUMED.customerVolume)
    if (loc.precision === 'approximate') approx++
    const id = `cust-${i + 1}`
    sites.push({ id, name: loc.label, kind: 'demand', lat: loc.lat, lng: loc.lng, capacityMin: 0, capacityMax: 0, fixedCostM: 0, status: 'open' })
    skus.forEach((s, k) => {
      const share = Math.floor(vol / skus.length) + (k === 0 ? vol % skus.length : 0)
      if (share > 0) demand.push({ id: `d-${i + 1}-${k + 1}`, customerId: id, skuId: s.id, volume: share })
    })
  })
  if (assumedVol) assumptions.push(`${assumedVol} customer(s) without a volume set to ${ASSUMED.customerVolume} units.`)
  if (approx) assumptions.push(`${approx} ZIP(s) placed at an approximate regional centre.`)
  if (skus.length > 1) assumptions.push('Customer volume split evenly across product families.')
  const custs = sites.filter((s) => s.kind === 'demand')
  const totalDemand = demand.reduce((t, d) => t + d.volume, 0)

  // Q3 sites
  const facilities: EnterpriseSite[] = []
  let assumedCap = 0
  let assumedKind = 0
  const defaultCap = Math.max(1, Math.round(totalDemand * ASSUMED.siteCapacityShareOfDemand))
  lines(a.sites).forEach((l, i) => {
    const { loc, rest } = splitLocation(l)
    if (!loc) return void skipped.push(`Site “${l}” — location not recognised`)
    const kindWord = rest.find((r) => /^(existing|open|candidate|new|plant|factory)$/i.test(r))?.toLowerCase()
    const capRaw = rest.find((r) => /^\d[\d_\s]*$/.test(r))
    const cap = capRaw ? Number(capRaw.replace(/[_\s]/g, '')) : (assumedCap++, defaultCap)
    if (!kindWord) assumedKind++
    const isPlant = kindWord === 'plant' || kindWord === 'factory'
    const isCand = kindWord === 'candidate' || kindWord === 'new'
    facilities.push({
      id: `${isPlant ? 'plt' : 'dc'}-${i + 1}`,
      name: `${loc.label} ${isPlant ? 'Plant' : isCand ? 'DC (candidate)' : 'DC'}`,
      kind: isPlant ? 'plant' : isCand ? 'candidate' : 'dc',
      lat: loc.lat, lng: loc.lng,
      capacityMin: 0,
      capacityMax: isPlant ? Math.max(cap, totalDemand * 2) : cap,
      fixedCostM: isCand ? ASSUMED.candidateCapexM : 0,
      fixedOpexM: isCand ? ASSUMED.candidateOpexM : ASSUMED.existingOpexM,
      status: isCand ? 'candidate' : 'open',
    })
  })
  if (assumedKind) assumptions.push(`${assumedKind} site(s) without a type treated as existing DCs.`)
  if (assumedCap) assumptions.push(`${assumedCap} site(s) without a capacity set to ${defaultCap.toLocaleString()} units (60% of demand).`)
  assumptions.push(`Site running cost $${ASSUMED.existingOpexM}M/yr; a new site costs $${ASSUMED.candidateCapexM}M to open.`)

  const dcs = facilities.filter((f) => f.kind !== 'plant')
  // Q4 question → candidates
  if (a.question === 'add-site' && !dcs.some((d) => d.kind === 'candidate')) {
    // Offer a candidate at every customer metro not already a site.
    const have = new Set(dcs.map((d) => `${d.lat},${d.lng}`))
    const seen = new Set<string>()
    custs.forEach((c) => {
      const k = `${c.lat},${c.lng}`
      if (have.has(k) || seen.has(k)) return
      seen.add(k)
      dcs.push({ id: `cand-${seen.size}`, name: `${c.name} DC (candidate)`, kind: 'candidate', lat: c.lat, lng: c.lng, capacityMin: 0, capacityMax: defaultCap, fixedCostM: ASSUMED.candidateCapexM, fixedOpexM: ASSUMED.candidateOpexM, status: 'candidate' })
    })
    assumptions.push(`Candidate DCs offered at ${seen.size} customer location(s).`)
  }

  let plants = facilities.filter((f) => f.kind === 'plant')
  if (!plants.length && custs.length) {
    const w = custs.map((c) => demand.filter((d) => d.customerId === c.id).reduce((t, d) => t + d.volume, 0))
    const W = w.reduce((t, x) => t + x, 0) || 1
    const lat = round(custs.reduce((t, c, i) => t + (c.lat ?? 0) * w[i], 0) / W, 2)
    const lng = round(custs.reduce((t, c, i) => t + (c.lng ?? 0) * w[i], 0) / W, 2)
    plants = [{ id: 'plt-supply', name: 'Supply source (assumed)', kind: 'plant', lat, lng, capacityMin: 0, capacityMax: totalDemand * 2, fixedCostM: 0, fixedOpexM: 0, status: 'open' }]
    assumptions.push('One supply source at the demand-weighted centre feeds every DC (no plant given).')
  }

  // Lanes: plant → DC, DC → customer, distance-priced.
  const lanes: EnterpriseLane[] = []
  const lane = (from: EnterpriseSite, to: EnterpriseSite, rate: number) => {
    const mi = milesBetween(from as { lat: number; lng: number }, to as { lat: number; lng: number })
    lanes.push({
      id: `ln-${lanes.length + 1}`, from: from.id, to: to.id, mode: 'Truck',
      costPerUnit: round(Math.max(ASSUMED.minLaneCostPerUnit, mi * rate)),
      leadDays: Math.max(1, Math.ceil(mi / ASSUMED.milesPerLeadDay)),
      capacity: Math.max(1, totalDemand * 2),
    })
  }
  for (const p of plants) for (const d of dcs) lane(p, d, ASSUMED.inboundRatePerUnitMile)
  for (const d of dcs) for (const c of custs) lane(d, c, ASSUMED.outboundRatePerUnitMile)
  assumptions.push(`Truck rates $${ASSUMED.outboundRatePerUnitMile}/unit-mile outbound, $${ASSUMED.inboundRatePerUnitMile} inbound (min $${ASSUMED.minLaneCostPerUnit}); 1 transit day per ${ASSUMED.milesPerLeadDay} miles.`)

  const existing = dcs.filter((d) => d.kind === 'dc').length
  const maxFacilities =
    a.question === 'consolidate' ? Math.max(1, existing - 1)
      : a.question === 'add-site' ? existing + 1
        : Math.max(1, dcs.length)
  if (a.question === 'consolidate') assumptions.push(`At most ${maxFacilities} DC(s) may stay open.`)
  if (a.question === 'add-site') assumptions.push(`At most one new DC on top of the ${existing} existing.`)
  assumptions.push(`Service target ${ASSUMED.serviceTargetPct}% within ${ASSUMED.serviceRadiusMiles} miles; CapEx budget $${ASSUMED.capexBudgetM}M.`)

  const pack: EnterprisePack = {
    format: ENTERPRISE_PACK_FORMAT,
    schemaVersion: ENTERPRISE_SCHEMA_VERSION,
    name: a.projectName?.trim() || 'My network (wizard)',
    sites: [...plants, ...dcs, ...custs],
    skus,
    productGroups,
    demand,
    lanes,
    bom: [],
    costFactors: {
      emissionKgPerTonMileByMode: { Truck: 0.161, Rail: 0.022, Intermodal: 0.065, Ocean: 0.01, Air: 0.98 },
      ...DEFAULT_COST_SCALING,
    },
    globals: {
      serviceTargetPct: ASSUMED.serviceTargetPct,
      serviceRadiusMiles: ASSUMED.serviceRadiusMiles,
      capexBudgetM: ASSUMED.capexBudgetM,
      maxFacilities,
    },
  }
  return { pack, assumptions, skipped }
}
