# Flowform — Manual Test Workbook

> Companion to [`MASTER_BLUEPRINT.md`](MASTER_BLUEPRINT.md), and the verification counterpart to [`USER_WORKFLOWS.md`](USER_WORKFLOWS.md). This supersedes the Sep 28 `SMOKE_CHECKLIST.md` as the full regression; that file remains the 10-minute smoke.
> Excel copy: [`Flowform_Manual_Test_Workbook.xlsx`](Flowform_Manual_Test_Workbook.xlsx) (one sheet per workflow, Pass/Fail dropdowns, live status counts). **This Markdown is the source of truth**; the `.xlsx` is a point-in-time export and does not yet contain WF20.

| | |
|---|---|
| Build under test | `master` @ `8e2d909` (Oct 23, 2026) **+ the uncommitted hardening pass** (guards, versioning, SSE deadline, parity). Solve values are unchanged from `a6d3fae`/`1b2afc2`; platform cases are new. |
| Scope | **21 workflows · 199 original cases + 28 platform & hardening cases** + regression checks + defect log |
| Ports | Web **5180** (never 5173) · API **5182** |
| Solver | PuLP + HiGHS (`pulp-highs`) |
| Result codes | **Pass** · **Fail** · **Blocked** · **Not Run** |

## How to use

1. Complete **WF00 Setup** first. If any SET case fails, the expected values below are not valid for your environment.
2. Each case lists a **precondition** (a PRE-x state below or another case ID). Reach that state first.
3. Values in **bold** were **captured** by running the code at `1b2afc2` (rows touched by the D-01…D-08 fixes re-captured at `a6d3fae`) (API on the box and the Mac; client engines with their built-in seeds). Times vary by machine; costs should match to the cent. Cases marked *exploratory* have no captured value, so record what you see.
4. D-01…D-08 are **Fixed in `a6d3fae`**; D-09…D-16 are **fixed in the uncommitted hardening pass** (they are not in `8e2d909`). The affected cases carry post-fix values. Log any new defect as D-17+.
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
| WF19 | API | [API-only checks with curl](#wf19--api-only-checks-with-curl) | 25 |
| WF20 | PLT | [Platform: workspace, jobs, auth, guardrails](#wf20--platform-workspace-jobs-auth-guardrails) | 17 |
| | | **Total** | **199 + 28** |

## WF00 — Setup and preflight

_Make sure the environment matches the expected-value baseline before running any workflow._

| ID | Test | Preconditions | Steps | Expected result | Pass/Fail | Notes |
|---|---|---|---|---|---|---|
| **SET-01** | Repo at expected commit | Mac terminal | 1. cd "$(git rev-parse --show-toplevel)"<br>2. git log --oneline -1<br>3. git status --short | HEAD is `8e2d909 feat(api): FF-106 auth core…`. Testing the hardening pass means `git status` shows the uncommitted code/test/docs files listed in blueprint §11.3; that is expected, not drift. `apps/web/.env.local`, if present, never appears (gitignored). | ☐ | |
| **SET-02** | API starts on 5182 | Python venv exists | 1. cd apps/api && source .venv/bin/activate<br>2. uvicorn app.main:app --reload --host 127.0.0.1 --port 5182<br>3. curl -s http://127.0.0.1:5182/health | `{"status":"ok","service":"flowform-api","model":"fixed-charge-multi-echelon-v1+multi-period-run-basis-v2+stochastic-scenario-tree-v1+explain-v1"}` | ☐ | |
| **SET-03** | Solver is HiGHS | SET-02 | 1. Run API-02, or look at the Run log tooltip after RUN-02 | Response `solver` = `pulp-highs`. If CBC is used instead, duals fall back to a proxy and expected values may differ. | ☐ | |
| **SET-04** | Web starts on 5180 (never 5173) | Node 20+, npm install done | 1. cd apps/web && npm run dev<br>2. Open http://localhost:5180 | Vite serves on **5180** (`strictPort`). The app opens on the **Network** room with the map. If 5180 is busy, Vite fails instead of moving to another port. | ☐ | |
| **SET-05** | API unit tests green | SET-02 venv | 1. cd apps/api && pytest -q | **133 passed, 4 skipped** at the hardening pass (was 79). The 4 skips are the Postgres/RLS modules when `DATABASE_URL` is unset; they run in CI and in WF20. Deprecation warnings are OK. | ☐ | |
| **SET-06** | Web data tests + build green | npm install done | 1. cd apps/web && npm run test:data<br>2. npm run typecheck<br>3. npm run lint<br>4. npm run build | All **8 data suites** pass (enterprise 15, CTS 2, defect fixes, workspace sync, validation, onboarding, narrative, jobs). `tsc -b` clean; oxlint **0 errors** (18 pre-existing warnings); build `✓ built` with only the >500 kB chunk-size warning. | ☐ | |
| **SET-07** | Basemap default is OpenFreeMap | PRE-A, no VITE_BASEMAP override | 1. Open Network<br>2. DevTools → Network, filter `openfreemap` | Tiles load from `tiles.openfreemap.org` (`liberty` in light, `dark` in dark). No API key is requested. | ☐ | |
| **SET-08** | Optional Carto basemap | `apps/web/.env.local` with `VITE_BASEMAP=carto` (+ key) | 1. Restart `npm run dev`; hard-refresh<br>2. Open Network | Carto tiles render. After the test, revert `.env.local`, and **never commit it**. | ☐ | |
| **SET-09** | Clean localStorage baseline | Browser DevTools | 1. Application → Local Storage → localhost:5180: delete the `flowform-*` keys<br>2. Reload | The projects index is recreated with one project, **NA Footprint 2027**. Chrome shows Active **Baseline** and Horizon **FY27**. | ☐ | |

## WF01 — Load sample and run

_Core happy path: built-in sample → MIP → new optimized scenario._

| ID | Test | Preconditions | Steps | Expected result | Pass/Fail | Notes |
|---|---|---|---|---|---|---|
| **RUN-01** | Default sample loaded | PRE-A | 1. Open Network<br>2. Check the Layers rail and the map | 8 sites: Austin Plant (n1), Columbus DC (n2), Atlanta DC (n3), Chicago Hub (n4), Dallas Metro (n5), NYC Corridor (n6), Monterrey Sup (n7, supplier), Reno DC (n8). 9 lanes (l1–l9; l9 = Columbus→NYC Truck $1.38, hazmat). | ☐ | |
| **RUN-02** | Run via API (MIP) | PRE-A | 1. Click **Run** in the top chrome<br>2. Watch the status line until it finishes | Progress shows `Checking optimize API…` → `API available — MIP via enterprise-data-v1 (score 100)…`. Final status: `API pulp-highs · Optimal · 0.00Xs · fixed-charge-multi-echelon-v1 · service 100.0% · obj $98.27M (tx $95.67M + CapEx $0.0M + OpEx $2.6M) · 3 SKUs/groups`. **(captured total 98.2706)** | ☐ | |
| **RUN-03** | New optimized scenario + KPIs | RUN-02 | 1. Check the Active chip and the KPI strip | Active = `Optimize MIP <time>`. KPIs: Cost **$98.3M (−0.7%)**, Service **100.0% (+0.0pp)**, CapEx **$0M**, CO₂ **5.5 kt (−0%)**, Risk **Low**. Deltas compare against the **computed Baseline** ($99.0M, 100.0%, ≈5.5 kt — the as-is network with Reno open), written onto the Baseline chip by the same Run. CO₂ is modelled transport CO₂ = tonne-miles × mode factor using per-SKU/group unit weights (sample: 5,494.6 t, 106.19M tonne-km, 51.7 g/tkm, avg 2.07 kg/unit). Was 2703.5 kt under the old 1 t/unit assumption. | ☐ | |
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
| **NET-13** | Max DCs = 2 | PRE-A | 1. Max facilities = 2<br>2. Run | Inspector label reads **Max DCs (open)** with help *Counts DCs + candidates only. Plants stay open and are not counted*. Set 2 → Run: Optimal **$98.27M** with n1 (plant) + n2 + n3 open (D-07 fixed). | ☐ | |
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
| **PRD-04** | Make Atlanta hazmat-capable | PRE-A | 1. Tick Hazmat for Atlanta<br>2. Run | Optimal **$98.16M** (captured 98.155 via API with Atlanta hazmat cap 14,000), ≤ $98.27M. | ☐ | |
| **PRD-05** | BOM defaults + implied RM | PRE-A | 1. Data → Bill of materials | FG mix **55 / 30 / 15**. 6 BOM rows from Monterrey Sup (n7) → Austin (n1). Implied RM (captured): Polymer resin **30,470**, Carton **15,235**, Chill base **12,465**, Insulated liner **8,310**, Drum/tote **4,155**, Specialty additive **1,662**. Total **72,297**. | ☐ | |
| **PRD-06** | BOM rollup in Compare | PRE-A | 1. Compare → BOM | 6 BOM rows, 6 components, implied lane gaps **0** (l1 covers n7→n1). | ☐ | |
| **PRD-07** | Draft inbound scenario with no gaps | PRE-A | 1. Data → BOM → **Draft inbound scenario** | Message *BOM inbound: all Plant←Supplier pairs already have lanes.* No scenario is created. | ☐ | |
| **PRD-08** | Draft inbound with a gap | PRE-A | 1. Add a BOM row whose supplier has no lane to Austin<br>2. Draft inbound scenario | `BOM inbound: added N supplier→plant lane(s).` A scenario named `BOM inbound (N lane[s])` is created. Log `apply_bom`. | ☐ | |
| **PRD-09** | Highlight BOM lanes | PRE-A | 1. Tick **Highlight BOM lanes on Network** → open Network | Lane l1 is highlighted. | ☐ | |
| **PRD-10** | Per-group capacity enforced for SKUs | PRE-A | 1. Set Columbus Hazmat cap = 1,000<br>2. Run | Optimal **$122.75M** (was $98.27M while the cap was ignored): Columbus ships ≤ 1,000 hazmat units, so NYC hazmat is partly unmet. The group cap now applies to the `sku-hazmat` commodity (fixed in a6d3fae). Restore the cap afterwards. | ☐ | |

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
| **LAN-09** | Lane capacity infeasible (sample) | PRE-E | 1. API: sample payload with l9 `capacityUnits: 1000` | `Infeasible`. Root causes `MIN_THROUGHPUT_CONFLICT` (*n2 min 10800 vs feasible 10200*) **and** `LANE_CAPACITY_CONFLICT`: *l9 (n2→n6) cap 1000 vs needed 2280 (short 1280)*, customers `[n6]` (D-03 fixed). | ☐ | |
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
| **DAT-08** | Unit weights (CO₂ basis) | PRE-A | 1. Data → Unit weights: read groups + project default<br>2. Set Ambient 2 → 4 kg; Run | Groups Ambient **2 kg**, Chilled **1.5**, Hazmat **3.5**; default 20 kg. After edit, CO₂ KPI rises; "Last Run" basis line updates. Restore 2. Invalid (≤0 / non-number) → `GROUP_WEIGHT_INVALID`; >1500 kg or <0.005 kg → `…_IMPLAUSIBLE`; SKU without weight → `SKU_WEIGHT_MISSING` (info). | ☐ | |
| **DAT-09** | CO₂ consistency | RUN-03 | 1. Compare KPI, Compare → CO₂ line, Brief, mode mix | All show **5.5 kt** (Compare: `CO₂ 5,495 t (5.5 kt) · avg 2.07 kg/unit`). | ☐ | |

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
| **SCN-08** | Robust: built-in shocks, Expected | PRE-A | 1. Untick **Use selected chips as shocks**<br>2. Objective **Expected cost** → Robust optimize | Captured: E[cost] **$101.14M**, worst **$122.19M**, EVPI gap **$0.00M**. First-stage opens **n1, n2, n3** (Reno closes, as in Run). Per scenario: Base (p 0.4, ×1.0) **$98.27M** (= Run objective), Soft (0.3, ×0.85) **$83.92M**, Surge (0.3, ×1.25) **$122.19M**. Panel shows the *Same model as Run* basis note. Log `robust_optimize`. | ☐ | |
| **SCN-09** | Robust: Minimax | SCN-08 | 1. Objective **Minimax (robust)** | Objective value **$122.19M** (= worst). | ☐ | |
| **SCN-10** | Robust: CVaR-lite | SCN-08 | 1. Objective **CVaR-lite**, α 0.3 | Objective value **$107.45M** (captured 107.454929). | ☐ | |
| **SCN-11** | Robust from Scenarios room | PRE-A | 1. Scenarios → Robust optimize card → Expected → run | Uses the 4 library scenarios at p 0.25 each (Baseline ×1, East Coast DC ×1, Nearshore MX ×1.1, Lean Lanes ×1.2). Card: `Last E[cost] $105.4M · 3 opens` (n1, n2, n3). | ☐ | |
| **SCN-12** | Robust export to Brief | SCN-08 | 1. **Export to Brief**, twice | `Exported to Decision Brief notes.` The notes hold a single `## Robust / stochastic optimize` section (replaced, not duplicated). | ☐ | |
| **SCN-13** | Robust on the Run basis (D-04) | SCN-08 | 1. Compare the robust opens with the Run result | Robust opens **n1, n2, n3** — Reno (n8) closes, same as Run. Base-scenario total **$98.27M** equals the Run objective, so robust and Run $ are comparable (D-04 fixed). | ☐ | |
| **SCN-14** | Comments | PRE-A | 1. Compare → Comments: add a comment<br>2. Reload | The comment persists after reload and can be deleted. | ☐ | |

## WF10 — Roadmap and Optimize timing

_CapEx events, cumulative KPIs, multi-period NPV, year slices._

| ID | Test | Preconditions | Steps | Expected result | Pass/Fail | Notes |
|---|---|---|---|---|---|---|
| **RMP-01** | Default roadmap | PRE-A | 1. Open Roadmap | Base FY26, 6 years (Y0–Y5). Events: Expand Columbus DC Y1 $4.5M +6; Open Kansas City DC Y2 $12M +10 (`roadmap-kc-dc`); Expand Reno DC Y3 $3.2M +4; Close Atlanta DC Y4 $1.5M −14; Expand Austin Plant Y5 $8M +8. | ☐ | |
| **RMP-02** | Cumulative table | RMP-01 | 1. Read the cumulative CapEx / capacity rows | Captured: Y0 $0 / cap 86 / 4 open; Y1 $4.5M / 92 / 4; Y2 **$16.5M** / 102 / 5; Y3 $19.7M / 106 / 5; Y4 $21.2M / 92 / 4 open + 1 closed; Y5 **$29.2M** / 100 / 4. | ☐ | |
| **RMP-03** | Optimize timing: choose | PRE-A | 1. Mode Choose timing, discount 10% → **Optimize timing** | **Optimal** on the **Run model basis** (captured, fresh PRE-A, ~0.02 s): NPV **$489.89M** (CapEx **$18.13M**, OpEx **$12.46M**, transport **$459.30M**); all 5 events move to **Y5**. Basis line reads `Basis: Run model …` and `Y0 $98.27M vs Run $98.27M — match`; per-year breakdown table shown. (Legacy aggregate basis was $119.79M.) | ☐ | |
| **RMP-04** | Optimize timing: force | PRE-A | 1. Mode Force timeline → Optimize timing | **Optimal NPV $496.32M** (CapEx $22.40M, OpEx $13.56M, transport $460.36M); events stay at Y1–Y5, KC opens Y2. Y0 = Run $98.2706M (Δ 0). (Legacy aggregate basis was $128.36M.) | ☐ | |
| **RMP-05** | Drop the KC open event | PRE-A | 1. Remove *Open Kansas City DC*<br>2. Choose timing → Optimize timing | Optimal (captured via API). NPV **$482.00M** (CapEx $10.68M, OpEx $12.02M, transport $459.30M). All 4 events move to **Y5**. Log `optimize_timing`. | ☐ | |
| **RMP-06** | No KC: force timeline | RMP-05 | 1. Force timeline → Optimize timing | Optimal **NPV $484.39M** (captured 484.3894). | ☐ | |
| **RMP-07** | Discount rate 0% | RMP-05 | 1. Discount 0% → Optimize timing | NPV changes (no discounting). Record it (exploratory). | ☐ | |
| **RMP-08** | Apply year slice | PRE-A | 1. Apply year slice: through **Y2** → Apply as scenario | `Roadmap Y2: 2 CapEx event(s) applied (cum $16.5M).` New Active scenario. Log `apply_roadmap`. | ☐ | |
| **RMP-09** | Export NPV to Brief | RMP-05 | 1. **Export NPV to Brief** | Brief notes gain `## CapEx multi-period optimize (NPV)`. Assumption a3 is unticked and relabeled *CapEx is overnight build — no phased construction (roadmap NPV in notes)*. | ☐ | |
| **RMP-10** | Roadmap stress-200 timing | STR-03 | 1. Stress-200 roadmap (5 periods, 3 events, 3% growth) → Optimize timing | 7,740 vars, default gap 2e-3: **~3 s**; force Y0 $176.85M vs Run $176.81M (+0.02%, match). Choose $892.38M / force $944.85M. (gap 1e-4: 8.5–11 s.) | ☐ | |
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
| **SEN-09** | Resilience | PRE-A | 1. Compare → Resilience, threshold 95 → **Score resilience** | Fresh Baseline: Score **35**, baseline service **100.0%** (lanes count as reachability). Critical (SPOF) only: **Austin Plant** (sole plant, −100.0pp, after 0.0%) and **Columbus DC** (−33.2pp, after 66.8%). Atlanta and Reno: −0.0pp, **not** critical (D-08 fixed). After a Run (Reno closed): score 23, same 2 critical. | ☐ | |

## WF12 — Infeasibility diagnostics

_Break the sample on purpose; check hints, chips, and UI behavior._

| ID | Test | Preconditions | Steps | Expected result | Pass/Fail | Notes |
|---|---|---|---|---|---|---|
| **INF-01** | Remove hazmat lane l9 | PRE-A | 1. Data → **Lanes** → **Delete** on `l9` (confirm), or select l9 on the map → Inspector → **Delete lane l9**<br>2. Run | Captured: **Infeasible**. First hint **MIN_THROUGHPUT_CONFLICT** — *Root cause: facility minimum throughput (capacityMin) cannot be met — with minimums relaxed the model solves (service 91.8%, $122.76M). n2 min 10800 vs feasible 9200.* `UNREACHABLE_DEMAND` (`n6/sku-hazmat`, vol 2280) is still listed as **info** context. The new scenario is named `Optimize Infeasible <time>`. (Lanes can now be deleted in Data → Lanes or the lane Inspector.) | ☐ | |
| **INF-02** | Diagnostics panel | INF-01 | 1. Compare → Matrix → Infeasibility diagnostics | Hint code, message, remediation text, and metrics (unreachable volume 2,280; openable capacity 107,500). | ☐ | |
| **INF-03** | Lower target still infeasible | INF-01 | 1. Service target 90 → Run | Still Infeasible with root cause **MIN_THROUGHPUT_CONFLICT** (captured) — the diagnosis now names `capacityMin` (D-02 fixed). | ☐ | |
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
| **STR-04** | Stress-200 decisions | STR-03 | 1. Compare objective breakdown | **9 open** (dc-1…dc-6, plt-1…plt-3). **Seattle DC (dc-7)** and **Miami DC (dc-8)** stay closed. Lane fixed **$0.53M**, unmet $0. KPI **$176.8M** (now includes lane fixed, D-06 fixed) vs computed Baseline $176.8M (**+0.0%**); CO₂ **51.0 kt** (50,996 t, 47.2 g/tkm, avg 3.4 kg/unit; was 11931.2 kt at 1 t/unit). At $100/t: carbon **$4.9239M**, CO₂ 49.2 kt, total **$181.7678M**. | ☐ | |
| **STR-05** | Stress-200 explain | STR-03 | 1. Inspector on Dallas DC and Seattle DC; Compare Why-this-network | Headline *The MIP kept 9 existing site(s) open. Costliest flip: closing Ontario Plant strands 37.5M units (service 81.0%).* Dallas DC: *Capacity binding (100% utilized): each extra unit of capacity saves $0.065/unit*. Seattle DC: *Opening it raises cost by $6.6M (3.8%); service holds at 100.0%*. | ☐ | |
| **STR-06** | CTS on stress-200 | STR-03 | 1. Compare → Cost-to-serve | Customer rows render with a service DC. Record the render time. | ☐ | |
| **STR-07** | Stress-120 | PRE-A | 1. Load stress-120 → Run | Optimal **$89.12M** (tx $81.00M, OpEx $7.8M, lane fixed $0.32M), 9 open, 100%. `modes Truck 59%/Rail 36%/Intermodal 4% · 3 binding lane cap(s)` (ln-10, ln-20, ln-22). Solve 0.07–0.16 s. KPI **$89.1M (+0.0%)** vs computed Baseline $89.1M; CO₂ **32.0 kt** (was 7533.1 kt at 1 t/unit). Scorecard: 132 sites, 240 demand rows, 265 lanes, score 100. | ☐ | |
| **STR-08** | pytest benchmark | SET-02 | 1. cd apps/api && pytest -q tests/test_stress_benchmark.py -s | Prints stress-120 objective **89.1312**, stress-200 objective **176.8118**, open=9, Optimal. **3 passed**. | ☐ | |
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
| **LOG-04** | All 13 action types | PRE-A | 1. Trigger each: create_scenario, activate_scenario, run_optimize, apply_hub, apply_territory, apply_roadmap, optimize_timing, robust_optimize, apply_bom, apply_bids, apply_sensitivity, handoff_export, share | Each appears at least once. `optimize_timing` comes from RMP-03 (D-01 fixed). `apply_bom` needs PRD-08. | ☐ | |
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
| **API-04** | No l9 → infeasible | API-01 | 1. python3 -c "import json; p=json.load(open('/tmp/ff-sample.json')); p['network']['lanes']=[l for l in p['network']['lanes'] if l['id']!='l9']; json.dump(p, open('/tmp/ff-nol9.json','w'))"<br>2. curl -s -X POST localhost:5182/optimize -H 'content-type: application/json' -d @/tmp/ff-nol9.json \| python3 -c "import json,sys; r=json.load(sys.stdin); h=r['infeasibilityReport']['hints'][0]; print(r['status'], h['code'], h['entities'])" | `Infeasible MIN_THROUGHPUT_CONFLICT ['n2']` (then `UNREACHABLE_DEMAND ['n6/sku-hazmat']` as info). | ☐ | |
| **API-05** | Stress-200 timing | PRE-E | 1. python3 -c "import json,time,urllib.request as u; from tests.enterprise_payload import load_enterprise_pack as L, pack_to_optimize_payload as P; p=P(L('stress-200-demand.enterprise.json')); t=time.time(); r=json.load(u.urlopen(u.Request('http://127.0.0.1:5182/optimize', json.dumps(p).encode(), {'content-type':'application/json'}))); print(r['status'], r['objectiveBreakdown']['totalM'], len(r['openIds']), r['solveSeconds'], round(time.time()-t,2))" | `Optimal 176.8118 9 <0.85–1.35> <wall s>`. | ☐ | |
| **API-06** | Multi-period replay | PRE-A + DevTools | 1. Roadmap → Optimize timing; DevTools → Network → right-click `/optimize/multi-period` → Copy as cURL; replay it in the terminal | `ok true`, `status Optimal`, `model multi-period-run-basis-v2`, `basis.model run`, `npv.totalM 489.8862` — log *Facility roadmap-kc-dc has an open event — closed until the event year.* `runCheck.matches true`. Force timeline: `496.3199`. Add `"basis":"legacy-aggregate"` to the roadmap for the old model (119.79). | ☐ | |
| **API-07** | Stochastic replay | PRE-A + DevTools | 1. Run SCN-08; Copy as cURL for `/optimize/stochastic`; replay it | `modelBasis full`, `expectedCostM 101.14067`, `worstCostM 122.1882`, `firstStage.openIds [n1,n2,n3]`, `evpi.evpiGapM 0.0`. Minimax → `objectiveValueM 122.1882`; cvar_lite → `107.454929`. | ☐ | |
| **API-08** | 422 schema error | PRE-E | 1. curl -s -w ' %{http_code}' -X POST localhost:5182/optimize -H 'content-type: application/json' -d '{"network":{}}' | HTTP **422**, `loc [body, constraints]`, `Field required`. | ☐ | |
| **API-09** | 400 empty network | PRE-E | 1. curl -s -w ' %{http_code}' -X POST localhost:5182/optimize -H 'content-type: application/json' -d '{"network":{"nodes":[],"lanes":[]},"constraints":{}}' | HTTP **400** `No facility nodes (dc/plant/candidate) in network.` | ☐ | |
| **API-10** | 400 multi-period without demand | PRE-E | 1. curl -s -w ' %{http_code}' -X POST localhost:5182/optimize/multi-period -H 'content-type: application/json' -d '{"network":{"nodes":[],"lanes":[]},"constraints":{},"roadmap":{"events":[]}}' | HTTP **400** `No demand nodes in network.` | ☐ | |
| **API-11** | 400 stochastic with 1 scenario | API-07 | 1. Edit the replayed body down to 1 scenario | HTTP **400** `Need 2–5 scenarios, got 1.` | ☐ | |
| **API-12** | Cost knobs | API-01 | 1. Add `offLanePremium: 1.5` and `uncoveredPenaltyPerUnit: 40` to `constraints`; POST | `costScale.offLanePremium 1.5`, `uncoveredPenaltyPerUnit 40`. | ☐ | |
| **API-13** | CORS allows 5180 (not 5173) | SET-02 | 1. curl -s -i -X OPTIONS localhost:5182/optimize -H 'Origin: http://localhost:5180' -H 'Access-Control-Request-Method: POST'<br>2. Repeat with Origin http://localhost:5173 | 5180 → `access-control-allow-origin: http://localhost:5180` (5181 is also allowed). 5173 → HTTP 400 with no allow-origin header. | ☐ | |
| **API-14** | Carbon price | API-01 | 1. Add `carbonPricePerTonne: 100`; POST | `objectiveBreakdown.carbonM 0.5495`, total **98.8201**, `kpis.transportCo2Tonnes 5494.6` → 100 × 5,494.6 t / 1e6 = **$0.5495M** (same tonnes as the CO₂ KPI). `co2Basis` block lists weights. `constraints.co2WeightBasis: "legacy-1t"` restores 2703.5 kt. | ☐ | |
| **API-15** | Cheap guardrails (no solve) | API-01 | 1. curl -s -X POST localhost:5182/optimize/validate -H 'content-type: application/json' -d @/tmp/ff-sample.json \| python3 -c "import json,sys; v=json.load(sys.stdin); print(v['ok'], v['blocking'], v['errorCount'], 'status' in v)" | `True False 0 False` — the cheap path reports issues and never solves, so there is no `status`/`solveSeconds`. | ☐ | |
| **API-16** | Deep guardrails name the root cause | API-04 | 1. curl -s -X POST 'localhost:5182/optimize/validate?deep=true' -H 'content-type: application/json' -d @/tmp/ff-nol9.json \| python3 -c "import json,sys; v=json.load(sys.stdin); print(v['blocking'], [i['code'] for i in v['issues'] if i['level']=='error'], [r['facilityId'] for r in v['shortfalls']['minThroughput']])" | `True ['MIN_THROUGHPUT_CONFLICT'] ['n2']` — deep validation solves once and turns the engine root cause into a blocking issue with the shortfall table. | ☐ | |
| **API-17** | Oversized payload → 400, not 500 | API-01 | 1. python3 -c "import json; p=json.load(open('/tmp/ff-sample.json')); p['constraints']['maxNetworkNodes']=1; json.dump(p, open('/tmp/ff-big.json','w'))"<br>2. curl -s -w ' %{http_code}' -X POST localhost:5182/optimize -H 'content-type: application/json' -d @/tmp/ff-big.json | HTTP **400**, `Network nodes (8) exceeds the limit of 1. Split the study into regions, or raise constraints.maxNetworkNodes.` Repeat with `maxNetworkLanes: 3` → `Network lanes (9) exceeds the limit of 3.` | ☐ | |
| **API-18** | Time-limit and capacity-zero semantics (unit) | SET-02 | 1. pytest -q tests/test_guards.py -k "time_limit or zero_capacity" | Pass. `test_time_limit_defaults_clamps_and_ignores_garbage` (default 120, clamp 1–600, NaN ignored), `test_time_limit_is_actually_passed_to_the_solver`, `test_time_limited_solve_raises_instead_of_reporting_a_fake_optimum` (no zero-cost "Optimal"), `test_explicit_zero_capacity_is_not_treated_as_unlimited`. | ☐ | |
| **API-19** | 429 when the worker is saturated | SET-02 | 1. Restart API with `MAX_CONCURRENT_SOLVES=1 SOLVE_QUEUE_WAIT_S=0`<br>2. Fire two stress-200 POSTs in parallel (`&` … `wait`), print `-w '%{http_code}'` | Exactly one **200** and one **429** with `Retry-After: 2` and `Too many concurrent solves on this worker; retry shortly.` The successful response is still Optimal `$176.8118M`. | ☐ | |
| **API-20** | Project create + ETag | DB + `AUTH_MODE=dev` | 1. POST `/v1/projects` with headers `X-Dev-Tenant: 00000000-0000-0000-0000-00000000d001`, `X-Dev-User: qa@flowform.local`, body `{"meta":{"name":"QA project"}}`<br>2. PUT `/v1/projects/{id}` with `If-Match: "1"` and `{"meta":{"name":"QA v2"}}` | Create → **201** with `id`, `version 1`. PUT → **200**, `version 2`, response header `ETag: "2"`. `GET /v1/projects/{id}` reports version 2. | ☐ | |
| **API-21** | Stale `If-Match` → 409 + ETag | API-20 | 1. Repeat the PUT with `If-Match: "1"` | HTTP **409**, detail `project changed since version 1 (now 2). Reload the project and re-apply your changes.`, header `ETag: "2"`. No new version row is written. | ☐ | |
| **API-22** | Two concurrent writers cannot both bump | API-20 | 1. Run two PUTs in parallel, both `If-Match: "2"`<br>2. Print status codes and final `version` | Statuses `{200, 409}` (one winner), final version **3**; the losing body is not stored. The CAS is `UPDATE … WHERE current_version = :base`, not read-modify-write. | ☐ | |
| **API-23** | Pack parity fixture is generated, not hand-written | SET-06 | 1. cd apps/web && npm run gen:pack-parity<br>2. cd ../api && pytest -q tests/test_pack_validation_parity.py | 16 parity tests pass. The fixture (`apps/web/src/data/packParity.fixture.json`) is produced by the TypeScript validator itself; the three historical divergences (id `1` vs `true`, `sites: "nope"`, string demand concatenation) are covered. | ☐ | |
| **API-24** | SSE ends cleanly on success | DB + queued run | 1. Start a run (`POST /v1/projects/{id}/runs`)<br>2. curl -N `…/runs/{rid}/events` | Frames are `event: status` (queued/running/succeeded, with progress) then `event: done`; the request ends. No hang after the terminal status. | ☐ | |
| **API-25** | SSE deadline, not an infinite stream | DB + `QUEUE_BACKEND=manual RUN_EVENTS_MAX_S=30` | 1. Create a run with `manual` (it never executes)<br>2. curl -N --max-time 40 `…/runs/{rid}/events` | After ~30 s: `event: timeout` with `{"reason":"stream deadline reached; poll the run for its status","maxSeconds":30}`, then the request ends. Delete the run mid-stream instead → `event: gone`. (The clamp floor is 30 s, so this is the shortest manual check.) | ☐ | |

## WF20 — Platform: workspace, jobs, auth, guardrails

_The server layer added in FF-104…FF-110 and the hardening pass. Most cases need Postgres; a few need Redis. Skip the whole workflow when testing browser-only._

| ID | Test | Preconditions | Steps | Expected result | Pass/Fail | Notes |
|---|---|---|---|---|---|---|
| **PLT-01** | Migrations are clean | Docker available | 1. cd "$(git rev-parse --show-toplevel)" && docker compose up -d db redis<br>2. export DATABASE_URL=postgresql+psycopg://flowform:flowform@127.0.0.1:5433/flowform<br>3. cd apps/api && source .venv/bin/activate && alembic upgrade head && alembic check | `alembic upgrade head` reaches **0002**; `alembic check` reports **No new upgrade operations detected**. PostGIS extension is available. | ☐ | |
| **PLT-02** | Workspace banner online | PLT-01; API `AUTH_MODE=dev`; web `VITE_DEV_TENANT` + `VITE_DEV_USER` | 1. Open Projects | Banner reads **Saved to your workspace.** No warning styling. The project list loads from both local and server state. | ☐ | |
| **PLT-03** | Offline fallback keeps working | PLT-02 | 1. Stop the API<br>2. Rename a project or draw a node<br>3. Reload the page | Banner reads **Workspace unreachable — saving in this browser; changes sync when it is back.** The edit survives the reload. No blocking dialog, no data loss. | ☐ | |
| **PLT-04** | Queued write drains when the API returns | PLT-03 | 1. Restart the API<br>2. Wait for the debounce (~1.5 s) + a poll<br>3. Check the banner and `localStorage['flowform-sync-pending']` | Banner returns to **Saved to your workspace.** The pending entry clears. The server project version increments once (no duplicate writes). | ☐ | |
| **PLT-05** | Move local projects to the workspace | Fresh tenant; 2 local-only projects | 1. Projects → **Move my 2 local project(s) to my workspace** | Message **Moved 2 project(s) to your workspace** (plus `; added N from it` when the server had others). `GET /v1/projects` lists both; `flowform-server-links` maps both local ids. | ☐ | |
| **PLT-06** | Local-only mode is truly local | `VITE_PROJECT_STORE=local`, restart dev server | 1. Reload Projects<br>2. DevTools → Network, filter ` /v1 ` | No banner (sync disabled). **No `/v1` requests** are made on save, open or create. The studio behaves exactly as browser-only. | ☐ | |
| **PLT-07** | Snapshot history is versioned | PLT-02; a project saved twice | 1. `GET /v1/projects/{id}` → note `version`<br>2. `GET /v1/projects/{id}/snapshot?version=1`<br>3. `GET …/snapshot` (current) | Metadata reports the latest version. Version 1 returns the **original** bytes (`X-Project-Version: 1`); the current snapshot returns the newest bytes. Versions are stored verbatim, not re-serialised. | ☐ | |
| **PLT-08** | Legacy save and update ordering | PLT-02 | 1. PUT without `If-Match`<br>2. PUT again<br>3. `GET /v1/projects` | Both saves succeed (legacy last-write-wins). `version` increments each time and **`updatedAt` advances**; the list is ordered newest first (this was frozen at creation before D-12). | ☐ | |
| **PLT-09** | Job result equals sync result | PLT-02; sample project linked | 1. Run once with the job API (default `VITE_RUN_MODE=jobs`)<br>2. Set `VITE_RUN_MODE=sync` and run again<br>3. Compare objective breakdowns | Both report `Optimal`, `totalM 98.2706`, `closedIds ["n8"]`, service 100.0. The job `Run` row stores the same input hash and engine/solver versions. | ☐ | |
| **PLT-10** | Cancel a queued/running job | PLT-02; a slow solve (stress-200) | 1. Start Run on stress-200<br>2. Click **Cancel** on the job chip<br>3. `GET …/runs/{rid}` after it settles | Run status becomes **cancelled**, message `Cancelled by user`, no `result`. A late worker result does **not** overwrite it. The chip disappears; the UI does not create a scenario. | ☐ | |
| **PLT-11** | Viewer is read-only | PLT-02 | 1. Send `X-Dev-Role: viewer` on a POST/PUT/DELETE and on GETs | GETs → 200. Writes → **403** `requires role editor (you are viewer)` (delete requires admin). RBAC is enforced per route, not just in the UI. | ☐ | |
| **PLT-12** | Editor vs admin | PLT-02 | 1. `X-Dev-Role: editor` → create/update project, create run, delete project<br>2. `X-Dev-Role: admin` → delete | Editor: create/update/run **allowed**, delete **403**. Admin: delete **204**, then GET → **404**. | ☐ | |
| **PLT-13** | Tenant isolation, proven by Postgres | PLT-01 | 1. Create a project under tenant A<br>2. List/get it as tenant B<br>3. `pytest -q tests/test_auth_rbac.py` with `DATABASE_URL` set | Tenant B's list is empty and a direct GET by id is **404**. The RLS tests query **without** a tenant filter as `flowform_app` and still see zero rows of A (FORCE RLS + `app.tenant_id`). | ☐ | |
| **PLT-14** | Auth modes fail closed | PLT-01 | 1. `AUTH_MODE=off` → `GET /v1/projects`<br>2. `AUTH_MODE=workos` without keys → `GET /v1/auth/me` with any Bearer<br>3. `GET /v1/auth/config` | (1) **401** `authentication required`. (2) **401** `invalid token: no verification key configured` (inert, never open). (3) **200**, public, reports `mode` and `workosEnabled: false`. | ☐ | |
| **PLT-15** | Guardrails block Run in the UI | PRE-A | 1. Select Columbus DC<br>2. Set capacity min **30000**, max **1000**<br>3. Click **Run** | Status reads `Run blocked — n2 minimum throughput 30,000 exceeds its capacity 1,000. Fix: Lower capacityMin or raise capacityMax.` **No scenario is created**, no solve starts. Restore min 10,800 / max 22,500 afterwards. | ☐ | |
| **PLT-16** | Onboarding end-to-end | PRE-A | 1. Projects → **Start with 4 questions** → **Fill with an example**<br>2. Next through Review → **Build model & Run** | Assumptions are labelled *assumed*; the Run completes; the result card shows status, total cost, service %, opens and closes, plus the plain-language narrative. **See the full comparison** lands on Compare. | ☐ | |
| **PLT-17** | Audit trail is written | PLT-02 | 1. Create, update and delete a project; start and cancel a run<br>2. Query `audit_events` for the tenant | Rows for `project.create`, `project.update`, `project.delete`, `run.create`, `run.cancel` with actor, target and timestamp. This is the server-side trail; the browser decision log is separate. | ☐ | |

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
| **REG-07** | Robust built-in shocks: E $101.14M / worst $122.19M | SCN-08 | ☐ | |
| **REG-08** | Roadmap Optimize timing Optimal (Run basis): choose $489.89M / force $496.32M; Y0 = Run $98.27M | RMP-03 | ☐ | |
| **REG-09** | Heuristic fallback when the API is down (58.8%) | RUN-09 | ☐ | |
| **REG-10** | Sensitivity P10/P50/P90 44.34 / 48.29 / 51.92 | SEN-01 | ☐ | |
| **REG-11** | DES-lite fill 98% / late 2% | SEN-05 | ☐ | |
| **REG-12** | Brief MD/HTML + Handoff JSON/MD downloads; counts 8/9/5/3/5 | BRF-04, HND-02 | ☐ | |
| **REG-13** | Merge sample: 14/14, 2 conflicts | MRG-01, MRG-02 | ☐ | |
| **REG-14** | Theme persists; ? and Esc behave; web on port 5180 | UX-01..05, SET-04 | ☐ | |
| **REG-15** | pytest **133 passed / 4 skipped** (the 4 Postgres modules run when `DATABASE_URL` is set); 8 data suites + typecheck + lint + build green | SET-05, SET-06 | ☐ | |
| **REG-16** | OpenFreeMap default basemap, no key | SET-07 | ☐ | |
| **REG-17** | Guardrails: oversized → 400, worker full → 429, time limit → 503 (unit), capacity `0` → zero | API-17…API-19, API-18 | ☐ | |
| **REG-18** | Project version CAS: stale `If-Match` → 409 + ETag; two writers → one winner | API-20…API-22, PLT-07/08 | ☐ | |
| **REG-19** | Pack parity fixture regenerates and 16 parity tests pass | API-23 | ☐ | |
| **REG-20** | Workspace: online banner, offline queue, drain, job cancel, viewer 403, tenant isolation | PLT-02…PLT-13 | ☐ | |

## Defect log

Template: copy a row per defect. Severity is High (blocks a workflow), Medium (wrong result with a workaround), or Low (cosmetic or diagnostic). The pre-filled rows are the defects found while capturing the expected values (details in blueprint §11); D-01…D-08 are fixed in `a6d3fae`, D-09…D-16 in the **uncommitted hardening pass** (Actual column = verified post-fix result).

| Defect ID | Date | Tester | Test ID | Severity | Summary | Steps to reproduce | Expected | Actual | Build | Status | Owner |
|---|---|---|---|---|---|---|---|---|---|---|---|
| D-01 | 2026-10-17 | capture | RMP-03 / API-06 | High | Roadmap Optimize timing is Infeasible on the default roadmap: the materialized KC open-event node is treated as already open | see RMP-03 | see test | Fixed a6d3fae — sites with an open event start closed; default roadmap Optimal (choose $119.79M / force $128.36M) | 1b2afc2 → a6d3fae | Fixed | |
| D-02 | 2026-10-17 | capture | INF-03 / INF-04 | Medium | No-l9 is diagnosed as UNREACHABLE_DEMAND; the real blocker is facility capacityMin | see INF-03 | see test | Fixed a6d3fae — relaxation probe reports MIN_THROUGHPUT_CONFLICT (n2 10800 vs 9200; relaxed 91.8%, $122.76M) | 1b2afc2 → a6d3fae | Fixed | |
| D-03 | 2026-10-17 | capture | LAN-09 | Low | Lane-capacity infeasibility returns no hints | see LAN-09 | see test | Fixed a6d3fae — LANE_CAPACITY_CONFLICT: l9 cap 1000 vs 2280 (short 1280) + min-throughput | 1b2afc2 → a6d3fae | Fixed | |
| D-04 | 2026-10-17 | capture | SCN-13 | Medium | Robust forces existing sites open; robust $ omit BOM/SKUs | see SCN-13 | see test | Fixed a6d3fae — robust on the full Run model; opens n1,n2,n3; E $101.14M / worst $122.19M; base = Run $98.27M | 1b2afc2 → a6d3fae | Fixed | |
| D-05 | 2026-10-17 | capture | API-14 | Medium | Carbon-price magnitude is inconsistent with the reported CO₂ | see API-14 | see test | Fixed a6d3fae — CO₂ per physical unit; carbonM 197.3422 = 100 × 1,973,422 t | 1b2afc2 → a6d3fae | Fixed | |
| D-06 | 2026-10-17 | capture | STR-04 | Low | kpis.costM excludes lane fixed charges | see STR-04 | see test | Fixed a6d3fae — costM includes lane fixed (stress-200 $176.8M) | 1b2afc2 → a6d3fae | Fixed | |
| D-07 | 2026-10-17 | capture | NET-13 | Low | maxFacilities excludes plants (undocumented) | see NET-13 | see test | Fixed a6d3fae — maxFacilities = Max DCs (plants not counted), optional maxPlants; UI labelled | 1b2afc2 → a6d3fae | Fixed | |
| D-08 | 2026-10-17 | capture | SEN-09 | Low | Resilience flags every facility critical on Baseline (58.8% < 95%) | see SEN-09 | see test | Fixed a6d3fae — SPOF needs a real drop; Baseline critical = Austin Plant, Columbus DC (score 35) | 1b2afc2 → a6d3fae | Fixed | |
| D-09 | 2026-10-23 | hardening | API-17/19 | High | `/optimize` had no payload caps and no time limit on HiGHS; infeasible requests multiplied solves via probes | API-17, API-19 | 400/429/503, never an unbounded solve | Fixed — `limits.py` caps + 120 s (1–600) + 2 solve slots → 429 | 8e2d909 + working tree | Fixed (uncommitted) | |
| D-10 | 2026-10-23 | hardening | API-18 | High | Explicit `capacityMax: 0` treated as unlimited | API-18 | Zero capacity serves nothing | Fixed — missing ≠ zero in `solver.py` | 8e2d909 + working tree | Fixed (uncommitted) | |
| D-11 | 2026-10-23 | hardening | API-18 | High | A time-limited solve returned a complete-looking $0 network | API-18 | Refuse, do not report a fake optimum | Fixed — non-optimal stop raises → **503** | 8e2d909 + working tree | Fixed (uncommitted) | |
| D-12 | 2026-10-23 | hardening | API-20/21/22, PLT-07/08 | High | Project version bump was read-modify-write; `updated_at` never advanced | API-22 | One winner, 409 on a stale base, updated ordering | Fixed — CAS + `If-Match`/`ETag` + `updated_at = now()` (race `[0,1]`, one winner) | 8e2d909 + working tree | Fixed (uncommitted) | |
| D-13 | 2026-10-23 | hardening | API-24/25 | Medium | SSE stream had no deadline/heartbeat and raised when a run disappeared | API-25 | `done` / `timeout` / `gone`, never an infinite stream | Fixed — 900 s deadline, 15 s keep-alive, clean `gone` | 8e2d909 + working tree | Fixed (uncommitted) | |
| D-14 | 2026-10-23 | hardening | — | Medium | Unexpected errors leaked internals; `/optimize/validate` 500'd on a bad body | API-15 | 400/422/503/500 with no internals | Fixed — shared error mapping; cheap validate returns issues | 8e2d909 + working tree | Fixed (uncommitted) | |
| D-15 | 2026-10-23 | hardening | API-23 | Medium | `pack_validation.py` claimed a parity test that did not exist; validators had drifted | API-23 | Generated fixture + passing parity | Fixed — 16 parity tests; three divergences corrected in both languages | 8e2d909 + working tree | Fixed (uncommitted) | |
| D-16 | 2026-10-23 | hardening | SET-06 | Low | Nine scripts used `npx --yes tsx` (unpinned network fetch on every CI run) | SET-06 | Reproducible toolchain | Fixed — `tsx` pinned devDependency | 8e2d909 + working tree | Fixed (uncommitted) | |
| D-__ | | | | | | | | | | | |

## Sign-off

| Role | Name | Date | Result |
|---|---|---|---|
| Tester | | | Pass / Fail with defects |
| Product owner | | | |
