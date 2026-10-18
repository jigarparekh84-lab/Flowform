# Flowform — Manual Test Workbook

> Companion to [`MASTER_BLUEPRINT.md`](MASTER_BLUEPRINT.md). This supersedes the Sep 28 `SMOKE_CHECKLIST.md` as the full regression; that file remains the 10-minute smoke.
> Excel copy: [`Flowform_Manual_Test_Workbook.xlsx`](Flowform_Manual_Test_Workbook.xlsx) (one sheet per workflow, Pass/Fail dropdowns, live status counts).

| | |
|---|---|
| Build under test | `master` @ `1b2afc2` (expected values captured Oct 17, 2026) |
| Scope | **20 workflows · 199 test cases** + 16 regression checks + defect log |
| Ports | Web **5180** (never 5173) · API **5182** |
| Solver | PuLP + HiGHS (`pulp-highs`) |
| Result codes | **Pass** · **Fail** · **Blocked** · **Not Run** |

## How to use

1. Complete **WF00 Setup** first. If any SET case fails, the expected values below are not valid for your environment.
2. Each case lists a **precondition** (a PRE-x state below or another case ID). Reach that state first.
3. Values in **bold** were **captured** by running the code at `1b2afc2` (API on the box and the Mac; client engines with their built-in seeds). Times vary by machine; costs should match to the cent. Cases marked *exploratory* have no captured value, so record what you see.
4. Cases that reproduce a known defect (D-01…D-08) say so. Mark them **Fail** and reference the defect until it is fixed.
5. Fill in Result and Notes. Log every Fail in the Defect log (§ Defect log) with the test ID.

## Preconditions

| Code | State |
|---|---|
| **PRE-A** | Clean start: API up on :5182 and web on :5180 (see SET). Fresh browser profile, or delete every `flowform-*` localStorage key and reload. The app creates the default project **NA Footprint 2027** (built-in sample network). Active = **Baseline**. Room = Network. |
| **PRE-B** | PRE-A, then **Run** completed on the API path: Active = `Optimize MIP <time>`, chrome shows `Optimal`, objective **$98.27M**. |
| **PRE-C** | PRE-A, then **Projects → Load stress-200** (or Data → Load stress-200) succeeded. |
| **PRE-D** | PRE-A, but the API is **stopped** (Ctrl+C on uvicorn) so `GET /health` fails. |
| **PRE-E** | A terminal with `curl` and `python3`, API up on :5182, cwd = `apps/api` with the venv active. Sample payload file built per API-01. |

## Workflow index

| # | Area | Workflow | Cases |
|---|---|---|---|
| WF00 | SET | [Setup and preflight](#wf00--setup-and-preflight) | 9 |
| WF01 | RUN | [Load sample and run](#wf01--load-sample-and-run) | 11 |
| WF02 | NET | [Network edits and explain cards](#wf02--network-edits-and-explain-cards) | 16 |
| WF03 | GRN | [Greenfield](#wf03--greenfield) | 6 |
| WF04 | HUB | [Hubs (hub-and-spoke)](#wf04--hubs-hub-and-spoke) | 8 |
| WF05 | TER | [Territory](#wf05--territory) | 8 |
| WF06 | PRD | [Product mix and BOM](#wf06--product-mix-and-bom) | 10 |
| WF07 | LAN | [Lane rates, modes, and capacity](#wf07--lane-rates-modes-and-capacity) | 10 |
| WF08 | DAT | [Data import and validation scorecard](#wf08--data-import-and-validation-scorecard) | 22 |
| WF09 | SCN | [Scenarios and Compare (incl. Robust)](#wf09--scenarios-and-compare-incl-robust) | 14 |
| WF10 | RMP | [Roadmap and Optimize timing](#wf10--roadmap-and-optimize-timing) | 10 |
| WF11 | SEN | [Sensitivity: tornado, Monte Carlo, DES-lite, inventory, resilience](#wf11--sensitivity-tornado-monte-carlo-des-lite-inventory-resilience) | 9 |
| WF12 | INF | [Infeasibility diagnostics](#wf12--infeasibility-diagnostics) | 7 |
| WF13 | STR | [Stress-120/200 performance](#wf13--stress-120200-performance) | 9 |
| WF14 | BRF | [Brief export](#wf14--brief-export) | 7 |
| WF15 | HND | [Handoff package](#wf15--handoff-package) | 7 |
| WF16 | MRG | [Merge (M&A)](#wf16--merge-ma) | 6 |
| WF17 | LOG | [Decision log, projects, share](#wf17--decision-log-projects-share) | 7 |
| WF18 | UX | [Themes and keyboard shortcuts](#wf18--themes-and-keyboard-shortcuts) | 9 |
| WF19 | API | [API-only checks with curl](#wf19--api-only-checks-with-curl) | 14 |
| | | **Total** | **199** |

## WF00 — Setup and preflight

_Make sure the environment matches the expected-value baseline before running any workflow._

| ID | Test | Preconditions | Steps | Expected result | Pass/Fail | Notes |
|---|---|---|---|---|---|---|
| **SET-01** | Repo at expected commit | Mac terminal | 1. cd /Users/jigar/Projects/Flowform<br>2. git log --oneline -1<br>3. git status --short | HEAD is `1b2afc2 fix(demo): feasible sample network + realistic cost scaling` or a later docs-only commit. `apps/web/.env.local`, if present, never appears in `git status` (it is gitignored). | ☐ | |
| **SET-02** | API starts on 5182 | Python venv exists | 1. cd apps/api && source .venv/bin/activate<br>2. uvicorn app.main:app --reload --host 127.0.0.1 --port 5182<br>3. curl -s http://127.0.0.1:5182/health | `{"status":"ok","service":"flowform-api","model":"fixed-charge-multi-echelon-v1+multi-period-capex-npv-v1+stochastic-scenario-tree-v1+explain-v1"}` | ☐ | |
| **SET-03** | Solver is HiGHS | SET-02 | 1. Run API-02, or look at the Run log tooltip after RUN-02 | Response `solver` = `pulp-highs`. If CBC is used instead, duals fall back to a proxy and expected values may differ. | ☐ | |
| **SET-04** | Web starts on 5180 (never 5173) | Node 20+, npm install done | 1. cd apps/web && npm run dev<br>2. Open http://localhost:5180 | Vite serves on **5180** (`strictPort`). The app opens on the **Network** room with the map. If 5180 is busy, Vite fails instead of moving to another port. | ☐ | |
| **SET-05** | API unit tests green | SET-02 venv | 1. cd apps/api && pytest -q | **54 passed** (captured Oct 17, 2026). Deprecation warnings are OK. | ☐ | |
| **SET-06** | Web data tests + build green | npm install done | 1. cd apps/web && npm run test:data<br>2. npm run build | Enterprise tests **12 passed** and CTS **2/2 passed**. Build finishes with `✓ built`; only the >500 kB chunk-size warning appears. | ☐ | |
| **SET-07** | Basemap default is OpenFreeMap | PRE-A, no VITE_BASEMAP override | 1. Open Network<br>2. DevTools → Network, filter `openfreemap` | Tiles load from `tiles.openfreemap.org` (`liberty` in light, `dark` in dark). No API key is requested. | ☐ | |
| **SET-08** | Optional Carto basemap | `apps/web/.env.local` with `VITE_BASEMAP=carto` (+ key) | 1. Restart `npm run dev`; hard-refresh<br>2. Open Network | Carto tiles render. After the test, revert `.env.local`, and **never commit it**. | ☐ | |
| **SET-09** | Clean localStorage baseline | Browser DevTools | 1. Application → Local Storage → localhost:5180: delete the `flowform-*` keys<br>2. Reload | The projects index is recreated with one project, **NA Footprint 2027**. Chrome shows Active **Baseline** and Horizon **FY27**. | ☐ | |

## WF01 — Load sample and run

_Core happy path: built-in sample → MIP → new optimized scenario._

| ID | Test | Preconditions | Steps | Expected result | Pass/Fail | Notes |
|---|---|---|---|---|---|---|
| **RUN-01** | Default sample loaded | PRE-A | 1. Open Network<br>2. Check the Layers rail and the map | 8 sites: Austin Plant (n1), Columbus DC (n2), Atlanta DC (n3), Chicago Hub (n4), Dallas Metro (n5), NYC Corridor (n6), Monterrey Sup (n7, supplier), Reno DC (n8). 9 lanes (l1–l9; l9 = Columbus→NYC Truck $1.38, hazmat). | ☐ | |
| **RUN-02** | Run via API (MIP) | PRE-A | 1. Click **Run** in the top chrome<br>2. Watch the status line until it finishes | Progress shows `Checking optimize API…` → `API available — MIP via enterprise-data-v1 (score 100)…`. Final status: `API pulp-highs · Optimal · 0.00Xs · fixed-charge-multi-echelon-v1 · service 100.0% · obj $98.27M (tx $95.67M + CapEx $0.0M + OpEx $2.6M) · 3 SKUs/groups`. **(captured total 98.2706)** | ☐ | |
| **RUN-03** | New optimized scenario + KPIs | RUN-02 | 1. Check the Active chip and the KPI strip | Active = `Optimize MIP <time>`. KPIs: Cost **$98.3M (+103.9%)**, Service **100.0% (+5.9pp)**, CapEx **$0M**, CO₂ **17.0 kt (+37%)**, Risk **Low**. Deltas compare against the hard-coded Baseline ($48.2M, 94.1%, 12.4 kt), which is a known gap. | ☐ | |
| **RUN-04** | Open/close decisions | RUN-02 | 1. Select Reno DC; read the Inspector / facilities table | Reno DC (n8) is **Closed**. Austin Plant, Columbus DC, and Atlanta DC stay open. (API `openIds` n2, n3, n1; `closedIds` n8.) | ☐ | |
| **RUN-05** | Objective breakdown in Compare | RUN-02 | 1. Compare → Matrix (Reference Baseline, optimize scenario selected)<br>2. Find **Optimize objective breakdown** | Total **$98.27M** = Transport **$95.67M** + CapEx **$0.0M** + OpEx **$2.6M**. Uncovered penalty **$0**. Open sites **3**. Model `fixed-charge-multi-echelon-v1`. | ☐ | |
| **RUN-06** | SKU breakdown | RUN-02 | 1. Compare → Matrix → SKU / product-group breakdown | 3 rows: sku-ambient, sku-chilled, sku-hazmat, each at **100%** service. | ☐ | |
| **RUN-07** | Hazmat routed via l9 | RUN-02 | 1. Look at the flows (Compare) or the API-02 `flows` | NYC hazmat (**2,280** units) flows only Columbus DC → NYC Corridor on **l9**. Supplier→plant n7→n1 carries **55,400** units = **$62.048M** of transport. | ☐ | |
| **RUN-08** | Run log tooltip | RUN-02 | 1. Hover the run-status pill / log | The log includes `Model: 1 plants · 3 DCs/candidates · 1 suppliers · 3 demand · 3 commodities (sku) · … radius 250.0 mi · budget $30.0M · max 4.` and `Explain: 4 counterfactual re-solve(s) in 0.01s.` | ☐ | |
| **RUN-09** | Heuristic fallback when API is down | PRE-D | 1. Click **Run** | Progress shows `API offline — client heuristic v1…`. Status ends at `Heuristic v1 · service 58.8% (API offline or fallback)`. New scenario KPIs: Cost **$51.2M (+6.2%)**, Service **58.8%**, Risk **High** (captured from `runHeuristicOptimize`). No hang. | ☐ | |
| **RUN-10** | Run is single-flight | PRE-A | 1. Click Run, then immediately click it again | The button shows a running state and is disabled. Only one new scenario is created. | ☐ | |
| **RUN-11** | Imported sample project gives the same result | PRE-A | 1. Projects → Import → `apps/web/public/samples/na-footprint-2027.flowform.json`<br>2. Run | Project **NA Footprint 2027 (sample)** opens with Baseline, East Coast DC, Nearshore MX, and Lean Lanes. Run → **Optimal $98.27M**, Reno closed, 100% service. | ☐ | |

## WF02 — Network edits and explain cards

_Map interactions, Inspector edits, constraint globals, and depth-8 explain cards._

| ID | Test | Preconditions | Steps | Expected result | Pass/Fail | Notes |
|---|---|---|---|---|---|---|
| **NET-01** | Select / multi-select / clear | PRE-A | 1. Click Columbus DC<br>2. Shift+click Atlanta DC<br>3. Press Esc<br>4. Click a node, then click the empty map background | The Inspector shows Columbus. Shift+click adds Atlanta to the selection. Esc clears the selection, and so does a background click. | ☐ | |
| **NET-02** | Explain card: Atlanta DC | PRE-B | 1. Select Atlanta DC (n3) | Card **Why this site?**, badge **Kept open**. Utilization **52.1%**, cost-to-serve ≈ **$17.6M**, reachable demand **55.5%**, capacity dual ≈ 0 (not binding). Flip penalty **+$850k**. Reasons: *Closing it raises cost by $850k (0.9%); service holds at 100.0%*, *Serves 33% of demand (1 customers)*, *Closing saves $700k fixed cost but adds $1.6M transport*. | ☐ | |
| **NET-03** | Explain card: Columbus DC (required) | PRE-B | 1. Select Columbus DC (n2) | Badge **Kept open**. Flip = infeasible. Reasons: *Required: closing it makes the network infeasible*, *Serves 41% of demand (2 customers) at the lowest landed cost of open DCs*. | ☐ | |
| **NET-04** | Explain card: Reno DC (closed) | PRE-B | 1. Select Reno DC (n8) | Badge **Closed**. Reasons: *No customers within service radius / lead-time limits*, *Opening it raises cost by $700k (0.7%); service holds at 100.0%*, *Would add fixed cost of $700k (CapEx $0 + OpEx $700k)*. | ☐ | |
| **NET-05** | Explain card: Austin Plant | PRE-B | 1. Select Austin Plant (n1) | Badge **Kept open**. Reasons: *Closing it strands 27.7M units of demand (service drops to 0.0%); operating cost falls $98.3M only because that demand goes unserved*, *Closing it also idles Columbus DC, Atlanta DC*, and a *Locked open by the scenario…* note. | ☐ | |
| **NET-06** | Compare: Why this network | PRE-B | 1. Compare → Matrix → **Why this network** | Headline: *The MIP closed Reno DC; kept 3 existing site(s) open. Costliest flip: closing Austin Plant strands 27.7M units (service 0.0%).* Sections: **Open sites — top by flip cost** and **Closed sites — why not**. | ☐ | |
| **NET-07** | Force-close Atlanta and re-run | PRE-B | 1. Select Atlanta DC → Inspector facility Status **closed** (or set it in the Network constraints facility list)<br>2. Run | Optimal **$99.12M** (captured 99.121). Service 100%. Open sites are Columbus and Austin only. | ☐ | |
| **NET-08** | Change lane mode rescales cost | PRE-A | 1. Select lane l9 (Truck $1.38)<br>2. Inspector → mode **Rail** | Cost/unit becomes **$0.76** (1.38 × 0.55 ÷ 1.0, rounded). CO₂ is recomputed with the Rail factor (0.022 kg/ton-mi). | ☐ | |
| **NET-09** | Lane cost edit moves the objective | PRE-A | 1. Data → Export pack JSON; set l9 `costPerUnit` to 2.0; Import pack JSON<br>2. Run | Optimal **$99.68M** (captured 99.6842). | ☐ | |
| **NET-10** | Network constraints defaults | PRE-A | 1. Press Esc so the Inspector shows **Network constraints** | Service target **95%**, radius **250** mi, CapEx budget **$30M**, max facilities **4**, hard service **off**. Facilities: Austin min 25,200 / max 52,500 / CapEx 8; Columbus 10,800 / 22,500 / 4; Atlanta 8,400 / 17,500 / 4; Reno 7,200 / 15,000 / 4 (min = 60%, max = 125% of nominal). | ☐ | |
| **NET-11** | Hard service on the sample | PRE-A | 1. Turn on **Hard service constraints**<br>2. Run | Optimal **$98.27M**, service 100% (captured). | ☐ | |
| **NET-12** | Service radius 800 | PRE-A | 1. Radius = 800<br>2. Run | Optimal **$98.27M**, Reno still closed (captured). Lanes already reach every customer. | ☐ | |
| **NET-13** | Max facilities = 2 | PRE-A | 1. Max facilities = 2<br>2. Run | Optimal **$98.27M** with n1 + n2 + n3 open (captured). Plants are not counted (D-07). | ☐ | |
| **NET-14** | Product group filter | PRE-A | 1. Inspector → Product group filter → Hazmat<br>2. Back to All | Entities that don't match the filter are dimmed. All restores everything. | ☐ | |
| **NET-15** | Capacity heat layer | PRE-A | 1. Layers → Capacity heat on | Facilities are tinted by load vs capacity, and the legend appears. | ☐ | |
| **NET-16** | SVG fallback | PRE-A | 1. Switch the map view to the SVG / schematic canvas | The same nodes and lanes render, and selection still works. | ☐ | |

## WF03 — Greenfield

_Mock candidate generation → promote → compose a scenario._

| ID | Test | Preconditions | Steps | Expected result | Pass/Fail | Notes |
|---|---|---|---|---|---|---|
| **GRN-01** | Wizard defaults | PRE-A | 1. Open Greenfield | Demand set **NA Core demand (sample)**. Site count **3**. Service distance **250** mi. | ☐ | |
| **GRN-02** | Generate candidates | GRN-01 | 1. Click Run | 3 candidates (captured): **Candidate DC A** Midwest score **74**, **B** South **81**, **C** Northeast **88**. Ids are `cand-<time>-i` and change on every run. | ☐ | |
| **GRN-03** | Site count clamps 2–6 | GRN-01 | 1. Site count 1 → Run; then 9 → Run | Produces 2 and 6 candidates (clamp in `runGreenfieldMock`). | ☐ | |
| **GRN-04** | Promote selection | GRN-02 | 1. Select all 3<br>2. Name the delta `Midwest greenfield`<br>3. **Promote → Candidates delta** | Scenarios → delta items lists `Midwest greenfield` with 3 candidates. | ☐ | |
| **GRN-05** | Compose scenario from delta | GRN-04 | 1. Scenarios → Compose (base Baseline + the delta) | A new Active scenario (captured, 3 candidates): Cost **$44.9M (−3.3%)**, Service **96.8%**, CapEx **$18M** (6 × 3), CO₂ **11.2 kt**, Risk **Med**. Log `create_scenario`. | ☐ | |
| **GRN-06** | Empty promote is guarded | GRN-02 | 1. Clear the selection; try to Promote | No empty delta is created. | ☐ | |

## WF04 — Hubs (hub-and-spoke)

_Designate hubs, auto-assign spokes, generate lanes, draft a scenario._

| ID | Test | Preconditions | Steps | Expected result | Pass/Fail | Notes |
|---|---|---|---|---|---|---|
| **HUB-01** | Suggested hubs | PRE-A | 1. Open Hubs | Default hubs are **Columbus DC (n2)** and **Atlanta DC (n3)**. **Suggest 3 hubs** adds **Reno DC (n8)**. | ☐ | |
| **HUB-02** | Preview: balanced | HUB-01 | 1. Assign by **balanced**, lane mode Truck, replace demand-inbound lanes on | NYC Corridor → Columbus (476 mi, 11,400). Chicago Hub → Columbus (276 mi, 9,200). Dallas Metro → Atlanta (720 mi, 7,100). Loads: Columbus **20,600 / 18,000 = 114.4%**, Atlanta **7,100 / 14,000 = 50.7%**. Summary `2 hubs · 3 spokes assigned · 3 new lanes · replaced 5 demand lanes`. | ☐ | |
| **HUB-03** | Distance / volume modes | HUB-01 | 1. Switch assign-by to distance, then volume | Same assignments as balanced on this sample (captured). | ☐ | |
| **HUB-04** | Before/After KPIs | HUB-02 | 1. Read the After card | **$52.7M (+9.3%)**, **92.1% (−2.0pp)**, CapEx $0M, **13.9 kt (+12%)**, Risk **Med (max util 114%)** (captured). | ☐ | |
| **HUB-05** | New lanes | HUB-02 | 1. Read the lane list | `hs-l-n2-n6-0` $0.75 1 d, `hs-l-n2-n4-1` $0.53 1 d, `hs-l-n3-n5-2` $1.02 2 d, all Truck. Kept lanes include l1, l2, l3, l7. | ☐ | |
| **HUB-06** | Apply + draft scenario | HUB-02 | 1. **Apply + draft scenario** (name left blank) | Scenario **Hub-spoke (2 hubs · balanced)** becomes Active. Log `apply_hub`. | ☐ | |
| **HUB-07** | Run MIP on hub design | HUB-06 | 1. Run | The API returns a status chip. Record the objective (exploratory, not captured). | ☐ | |
| **HUB-08** | No hubs selected | HUB-01 | 1. Deselect all hubs | Empty state **No hubs selected**. | ☐ | |

## WF05 — Territory

_Assign demand to servers, coverage %, gaps/overlaps, preferred lanes._

| ID | Test | Preconditions | Steps | Expected result | Pass/Fail | Notes |
|---|---|---|---|---|---|---|
| **TER-01** | Defaults | PRE-A | 1. Open Territory | Servers: Austin Plant, Columbus DC, Atlanta DC, Reno DC. Assign by **distance**, coverage **400 mi / 3 d**. | ☐ | |
| **TER-02** | Distance assignment | TER-01 | 1. Read the summary + assignments | `4 servers · 3/3 demand assigned · 58.8% within 400 mi · 100% within 3d lead · 0 gaps · 2 overlaps`. Chicago → Columbus 276 mi (assigned). Dallas → Austin 182 mi (overlap with Atlanta). NYC → Columbus 476 mi (overlap; outside 400 mi). | ☐ | |
| **TER-03** | Distance: loads + KPIs | TER-02 | 1. Read the loads and After KPIs | Austin 7,100 (16.9%), Columbus **20,600 (114.4%)**, Atlanta 0, Reno 0. After: **$42.0M (−12.9%)**, **91.7% (−2.4pp)**, **10.3 kt (−17%)**. | ☐ | |
| **TER-04** | Capacity mode | TER-01 | 1. Assign by capacity | Same metrics as distance on this sample (captured). | ☐ | |
| **TER-05** | Lanes mode | TER-01 | 1. Assign by current lanes | NYC → **Atlanta**. Loads: Columbus 9,200 (51.1%), Atlanta 11,400 (81.4%). Summary `… 58.8% within 400 mi · 58.8% within 3d lead · 0 gaps · 2 overlaps`. After **$47.1M (−2.2%)**, **12.0 kt (−3%)**, Risk **Low (max util 81%)**. | ☐ | |
| **TER-06** | Apply as scenario + preferred lanes | TER-02 | 1. **Apply as scenario + update preferred lanes** | Scenario **Territory (distance · 400 mi)** becomes Active. New lanes `terr-l-n2-n4-0` $0.53, `terr-l-n1-n5-1` $0.42, `terr-l-n2-n6-2` $0.75. Log `apply_territory`. | ☐ | |
| **TER-07** | Tight radius | TER-01 | 1. Coverage miles = 150 | Coverage % within miles drops, and out-of-radius rows are flagged. Record the values. | ☐ | |
| **TER-08** | Compare → Territory tab | TER-01 | 1. Compare → Territory | Shows the same coverage summary and load table. | ☐ | |

## WF06 — Product mix and BOM

_Commodity groups, capabilities, BOM implied RM, inbound scenario, multi-SKU MIP._

| ID | Test | Preconditions | Steps | Expected result | Pass/Fail | Notes |
|---|---|---|---|---|---|---|
| **PRD-01** | Product rollup | PRE-A | 1. Compare → Products | Ambient **15,382 (55.5%)**, Chilled **8,266 (29.8%)**, Hazmat **4,052 (14.6%)** (captured). | ☐ | |
| **PRD-02** | Atlanta is not hazmat-capable | PRE-A | 1. Data → **Facility capabilities** | Atlanta capable = Ambient + Chilled, with Hazmat cap 0. Austin, Columbus, and Reno are capable of all 3. | ☐ | |
| **PRD-03** | Catalog switch | PRE-A | 1. Switch the product catalog to an alternate set, then back | Groups relabel without crashing. Switching back restores Ambient / Chilled / Hazmat. | ☐ | |
| **PRD-04** | Make Atlanta hazmat-capable | PRE-A | 1. Tick Hazmat for Atlanta<br>2. Run | Optimal, with objective ≤ $98.27M. Record it (exploratory). | ☐ | |
| **PRD-05** | BOM defaults + implied RM | PRE-A | 1. Data → Bill of materials | FG mix **55 / 30 / 15**. 6 BOM rows from Monterrey Sup (n7) → Austin (n1). Implied RM (captured): Polymer resin **30,470**, Carton **15,235**, Chill base **12,465**, Insulated liner **8,310**, Drum/tote **4,155**, Specialty additive **1,662**. Total **72,297**. | ☐ | |
| **PRD-06** | BOM rollup in Compare | PRE-A | 1. Compare → BOM | 6 BOM rows, 6 components, implied lane gaps **0** (l1 covers n7→n1). | ☐ | |
| **PRD-07** | Draft inbound scenario with no gaps | PRE-A | 1. Data → BOM → **Draft inbound scenario** | Message *BOM inbound: all Plant←Supplier pairs already have lanes.* No scenario is created. | ☐ | |
| **PRD-08** | Draft inbound with a gap | PRE-A | 1. Add a BOM row whose supplier has no lane to Austin<br>2. Draft inbound scenario | `BOM inbound: added N supplier→plant lane(s).` A scenario named `BOM inbound (N lane[s])` is created. Log `apply_bom`. | ☐ | |
| **PRD-09** | Highlight BOM lanes | PRE-A | 1. Tick **Highlight BOM lanes on Network** → open Network | Lane l1 is highlighted. | ☐ | |
| **PRD-10** | Per-group capacity not enforced (known gap) | PRE-A | 1. Set Columbus Hazmat cap = 1,000<br>2. Run | **Expected per the documented gap:** the result is unchanged (Optimal $98.27M), because `capacityByProduct` is keyed by group while MIP commodities are `sku-<group>`. Pass = matches the gap; log it as a defect once a fix lands. | ☐ | |

## WF07 — Lane rates, modes, and capacity

_Carrier bids, MIP mode choice, lane capacity, binding lanes on the map._

| ID | Test | Preconditions | Steps | Expected result | Pass/Fail | Notes |
|---|---|---|---|---|---|---|
| **LAN-01** | Bid tables seeded | PRE-A | 1. Data → Lane rate tables & bids | 9 lanes, **27 bids**, strategy **Balanced**. Average current **$0.81**, average winner **$0.67**, total savings **$1.26/u**, **6** lanes with savings (captured). | ☐ | |
| **LAN-02** | Strategy switch | LAN-01 | 1. Cheapest, then Fastest | Cheapest: winner **$0.62**, savings **$1.69**, 9 lanes. Fastest: **$0.71**, **$0.83**, 6 lanes. | ☐ | |
| **LAN-03** | Apply all winners / reset | LAN-01 | 1. **Apply all winners**<br>2. **Reset rates** | Lane costs and transit times update to the winners. Log `apply_bids`. Reset restores the sample rates. | ☐ | |
| **LAN-04** | Compare → Bids | LAN-01 | 1. Compare → Bids | Same rollup as LAN-01. Per-lane Apply buttons work. | ☐ | |
| **LAN-05** | Mode mix (planning factors) | PRE-A | 1. Compare → Mode mix | Road **6 lanes (66.7%)**, ton-mi 42.9%, CO₂ 79.9%, avg $0.82. Rail **2 (22.2%)**, 45.7%, 11.6%, $0.68. Intermodal **1 (11.1%)**, 11.3%, 8.5%, $0.97 (captured). | ☐ | |
| **LAN-06** | MIP mode choice on stress-200 | PRE-C | 1. Run<br>2. Compare → **Optimized flows by mode · lane capacity** | Truck **60.9%**, Rail **33.5%**, Intermodal **5.7%** of flow. 24 lanes with modes, 72 options, 48 fixed-charge mode binaries. | ☐ | |
| **LAN-07** | Binding lane caps + duals | LAN-06 | 1. Read the binding lane list | 6 binding Rail lanes at **100%** (15,000 / 15,000): ln-1 (π −0.000135), ln-10, ln-11, ln-20, ln-21, ln-22 (π −0.000048 to −0.000054). | ☐ | |
| **LAN-08** | Map colors for lane utilization | LAN-06 | 1. Open Network | Binding lanes are **red `#f87171`**. Lanes ≥80% are **amber `#fbbf24`**. | ☐ | |
| **LAN-09** | Lane capacity infeasible (sample) | PRE-E | 1. API: sample payload with l9 `capacityUnits: 1000` | `Infeasible`, `hints: []` (captured), which is **D-03**. | ☐ | |
| **LAN-10** | Lead-time filter on modes | PRE-E | 1. API: stress-200 payload + `maxLeadTimeDays: 4` | `modeChoice.serviceFilteredModes` > 0. Record the status and objective (exploratory). | ☐ | |

## WF08 — Data import and validation scorecard

_CSV uploads, enterprise pack export/import, scorecard, negative cases (N1–N15)._

| ID | Test | Preconditions | Steps | Expected result | Pass/Fail | Notes |
|---|---|---|---|---|---|---|
| **DAT-01** | Scorecard on sample | PRE-A | 1. Data → Enterprise data model | Schema `enterprise-data-v1`, score **100**, geocode **100%**, 8 sites, 9 lanes, 6 BOM rows, no issues. | ☐ | |
| **DAT-02** | Export pack JSON | DAT-01 | 1. Export pack JSON | The file has `format: flowform-enterprise-pack`. Status `Exported enterprise pack (enterprise-data-v1).` | ☐ | |
| **DAT-03** | Re-import exported pack | DAT-02 | 1. Import pack JSON → the DAT-02 file | `Imported enterprise pack · schema enterprise-data-v1 · score 100 · 8 sites · <n> demand rows.` Run still returns $98.27M. | ☐ | |
| **DAT-04** | CSV templates round-trip | PRE-A | 1. Download the Sites, Demand, and Lanes templates<br>2. Upload them<br>3. Load into Network | Each upload shows `Parsed <file>`. Load shows `Loaded into Network · 8 nodes · 9 lanes · reconcile <n>%`. | ☐ | |
| **DAT-05** | CSV load with nothing uploaded | PRE-A | 1. Load into Network | `Upload at least one CSV (sites, demand, or lanes).` | ☐ | |
| **DAT-06** | Restore sample | DAT-04 | 1. Restore sample network | `Restored built-in sample network.` | ☐ | |
| **DAT-N1** | NEG: duplicate site id | DAT-02 file | 1. Append a copy of site n2<br>2. Import | `Import blocked — 1 error(s), score 88. Fix codes below.` Code `DUPLICATE_SITE_ID` (n2). The network is unchanged. | ☐ | |
| **DAT-N2** | NEG: orphan demand customer | DAT-02 file | 1. Set `demand[0].customerId` to `n99` | Blocked, score **88**, `ORPHAN_DEMAND_CUSTOMER`. | ☐ | |
| **DAT-N3** | NEG: lane endpoints missing | DAT-02 file | 1. Set `lanes[0].to` to `nX` and `lanes[1].from` to `nY` | Blocked, 2 errors, score **76**: `LANE_TO_MISSING` (l1) and `LANE_FROM_MISSING` (l2). | ☐ | |
| **DAT-N4** | NEG: capacity ≤ 0 | DAT-02 file | 1. Set n2 `capacityMax = 0` | Blocked, score **88**, `CAPACITY_NONPOSITIVE`. | ☐ | |
| **DAT-N5** | NEG: min > max | DAT-02 file | 1. Set n2 `capacityMin = capacityMax + 1` | Blocked, score **88**, `CAPACITY_MIN_GT_MAX`. | ☐ | |
| **DAT-N6** | NEG (warn): geocode gap | DAT-02 file | 1. Remove lat/lng on one demand site | **Loads.** Score **94**, geocode **88%**, warning `GEOCODE_GAP`. | ☐ | |
| **DAT-N7** | NEG: zero demand | DAT-02 file | 1. Set `demand[0].volume = 0` | Blocked, score **88**, `DEMAND_VOLUME_NONPOSITIVE`. | ☐ | |
| **DAT-N8** | NEG: negative lane cost | DAT-02 file | 1. Set `lanes[0].costPerUnit = -1` | Blocked, score **88**, `LANE_COST_NEGATIVE`. | ☐ | |
| **DAT-N9** | NEG (warn): unknown mode | DAT-02 file | 1. Give a lane a mode option `Teleport` | Loads. Score **97**, warning `LANE_MODE_UNKNOWN`. | ☐ | |
| **DAT-N10** | NEG: BOM cycle | DAT-02 file | 1. Add a BOM row that makes a component the parent of its FG | Blocked, score **73** (−12 error, −15 cycle), `BOM_CYCLE`. | ☐ | |
| **DAT-N11** | NEG (warn): schema mismatch | DAT-02 file | 1. Set `schemaVersion` to `enterprise-data-v0` | Loads. Score **97**, warning `SCHEMA_MISMATCH`. | ☐ | |
| **DAT-N12** | NEG: orphan demand SKU | DAT-02 file | 1. Set `demand[0].skuId` to `sku-nope` | Blocked, score **88**, `ORPHAN_DEMAND_SKU`. | ☐ | |
| **DAT-N13** | NEG (warn): duplicate lane route | DAT-02 file | 1. Append a copy of l1 with a new id | Loads. Score **97**, warning `LANE_ROUTE_DUPLICATE`. | ☐ | |
| **DAT-N14** | NEG: not a pack | any JSON | 1. Import `{"hello":1}` | `Not a flowform-enterprise-pack JSON.` | ☐ | |
| **DAT-N15** | NEG: malformed JSON | text file | 1. Import a file that contains `{not json` | `Could not parse enterprise pack JSON.` | ☐ | |
| **DAT-07** | Emission factors editable | PRE-A | 1. Data → CO₂ factors: change Truck 0.161 → 0.2, then restore it | CO₂ figures (KPI, mode mix) recompute with the new factor. | ☐ | |

## WF09 — Scenarios and Compare (incl. Robust)

_Scenario library, presets, Compare tabs, and the robust scenario tree._

| ID | Test | Preconditions | Steps | Expected result | Pass/Fail | Notes |
|---|---|---|---|---|---|---|
| **SCN-01** | Library | PRE-A | 1. Open Scenarios | Baseline ($48.2M, 94.1%, $0, 12.4 kt, Med), East Coast DC ($46.1M, 96.8%, $18M, 11.1 kt, Low), Nearshore MX, and Lean Lanes. | ☐ | |
| **SCN-02** | Activate a scenario | SCN-01 | 1. Activate Nearshore MX | The Active chip and KPI strip update. Log `activate_scenario`. | ☐ | |
| **SCN-03** | Sensitivity presets | PRE-A | 1. Scenarios → preset **Fuel +20%** | Scenario `Baseline · Fuel +20%` is created and becomes Active. Each preset creates `<Active> · <label>`. | ☐ | |
| **SCN-04** | Compare layout | PRE-A | 1. Open Compare | Reference = Baseline, up to **5** scenario chips. **14 tabs**: Matrix, Map diff, Waterfall, Cost-to-serve, DES-lite, Sensitivity, Inventory, Resilience, Mode mix, Products, Bids, BOM, Territory, Robust. | ☐ | |
| **SCN-05** | Matrix + Map diff + Waterfall | SCN-04 | 1. Select Baseline + East Coast DC; open Matrix, Map diff, and Waterfall | KPI deltas vs the Reference render. Map diff shows the legend. With focus = Reference it shows *No diff vs Reference (same scenario).* | ☐ | |
| **SCN-06** | Cost-to-serve on MIP flows | PRE-B | 1. Compare → Cost-to-serve (focus the optimize scenario) | Rows show the service DC per customer. The total ≈ objective transport + variable OpEx. | ☐ | |
| **SCN-07** | Robust: default chips | PRE-A | 1. Compare → Robust; leave **Use selected chips as shocks** ticked (2 chips) → **Robust optimize** | Optimal. E[cost] **$20.62M** (both chips scale 1.0; captured 20.615). | ☐ | |
| **SCN-08** | Robust: built-in shocks, Expected | PRE-A | 1. Untick **Use selected chips as shocks**<br>2. Objective **Expected cost** → Robust optimize | Captured: E[cost] **$21.13M**, worst **$24.94M**, EVPI gap **$0.00M**. First-stage opens **n1, n2, n3, n8**. Per scenario: Base (p 0.4, ×1.0) $20.615M, Soft (0.3, ×0.85) $18.018M, Surge (0.3, ×1.25) $24.944M. Log `robust_optimize`. | ☐ | |
| **SCN-09** | Robust: Minimax | SCN-08 | 1. Objective **Minimax (robust)** | Objective value **$24.94M**. | ☐ | |
| **SCN-10** | Robust: CVaR-lite | SCN-08 | 1. Objective **CVaR-lite**, α 0.3 | Objective value **$22.28M** (captured 22.27724). | ☐ | |
| **SCN-11** | Robust from Scenarios room | PRE-A | 1. Scenarios → Robust optimize card → Expected → run | Uses the 4 library scenarios at p 0.25 each. Status `Robust expected: E[cost] $21.9M · opens n1, n2, n3, n8 · EVPI $0.00M. See Compare → Robust.` (captured E 21.9136). | ☐ | |
| **SCN-12** | Robust export to Brief | SCN-08 | 1. **Export to Brief**, twice | `Exported to Decision Brief notes.` The notes hold a single `## Robust / stochastic optimize` section (replaced, not duplicated). | ☐ | |
| **SCN-13** | Robust keeps Reno open (D-04) | SCN-08 | 1. Compare the robust opens with the Run result | Robust opens **n8**; Run closed it. Robust $ omit BOM/SKUs, so robust and Run totals are not comparable. | ☐ | |
| **SCN-14** | Comments | PRE-A | 1. Compare → Comments: add a comment<br>2. Reload | The comment persists after reload and can be deleted. | ☐ | |

## WF10 — Roadmap and Optimize timing

_CapEx events, cumulative KPIs, multi-period NPV, year slices._

| ID | Test | Preconditions | Steps | Expected result | Pass/Fail | Notes |
|---|---|---|---|---|---|---|
| **RMP-01** | Default roadmap | PRE-A | 1. Open Roadmap | Base FY26, 6 years (Y0–Y5). Events: Expand Columbus DC Y1 $4.5M +6; Open Kansas City DC Y2 $12M +10 (`roadmap-kc-dc`); Expand Reno DC Y3 $3.2M +4; Close Atlanta DC Y4 $1.5M −14; Expand Austin Plant Y5 $8M +8. | ☐ | |
| **RMP-02** | Cumulative table | RMP-01 | 1. Read the cumulative CapEx / capacity rows | Captured: Y0 $0 / cap 86 / 4 open; Y1 $4.5M / 92 / 4; Y2 **$16.5M** / 102 / 5; Y3 $19.7M / 106 / 5; Y4 $21.2M / 92 / 4 open + 1 closed; Y5 **$29.2M** / 100 / 4. | ☐ | |
| **RMP-03** | Optimize timing: choose (D-01) | PRE-A | 1. Mode Choose timing, discount 10% → **Optimize timing** | **Actual (captured on Mac and box):** `Infeasible / Infeasible. See results panel.` Hint `MULTI_PERIOD_INFEASIBLE` (*Multi-period CapEx NPV model infeasible.*). Mark **Fail → D-01**. After the fix, expect Optimal with an NPV. | ☐ | |
| **RMP-04** | Optimize timing: force (D-01) | PRE-A | 1. Mode Force timeline → Optimize timing | Same Infeasible result. Fail → D-01. | ☐ | |
| **RMP-05** | Workaround: drop the KC open event | PRE-A | 1. Remove *Open Kansas City DC*<br>2. Choose timing → Optimize timing | Optimal (captured). `NPV $111.91M · mode choose_timing · r=10% · timing applied to roadmap events.` CapEx NPV $10.68M, OpEx $15.38M, transport $85.85M. All 4 events move to **Y5**. Per-year total Y0–Y4 $20.615M, Y5 $41.789M. Log `optimize_timing`. | ☐ | |
| **RMP-06** | Workaround: force timeline | RMP-05 | 1. Force timeline → Optimize timing | Optimal **NPV $116.43M** (captured 116.4309). | ☐ | |
| **RMP-07** | Discount rate 0% | RMP-05 | 1. Discount 0% → Optimize timing | NPV changes (no discounting). Record it (exploratory). | ☐ | |
| **RMP-08** | Apply year slice | PRE-A | 1. Apply year slice: through **Y2** → Apply as scenario | `Roadmap Y2: 2 CapEx event(s) applied (cum $16.5M).` New Active scenario. Log `apply_roadmap`. | ☐ | |
| **RMP-09** | Export NPV to Brief | RMP-05 | 1. **Export NPV to Brief** | Brief notes gain `## CapEx multi-period optimize (NPV)`. Assumption a3 is unticked and relabeled *CapEx is overnight build — no phased construction (roadmap NPV in notes)*. | ☐ | |
| **RMP-10** | API offline | PRE-D | 1. Optimize timing | `Optimize API unreachable — start apps/api on :5182.` | ☐ | |

## WF11 — Sensitivity: tornado, Monte Carlo, DES-lite, inventory, resilience

_Seeded client-side analytics on the Active scenario._

| ID | Test | Preconditions | Steps | Expected result | Pass/Fail | Notes |
|---|---|---|---|---|---|---|
| **SEN-01** | Tornado + MC on Baseline | PRE-A | 1. Compare → Sensitivity → **Run tornado + MC** | Baseline **$48.2M**, 300 trials, seed 42. Tornado (captured): Demand volume ±15% $45.22–51.18M (swing 5.96); Transport $/mi 45.31–51.09 (5.78); Tariff / duty 46.03–50.37 (4.34); Fuel 46.75–49.65 (2.90); Facility fixed cost 47.04–49.36 (2.32); Inventory holding 47.24–49.16 (1.92). MC: **P10 $44.34M, P50 $48.29M, P90 $51.92M**, mean 48.18, min 40.61, max 57.93. | ☐ | |
| **SEN-02** | Deterministic re-run | SEN-01 | 1. **Re-run tornado + MC** | Same numbers. | ☐ | |
| **SEN-03** | Run from Scenarios | PRE-A | 1. Scenarios → Cost tornado → **Run on Active** | Same numbers. Log `apply_sensitivity`. | ☐ | |
| **SEN-04** | Follows Active cost | PRE-B | 1. Run tornado + MC on the optimize scenario | Baseline shows **$98.3M**. | ☐ | |
| **SEN-05** | DES-lite | PRE-A | 1. Compare → DES-lite → **Run DES-lite (200 trials)** | Fill **98%**, late **2%**, mean lead **1.32 d**, P95 **2.41 d**. Bins: <80% 0, 80–90% 4, 90–95% 25, 95–98% 35, ≥98% 136 (captured). | ☐ | |
| **SEN-06** | Inventory (ASCM combined) | PRE-A | 1. Compare → Inventory | Total **5,039 units / $77,802**. Austin 2,150 / $25,800; Columbus 1,642 / $29,556; Atlanta 556 / $10,008; Reno 691 / $12,438. | ☐ | |
| **SEN-07** | Inventory simple formula | SEN-06 | 1. Formula **Simple z · σ · √LT** | Total **2,447 units / $38,100**. | ☐ | |
| **SEN-08** | Apply inventory to KPIs | SEN-06 | 1. **Apply to Active KPIs** | Inventory $ and units appear for the Active scenario. | ☐ | |
| **SEN-09** | Resilience (D-08) | PRE-A | 1. Compare → Resilience, threshold 95 → **Score resilience** | Score **10**, baseline service **58.8%**. Critical: Columbus (after 25.6%, −33.2pp), Austin (33.2%, −25.6pp), Atlanta (0pp), Reno (0pp). All 4 are flagged, which is **D-08**. | ☐ | |

## WF12 — Infeasibility diagnostics

_Break the sample on purpose; check hints, chips, and UI behavior._

| ID | Test | Preconditions | Steps | Expected result | Pass/Fail | Notes |
|---|---|---|---|---|---|---|
| **INF-01** | Remove hazmat lane l9 | PRE-A | 1. Data → Export pack JSON; delete lane `l9` from `lanes[]` (there is no lane-delete button in the UI)<br>2. Data → Import pack JSON (score 100, loads)<br>3. Run | Captured: **Infeasible**, chip **UNREACHABLE_DEMAND**, *1 demand row(s) have no reachable capable server within 250 mi (vol 2280).* Entity `n6/sku-hazmat`. The new scenario is named `Optimize Infeasible <time>`. | ☐ | |
| **INF-02** | Diagnostics panel | INF-01 | 1. Compare → Matrix → Infeasibility diagnostics | Hint code, message, remediation text, and metrics (unreachable volume 2,280; openable capacity 107,500). | ☐ | |
| **INF-03** | Lower target still infeasible (D-02) | INF-01 | 1. Service target 90 → Run | Still **UNREACHABLE_DEMAND** (captured). The real blocker is `capacityMin` (D-02). | ☐ | |
| **INF-04** | Root cause: zero capacity mins | INF-01 | 1. Inspector on Austin, Columbus, Atlanta, Reno: capacity min = 0<br>2. Run | **Optimal, 91.8%**, **$122.76M** including a **$34.2M** unmet penalty (2,280 × $15) (captured). | ☐ | |
| **INF-05** | Hard service + 3-day lead | PRE-A | 1. Hard service on, max lead-time 3 → Run | Infeasible, **HARD_SERVICE_INFEASIBLE** (captured). | ☐ | |
| **INF-06** | Restore | INF-01 | 1. Data → Restore sample network (or re-import the unmodified pack)<br>2. Run | Optimal $98.27M. | ☐ | |
| **INF-07** | Brief with an infeasible Active | INF-01 | 1. Open Brief | No crash. | ☐ | |

## WF13 — Stress-120/200 performance

_Large enterprise packs: load, solve time, chips, CTS, explain._

| ID | Test | Preconditions | Steps | Expected result | Pass/Fail | Notes |
|---|---|---|---|---|---|---|
| **STR-01** | Load stress-200 (Projects) | PRE-A | 1. Projects → **Load stress-200** | `Loaded stress-200 into Active project · 212 sites · 400 demand rows (schema enterprise-data-v1). Open Data to review scorecard, then Run.` | ☐ | |
| **STR-02** | Load stress-200 (Data) | PRE-A | 1. Data → **Load stress-200** | `Loaded stress-200 · schema enterprise-data-v1 · score 100 · 212 sites · 400 demand rows · 425 lanes.` | ☐ | |
| **STR-03** | Run stress-200 | PRE-C | 1. Run; time from click to done | `API pulp-highs · Optimal · …s · fixed-charge-multi-echelon-v1 · service 100.0% · obj $176.81M (tx $168.48M + CapEx $0.0M + OpEx $7.8M) · … · modes Truck 61%/Rail 34%/Intermodal 6% · 6 binding lane cap(s)`. Solve **0.85 s (Mac) / 1.34 s (box)**. Wall time with explain ≈ **3.7 s** (11 counterfactuals ≈ 2.3 s). Pass if < 60 s. | ☐ | |
| **STR-04** | Stress-200 decisions | STR-03 | 1. Compare objective breakdown | **9 open** (dc-1…dc-6, plt-1…plt-3). **Seattle DC (dc-7)** and **Miami DC (dc-8)** stay closed. Lane fixed **$0.53M**, unmet $0. KPI **$176.3M (+265.8%)**, CO₂ **20.8 kt (+68%)** (D-06: costM omits lane fixed). | ☐ | |
| **STR-05** | Stress-200 explain | STR-03 | 1. Inspector on Dallas DC and Seattle DC; Compare Why-this-network | Headline *The MIP kept 9 existing site(s) open. Costliest flip: closing Ontario Plant strands 37.5M units (service 81.0%).* Dallas DC: *Capacity binding (100% utilized): each extra unit of capacity saves $0.065/unit*. Seattle DC: *Opening it raises cost by $6.6M (3.8%); service holds at 100.0%*. | ☐ | |
| **STR-06** | CTS on stress-200 | STR-03 | 1. Compare → Cost-to-serve | Customer rows render with a service DC. Record the render time. | ☐ | |
| **STR-07** | Stress-120 | PRE-A | 1. Load stress-120 → Run | Optimal **$89.12M** (tx $81.00M, OpEx $7.8M, lane fixed $0.32M), 9 open, 100%. `modes Truck 59%/Rail 36%/Intermodal 4% · 3 binding lane cap(s)` (ln-10, ln-20, ln-22). Solve 0.07–0.16 s. KPI $88.8M (+84.2%). Scorecard: 132 sites, 240 demand rows, 265 lanes, score 100. | ☐ | |
| **STR-08** | pytest benchmark | SET-02 | 1. cd apps/api && pytest -q tests/test_stress_benchmark.py -s | Prints stress-120 objective **89.1208**, stress-200 objective **176.8117** (176.8118 on the Mac), open=9, Optimal. **3 passed**. | ☐ | |
| **STR-09** | UI responsiveness | STR-03 | 1. Pan/zoom, toggle layers, switch Compare tabs | No freeze longer than ~2 s. | ☐ | |

## WF14 — Brief export

_Recommendation, assumptions, notes, Markdown/HTML export, why-this-network._

| ID | Test | Preconditions | Steps | Expected result | Pass/Fail | Notes |
|---|---|---|---|---|---|---|
| **BRF-01** | Brief defaults | PRE-A | 1. Open Brief | Recommended **East Coast DC**. 6 assumptions, 5 ticked. | ☐ | |
| **BRF-02** | Why-this-network hint before Run | PRE-A | 1. Brief with no API run | *Why this network: run Optimize with the API online to get MIP explain cards…* | ☐ | |
| **BRF-03** | Why this network after Run | PRE-B | 1. Recommend the optimize scenario | The explain panel shows the NET-06 headline and the objective $98.27M = $95.67M + $0.0M + $2.6M. | ☐ | |
| **BRF-04** | Download Markdown | BRF-03 | 1. **Download Markdown** | File `flowform-brief-FY27.md` with recommendation, KPIs, assumptions, notes, and a Why-this-network section. | ☐ | |
| **BRF-05** | Printable HTML | BRF-03 | 1. **Printable HTML** | `flowform-brief-FY27.html` opens and prints cleanly. | ☐ | |
| **BRF-06** | Horizon in filename | BRF-04 | 1. Horizon FY28 → Download Markdown | `flowform-brief-FY28.md`. | ☐ | |
| **BRF-07** | Send to Handoff | BRF-01 | 1. **Send to Handoff** | Navigates to Handoff with the package built. | ☐ | |

## WF15 — Handoff package

_flowform.handoff.v1 JSON + ops brief (Ritara intake stub only)._

| ID | Test | Preconditions | Steps | Expected result | Pass/Fail | Notes |
|---|---|---|---|---|---|---|
| **HND-01** | Waiting state | PRE-A (fresh) | 1. Open Handoff before sending from Brief | Empty state **Waiting for Brief**. | ☐ | |
| **HND-02** | Package overview | BRF-07 | 1. Read the counts | Schema `flowform.handoff.v1`. Sites **8**, lanes **9**, preferred **5**, territory **3**, CapEx events **5**, groups **3**, BOM **6**, implied RM **6**, inventory nodes **4**, scenarios **3**, checked assumptions **5**. | ☐ | |
| **HND-03** | Download JSON | HND-02 | 1. **Download JSON** | `flowform-handoff-FY27-flowform.handoff.v1.json`. `inventory_targets` totals 5,039 units / $77,802. | ☐ | |
| **HND-04** | Ops brief | HND-02 | 1. **Ops brief (Markdown)** | `flowform-handoff-ops-FY27.md` starting `# Flowform → Ritara ops brief`. Recommendation East Coast DC ($46.1M, 96.8%, $18M, 11.1 kt, Low). Territory line matches TER-02. | ☐ | |
| **HND-05** | Section tabs | HND-02 | 1. Open each section tab | Each renders. Raw shows a *Truncated preview* note. | ☐ | |
| **HND-06** | Stub disclaimer | HND-03 | 1. Read the JSON readme | *Contract stub only — not a live API sync* and *No Ritara code is embedded.* | ☐ | |
| **HND-07** | Decision log | HND-03 | 1. Check the log | A `handoff_export` entry. | ☐ | |

## WF16 — Merge (M&A)

_Acquired network import, conflicts, merged baseline draft._

| ID | Test | Preconditions | Steps | Expected result | Pass/Fail | Notes |
|---|---|---|---|---|---|---|
| **MRG-01** | Load sample acquired | PRE-A | 1. Merge → **Load sample acquired** | Primary 8 nodes / 9 lanes. Acquired **6 / 5**. Merged preview **14 / 14**. | ☐ | |
| **MRG-02** | Conflicts | MRG-01 | 1. Read the conflicts | **n2** (Columbus DC (dc) vs Columbus Hub (Acquired) (dc)) and **l4** (n2→n4 · Truck vs n2→acq-d2 · Truck). Default **Keep both (rename acquired)**. | ☐ | |
| **MRG-03** | Change resolutions | MRG-02 | 1. Set both to **Keep primary only** (then try **Replace with acquired**) | Merged preview **13 nodes / 13 lanes** for either option (captured). | ☐ | |
| **MRG-04** | Apply merge | MRG-02 | 1. **Apply merge + draft scenario** | `Merged 6 acquired nodes + 5 lanes → 14 nodes / 14 lanes (2 conflicts). Draft scenario “Merged baseline (M&A draft)” is now Active.` Draft KPIs: $56.6M (+16.8%), 96.5%, $30M, 13.9 kt, Low. | ☐ | |
| **MRG-05** | Clean merge message | PRE-A | 1. Import an acquired network with no shared ids | *No duplicate ids — clean merge.* | ☐ | |
| **MRG-06** | Run on merged network | MRG-04 | 1. Run | A status chip is returned. Record it (exploratory). | ☐ | |

## WF17 — Decision log, projects, share

_Append-only audit log, project CRUD, export/import, share stub._

| ID | Test | Preconditions | Steps | Expected result | Pass/Fail | Notes |
|---|---|---|---|---|---|---|
| **LOG-01** | Log entries | PRE-A | 1. Activate a scenario, Run, apply a preset, apply bids<br>2. Open the Decision log panel | Entries appear in time order: `activate_scenario`, `run_optimize`, `create_scenario` / `apply_sensitivity`, `apply_bids`. | ☐ | |
| **LOG-02** | Filter / export / clear | LOG-01 | 1. Filter by run_optimize<br>2. **Export JSON**<br>3. Clear | The filter works. Export downloads `<project>.decision-log.json`. Clear empties the log. | ☐ | |
| **LOG-03** | Persistence | LOG-01 | 1. Reload | Entries persist in the project snapshot. | ☐ | |
| **LOG-04** | All 13 action types | PRE-A | 1. Trigger each: create_scenario, activate_scenario, run_optimize, apply_hub, apply_territory, apply_roadmap, optimize_timing, robust_optimize, apply_bom, apply_bids, apply_sensitivity, handoff_export, share | Each appears at least once. `optimize_timing` needs the RMP-05 workaround (D-01). `apply_bom` needs PRD-08. | ☐ | |
| **LOG-05** | Projects CRUD | PRE-A | 1. New → Rename → Duplicate → Export → Open → Delete | Each works. Export gives `<name>.flowform.json`. With one project left, Delete is disabled (*Keep at least one project*). | ☐ | |
| **LOG-06** | Project isolation | LOG-05 | 1. Run in project A, then switch to B | B does not show A's optimize scenario. | ☐ | |
| **LOG-07** | Share stub | PRE-A | 1. Top chrome **Share** | Shows a `flowform://share?…` link and downloads `<name>.share.json` (read-only stub). Log `share`. | ☐ | |

## WF18 — Themes and keyboard shortcuts

_Theme persistence and global keys._

| ID | Test | Preconditions | Steps | Expected result | Pass/Fail | Notes |
|---|---|---|---|---|---|---|
| **UX-01** | Theme toggle | PRE-A | 1. Click the Light/Dark toggle | `<html data-theme>` flips, and the basemap style switches. | ☐ | |
| **UX-02** | Theme persists | UX-01 | 1. Reload | The theme is kept (`localStorage['flowform-theme']`). | ☐ | |
| **UX-03** | First load follows the OS | SET-09 | 1. Delete `flowform-theme`, set the OS to light, reload | Starts in light (`prefers-color-scheme`). | ☐ | |
| **UX-04** | ? opens help | PRE-A | 1. Press `?` | **Keyboard shortcuts** dialog: Esc (*Clear map / table selection*), ? (*Show or hide this help*), Shift + click (*Multi-select nodes or lanes*), Click map background (*Clear selection*). Note: *Shortcuts are ignored while typing in inputs or text areas.* | ☐ | |
| **UX-05** | Esc order | UX-04 | 1. Select a node, open help, press Esc twice | The first Esc closes help. The second clears the selection. | ☐ | |
| **UX-06** | Keys ignored in inputs | PRE-A | 1. Type `?` in a text input | The character is typed into the input, and help does not open. | ☐ | |
| **UX-07** | Help button | PRE-A | 1. Click Help in the chrome; click the backdrop | The dialog opens and the backdrop click closes it. | ☐ | |
| **UX-08** | Search stub | PRE-A | 1. Click Search | No action, no error (stub). | ☐ | |
| **UX-09** | Nav order + room tips | PRE-A | 1. Read the left nav; visit every room | Order: Projects, Network, Greenfield, Hubs, Territory, Roadmap, Scenarios, Compare, Brief, Data, Merge, Handoff. Each room renders without errors. | ☐ | |

## WF19 — API-only checks with curl

_Contract checks without the UI. Run from `apps/api` with the venv active, API on :5182._

| ID | Test | Preconditions | Steps | Expected result | Pass/Fail | Notes |
|---|---|---|---|---|---|---|
| **API-01** | Build sample payload | PRE-E | 1. python3 -c "import json; from tests.test_demo_cost_scaling import sample_payload; json.dump(sample_payload(), open('/tmp/ff-sample.json','w'))" | `/tmp/ff-sample.json` is written. | ☐ | |
| **API-02** | POST /optimize | API-01 | 1. curl -s -X POST localhost:5182/optimize -H 'content-type: application/json' -d @/tmp/ff-sample.json \| python3 -m json.tool | `status Optimal`, `solver pulp-highs`, `objectiveBreakdown.totalM 98.2706`, `transportM 95.6706`, `fixedOpexM 2.6`, `closedIds ["n8"]`, `kpis.servicePct 100.0`, `costScale.offLanePremium 1.35`, `uncoveredPenaltyPerUnit 15.0`. No `explain` key. | ☐ | |
| **API-03** | POST /optimize/explain | API-01 | 1. curl -s -X POST localhost:5182/optimize/explain -H 'content-type: application/json' -d @/tmp/ff-sample.json \| python3 -c "import json,sys; e=json.load(sys.stdin)['explain']; print(e['headline']); print(e['topOpenedIds'], e['topClosedIds'])" | The NET-06 headline, then `['n2', 'n1', 'n3'] ['n8']`. | ☐ | |
| **API-04** | No l9 → infeasible | API-01 | 1. python3 -c "import json; p=json.load(open('/tmp/ff-sample.json')); p['network']['lanes']=[l for l in p['network']['lanes'] if l['id']!='l9']; json.dump(p, open('/tmp/ff-nol9.json','w'))"<br>2. curl -s -X POST localhost:5182/optimize -H 'content-type: application/json' -d @/tmp/ff-nol9.json \| python3 -c "import json,sys; r=json.load(sys.stdin); h=r['infeasibilityReport']['hints'][0]; print(r['status'], h['code'], h['entities'])" | `Infeasible UNREACHABLE_DEMAND ['n6/sku-hazmat']` | ☐ | |
| **API-05** | Stress-200 timing | PRE-E | 1. python3 -c "import json,time,urllib.request as u; from tests.enterprise_payload import load_enterprise_pack as L, pack_to_optimize_payload as P; p=P(L('stress-200-demand.enterprise.json')); t=time.time(); r=json.load(u.urlopen(u.Request('http://127.0.0.1:5182/optimize', json.dumps(p).encode(), {'content-type':'application/json'}))); print(r['status'], r['objectiveBreakdown']['totalM'], len(r['openIds']), r['solveSeconds'], round(time.time()-t,2))" | `Optimal 176.8117 9 <0.85–1.35> <wall s>` (176.8118 on the Mac). | ☐ | |
| **API-06** | Multi-period replay (D-01) | PRE-A + DevTools | 1. Roadmap → Optimize timing; DevTools → Network → right-click `/optimize/multi-period` → Copy as cURL; replay it in the terminal | `ok false`, `status Infeasible`, hint `MULTI_PERIOD_INFEASIBLE`. The log includes *Facility roadmap-kc-dc already open — open event(s) ignored in linkage.* Without the KC event: `Optimal`, `npv.totalM 111.9095`. | ☐ | |
| **API-07** | Stochastic replay | PRE-A + DevTools | 1. Run SCN-08; Copy as cURL for `/optimize/stochastic`; replay it | `expectedCostM 21.13445`, `worstCostM 24.94375`, `firstStage.openIds [n1,n2,n3,n8]`, `evpi.evpiGapM 0.0`. Change objective to minimax → `objectiveValueM 24.94375`; cvar_lite → `22.27724`. | ☐ | |
| **API-08** | 422 schema error | PRE-E | 1. curl -s -w ' %{http_code}' -X POST localhost:5182/optimize -H 'content-type: application/json' -d '{"network":{}}' | HTTP **422**, `loc [body, constraints]`, `Field required`. | ☐ | |
| **API-09** | 400 empty network | PRE-E | 1. curl -s -w ' %{http_code}' -X POST localhost:5182/optimize -H 'content-type: application/json' -d '{"network":{"nodes":[],"lanes":[]},"constraints":{}}' | HTTP **400** `No facility nodes (dc/plant/candidate) in network.` | ☐ | |
| **API-10** | 400 multi-period without demand | PRE-E | 1. curl -s -w ' %{http_code}' -X POST localhost:5182/optimize/multi-period -H 'content-type: application/json' -d '{"network":{"nodes":[],"lanes":[]},"constraints":{},"roadmap":{"events":[]}}' | HTTP **400** `No demand nodes in network.` | ☐ | |
| **API-11** | 400 stochastic with 1 scenario | API-07 | 1. Edit the replayed body down to 1 scenario | HTTP **400** `Need 2–5 scenarios, got 1.` | ☐ | |
| **API-12** | Cost knobs | API-01 | 1. Add `offLanePremium: 1.5` and `uncoveredPenaltyPerUnit: 40` to `constraints`; POST | `costScale.offLanePremium 1.5`, `uncoveredPenaltyPerUnit 40`. | ☐ | |
| **API-13** | CORS allows 5180 (not 5173) | SET-02 | 1. curl -s -i -X OPTIONS localhost:5182/optimize -H 'Origin: http://localhost:5180' -H 'Access-Control-Request-Method: POST'<br>2. Repeat with Origin http://localhost:5173 | 5180 → `access-control-allow-origin: http://localhost:5180` (5181 is also allowed). 5173 → HTTP 400 with no allow-origin header. | ☐ | |
| **API-14** | Carbon price (D-05) | API-01 | 1. Add `carbonPricePerTonne: 100`; POST | `objectiveBreakdown.carbonM 197.3422`, total **296.4632**, while `kpis.transportCo2Kt` is 2.704. This is D-05. | ☐ | |

## Regression suite

Run this after any change to `apps/api/app/*` or `apps/web/src/data/*`. It takes about 30 minutes and covers the high-value checks.

| ID | Check | Covered by | Pass/Fail | Notes |
|---|---|---|---|---|
| **REG-01** | Sample Run: Optimal $98.27M, 100%, Reno closed | RUN-02, RUN-04 | ☐ | |
| **REG-02** | Explain headline + Atlanta flip +$850k | NET-02, NET-06 | ☐ | |
| **REG-03** | No l9: Infeasible UNREACHABLE_DEMAND n6/sku-hazmat | INF-01, API-04 | ☐ | |
| **REG-04** | Stress-200: Optimal ≈$176.81M, 9 open, 6 binding lanes, < 60 s | STR-03, STR-08 | ☐ | |
| **REG-05** | Stress-120: Optimal ≈$89.12M, 3 binding lanes | STR-07 | ☐ | |
| **REG-06** | Import blocks on errors and loads on warnings | DAT-N1, DAT-N6 | ☐ | |
| **REG-07** | Robust built-in shocks: E $21.13M / worst $24.94M | SCN-08 | ☐ | |
| **REG-08** | Roadmap Optimize timing (Fail until D-01 is fixed) | RMP-03 | ☐ | |
| **REG-09** | Heuristic fallback when the API is down (58.8%) | RUN-09 | ☐ | |
| **REG-10** | Sensitivity P10/P50/P90 44.34 / 48.29 / 51.92 | SEN-01 | ☐ | |
| **REG-11** | DES-lite fill 98% / late 2% | SEN-05 | ☐ | |
| **REG-12** | Brief MD/HTML + Handoff JSON/MD downloads; counts 8/9/5/3/5 | BRF-04, HND-02 | ☐ | |
| **REG-13** | Merge sample: 14/14, 2 conflicts | MRG-01, MRG-02 | ☐ | |
| **REG-14** | Theme persists; ? and Esc behave; web on port 5180 | UX-01..05, SET-04 | ☐ | |
| **REG-15** | pytest 54 passed; web test:data + build green | SET-05, SET-06 | ☐ | |
| **REG-16** | OpenFreeMap default basemap, no key | SET-07 | ☐ | |

## Defect log

Template: copy a row per defect. Severity is High (blocks a workflow), Medium (wrong result with a workaround), or Low (cosmetic or diagnostic). The pre-filled rows are the defects found while capturing the expected values (details in the blueprint §11).

| Defect ID | Date | Tester | Test ID | Severity | Summary | Steps to reproduce | Expected | Actual | Build | Status | Owner |
|---|---|---|---|---|---|---|---|---|---|---|---|
| D-01 | 2026-10-17 | capture | RMP-03 / API-06 | High | Roadmap Optimize timing is Infeasible on the default roadmap: the materialized KC open-event node is treated as already open | see RMP-03 | see test | see test | 1b2afc2 | Open | |
| D-02 | 2026-10-17 | capture | INF-03 / INF-04 | Medium | No-l9 is diagnosed as UNREACHABLE_DEMAND; the real blocker is facility capacityMin | see INF-03 | see test | see test | 1b2afc2 | Open | |
| D-03 | 2026-10-17 | capture | LAN-09 | Low | Lane-capacity infeasibility returns no hints | see LAN-09 | see test | see test | 1b2afc2 | Open | |
| D-04 | 2026-10-17 | capture | SCN-13 | Medium | Robust forces existing sites open; robust $ omit BOM/SKUs | see SCN-13 | see test | see test | 1b2afc2 | Open | |
| D-05 | 2026-10-17 | capture | API-14 | Medium | Carbon-price magnitude is inconsistent with the reported CO₂ | see API-14 | see test | see test | 1b2afc2 | Open | |
| D-06 | 2026-10-17 | capture | STR-04 | Low | kpis.costM excludes lane fixed charges | see STR-04 | see test | see test | 1b2afc2 | Open | |
| D-07 | 2026-10-17 | capture | NET-13 | Low | maxFacilities excludes plants (undocumented) | see NET-13 | see test | see test | 1b2afc2 | Open | |
| D-08 | 2026-10-17 | capture | SEN-09 | Low | Resilience flags every facility critical on Baseline (58.8% < 95%) | see SEN-09 | see test | see test | 1b2afc2 | Open | |
| D-__ | | | | | | | | | | | |

## Sign-off

| Role | Name | Date | Result |
|---|---|---|---|
| Tester | | | Pass / Fail with defects |
| Product owner | | | |
