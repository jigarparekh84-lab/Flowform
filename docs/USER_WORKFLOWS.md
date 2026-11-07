# Flowform — User Workflows

**What this is.** Every way to use Flowform, organised by the job you are trying to do. Each workflow says where to go, what to click, what you get, and what to watch out for. It is the **usage** companion to [`MASTER_BLUEPRINT.md`](MASTER_BLUEPRINT.md) (how it is built) and [`MANUAL_TEST_WORKBOOK.md`](MANUAL_TEST_WORKBOOK.md) (how to verify it).

**Who it is for.** Network designers, ops/IBP reviewers, finance partners, data engineers, M&A analysts, and anyone evaluating Flowform for the first time. No optimisation background is assumed for the first six workflows.

**One sentence to hold on to.** Flowform answers *what network should we have* — which plants, DCs and lanes to run, at what capacity, in which year — and hands the answer to planning. It does not schedule orders; that is Ritara/APS.

---

## Find your workflow

| I want to… | Start at |
|---|---|
| See the product work in two minutes | [W01](#w01--first-run-from-the-built-in-sample) |
| Build a model from four plain answers | [W02](#w02--build-a-model-from-four-questions-onboarding) |
| Open a study someone sent me | [W03](#w03--open-an-existing-project-file) · [W04](#w04--import-an-enterprise-data-pack) |
| Bring my own sites, demand and lanes | [W05](#w05--import-csvs-sites-demand-lanes) · [W35](#w35--work-with-the-enterprise-data-model) |
| Draw or change the network | [W07](#w07--navigate-and-filter-the-map) – [W11](#w11--set-the-network-constraints) |
| Run the optimiser and understand the answer | [W16](#w16--run-the-optimiser-and-read-the-status) – [W20](#w20--diagnose-an-infeasible-run) |
| Test "what if fuel/demand/a DC goes away?" | [W22](#w22--create-a-what-if-from-a-preset) · [W26](#w26--sensitivity-tornado--monte-carlo) |
| Compare two futures side by side | [W24](#w24--compare-scenarios) |
| Phase investment over years | [W31](#w31--build-a-capex-roadmap) · [W32](#w32--optimise-investment-timing-npv) |
| Plan under uncertainty | [W33](#w33--robust--scenario-tree-optimisation) |
| Decide where a new DC should go | [W12](#w12--greenfield-candidate-design) |
| Convert to hub-and-spoke | [W13](#w13--design-a-hub-and-spoke-network) |
| Assign customers to DCs | [W14](#w14--design-service-territory) |
| Merge an acquisition | [W15](#w15--merge-an-acquired-network) |
| Write the recommendation / hand it off | [W43](#w43--write-the-decision-brief) · [W44](#w44--produce-the-handoff-package) |
| Keep my work on a server / work with a team | [W46](#w46--save-to-a-workspace-and-work-offline) · [W48](#w48--sign-in-and-roles) |
| Call the API directly | [W50](#w50--call-the-solve-api-with-curl) – [W53](#w53--handle-limits-and-errors) |

---

## Before you start

### The two ways to run Flowform

| | **Browser-only** | **Workspace** |
|---|---|---|
| What you need | a browser; optionally the API for real MIP solves | + Postgres and, optionally, Redis |
| Projects live in | `localStorage` in one browser | `localStorage` **and** mirrored to `/v1/projects` |
| Sharing | export/import `.flowform.json` | server projects + RBAC; WorkOS is API-side (no web sign-in UI yet) |
| Optimiser | API MIP when reachable, otherwise the client heuristic | same |
| Good for | a demo, a solo study, an air-gapped laptop | a durable record across machines and roles |

The UI is identical. Sync can be turned off with `VITE_PROJECT_STORE=local`; see [W46](#w46--save-to-a-workspace-and-work-offline).

### Ports and URLs

| Surface | URL |
|---|---|
| Web studio | `http://localhost:5180` (preview build on 5181) |
| Solve API | `http://127.0.0.1:5182` · `/health` |
| Workspace API | same host, `/v1/…` |
| Postgres / PostGIS | `127.0.0.1:5433` |
| Redis (arq queue) | `127.0.0.1:6380` |

5180/5182 are deliberate; 5173 belongs to Ritara and Vite is configured with `strictPort` so it will fail rather than drift onto another port.

### The units, once

- **All money is $M** (millions).
- **Lane cost is $ per physical unit.** One model volume unit = **1,000 physical units**, so demand `9200` means 9.2M units.
- **CO₂** is tonne-distance × a mode factor (kg/tonne-mile). It is not a guess about load factor or backhaul.
- **Unmet demand** is penalised (default max($15, 10 × median lane $/unit)) and reported separately, so "cheap" never means "didn't serve the customer".

### The three questions every run answers

1. **Which facilities are open?** DCs and candidates are decidable; plants too when `optimizePlants` is on.
2. **How does product flow?** Supplier → plant (BOM) → DC → customer, per product, within radius or on an explicit lane.
3. **What does it cost?** Transport + CapEx + OpEx + lane fixed charges + carbon + any unmet penalty, in $M, with capacity and lane duals.

---

# Part A — Getting started

## W01 · First run from the built-in sample

**Goal.** See a real MIP result in under two minutes and learn what the status line means.

**Where.** The app opens on **Network** with the **NA Footprint 2027** project.

**Steps.**
1. Check the map: 8 sites (Austin Plant, Columbus DC, Atlanta DC, Chicago/Dallas/NYC demand, Monterrey supplier, Reno DC) and 9 lanes.
2. Click **Run** in the top chrome.
3. Wait for the status line to settle. You should see `API pulp-highs · Optimal · … · fixed-charge-multi-echelon-v1 · service 100.0% · obj $98.27M (tx $95.67M + CapEx $0.0M + OpEx $2.6M)`.
4. Look at the Active chip: a new scenario **Optimize MIP &lt;time&gt;** is selected.
5. Select **Reno DC** on the map and read **Why this site?** in the Inspector.

**You get.** Reno is **closed** (no customers in range; opening it costs +$700k); Austin, Columbus and Atlanta stay open; service is 100%; CO₂ ≈ 5.5 kt. The Baseline chip is rewritten with the *as-is* cost ($99.0M), so the −0.7% delta is real rather than a seed number.

**Watch out.** If the API is down, Run silently becomes the client **heuristic v1** (service ~58.8%) and the status says so. That is a fallback, not a MIP result — start the API before drawing conclusions. If the run is blocked before solving, see [W19](#w19--read-the-pre-run-guardrails).

---

## W02 · Build a model from four questions (onboarding)

**Goal.** Go from nothing to a first optimal result without knowing the data model.

**Where.** **Projects → Start with 4 questions** (also offered from the empty state).

**Steps.**
1. **What you sell** — one product family per line, optionally `, kg per unit` (e.g. `Ambient goods, 8`). **Fill with an example** loads a worked set.
2. **Where customers are** — one per line: ZIP, `City, ST`, or `lat, lng`, then an optional yearly volume (`10001, 4000`). The counter shows how many were recognised.
3. **Where your sites are** — location, then optional `existing` / `candidate` / `plant`, then capacity (`Columbus, OH, existing, 12000`).
4. **Your question** — one of: *Which of my sites should stay open?*, *Where should I add a new site?*, *Can I serve everyone with one fewer site?*
5. **Review** — every assumption Flowform filled in is listed and labelled *assumed*; skipped lines are shown.
6. **Build model & Run**.

**You get.** A new project with an `enterprise-data-v1` network, guardrails run automatically, a first MIP result, and a plain-language **In plain words** card. **See the full comparison** jumps to Compare.

**Watch out.** Locations resolve **offline**: a metro from the built-in table, a ZIP by prefix, or an explicit coordinate. A ZIP outside the table is placed approximately and flagged. The starter capacities and costs are labelled assumptions — refine them in **Data** before using the result for a decision.

---

## W03 · Open an existing project file

**Goal.** Continue someone else's study, or restore an export.

**Where.** **Projects → Import JSON**.

**Steps.**
1. Choose a `*.flowform.json` (the export format is `flowform-project` v1).
2. Flowform imports it and switches to it.

**You get.** Full state: scenarios, network, constraints, brief, handoff payload, decision log, product mix, lane rates, BOM, roadmap, inventory policies, theme.

**Watch out.** Import runs in the browser; a malformed file is rejected with a message rather than partially applied. A project imported while workspace sync is on is queued for upload ([W46](#w46--save-to-a-workspace-and-work-offline)).

---

## W04 · Import an enterprise data pack

**Goal.** Load a complete network definition in one file — the canonical data path into the MIP.

**Where.** **Data → Enterprise data model → Import pack JSON**, or **Projects → Import JSON** for a project file.

**Steps.**
1. Choose an `enterprise-data-v1` pack (sites, SKUs, product groups, demand by SKU × customer, lanes, BOM, cost factors).
2. Read the **Validation scorecard** before doing anything else.
3. If errors are present, import is blocked; fix the rows and re-import. Warnings load.

**You get.** A scored pack (0–100), counts for sites/demand/lanes/SKUs/BOM, geocode coverage, and a fixable issue list. Import is blocked on errors because an error means the model would not mean what you think it means.

**Watch out.** The score is `100 − 12·errors − 3·warns − (100 − geocode%)/4 − 15 if BOM cycle`. A high score with a bad assumption is still a bad assumption; §4.1 of the blueprint lists every validation code.

---

## W05 · Import CSVs (sites, demand, lanes)

**Goal.** Start from the spreadsheet you already have.

**Where.** **Data → Uploads**.

**Steps.**
1. Download the **Sites**, **Demand** or **Lanes** template.
2. Fill it in and upload.
3. **Load into Network**.
4. Fix anything the validation panel reports; then **Run**.

**You get.** A normal network in the studio, indistinguishable from one drawn by hand.

**Watch out.** CSV import is deliberately simple (one row per site/demand/lane). For multi-mode lanes, BOM or product capability, use the enterprise pack — the template does not carry those fields.

---

## W06 · Load a stress pack or restore the sample

**Goal.** Benchmark performance or get back to a known-good network.

**Where.** **Projects → Load stress-120 / Load stress-200**, or **Data → Load stress-…**; **Data → Restore sample network**.

**Steps.**
1. Load stress-200 (212 sites, 400 demand rows, 425 lanes) into the Active project.
2. Read the scorecard, then **Run**.
3. To recover from an experiment, **Restore sample network** or re-import `apps/web/public/samples/na-footprint-2027.flowform.json`.

**You get.** stress-200: `Optimal`, 9 open, `$176.81M`, 6 binding lane caps, ~0.9 s on a Mac. stress-120: `$89.12M`, 9 open, 3 binding lanes.

**Watch out.** Loading a stress pack **replaces the Active project's network**. Duplicate the project first if you want to keep the original.

---

# Part B — Design the network

## W07 · Navigate and filter the map

**Goal.** Read the network without changing it.

**Where.** **Network**.

**Steps.**
1. Use the **layer rail**: Plants, DCs, Demand, Suppliers, Lanes, Service radii, Candidates, Capacity heat, Territory.
2. Click a node or lane to select; **Shift+click** to add to the selection; **Esc** or click the background to clear.
3. Use the **product group filter** (All / Ambient / Chilled / Hazmat) to dim unrelated entities.
4. Toggle **SVG / schematic** when a tile basemap is unavailable.

**You get.** An Inspector for the selection, a KPI strip, and facilities/lanes tables that follow the selection.

**Watch out.** The map is a design surface, not a GIS. Selection is the input to almost every other action, so clear it before reading the "Network constraints" panel (it only appears with nothing selected).

---

## W08 · Edit a site

**Goal.** Change a facility's role, capacity, cost or capability.

**Where.** **Network → select a site → Inspector**.

**Steps.**
1. Edit name, type, region, capacity.
2. In the facility row set **Status** (Open / Closed / Candidate), **Capacity min/max**, **Open CapEx $M**.
3. Set **product capabilities** (SKU or group) and optional **capacity by product**.
4. **Run** to see the effect.

**You get.** A new model state; the run decides open/close subject to the constraints you set.

**Watch out.** **Capacity 0 now means zero**, not unlimited. Leave a capacity blank to mean "not capped". A minimum throughput (`capacityMin`) is a hard "must ship at least this if open" — it is the most common cause of an unexpected Infeasible ([W20](#w20--diagnose-an-infeasible-run)).

There is **no blank-node tool** on the map. A genuinely new site enters through an enterprise pack/CSV import, a promoted Greenfield candidate, or a Roadmap `open` event (which materialises the node). The Inspector edits sites that already exist.

---

## W09 · Edit or add a lane

**Goal.** Change how product moves, or add a corridor.

**Where.** **Network → select a lane → Inspector**, or **Data → Lanes**.

**Steps.**
1. Edit cost/unit, lead days, CO₂, lane capacity and tagged product groups.
2. Change **Transport mode** to rescale cost and CO₂ by mode relatives (Truck 1.0, Rail 0.55, Intermodal 0.72, Ocean 0.32, Air 4.5).
3. Add a lane with **from / to / mode / cost / lead / capacity**; delete with **Delete lane** (confirm).
4. **Run**.

**You get.** A changed network and, after a run, lane utilisation colours: red = binding, amber ≥ 80%.

**Watch out.** A lane overrides the service radius — if a lane exists, the arc is allowed even outside 250 miles. Deleting the only hazmat lane is the fastest way to make the sample infeasible (and a good demo of diagnostics).

---

## W10 · Add carrier bids to a lane

**Goal.** Compare contracted options without hand-editing rates.

**Where.** **Data → Lane rate tables & bids**, or the lane Inspector's carrier bids.

**Steps.**
1. Pick a strategy: **Cheapest**, **Fastest**, or **Balanced**.
2. Review bids by corridor (cost/unit, transit, capacity).
3. **Apply** one bid, **Add bid**, or **Apply all winners**.
4. **Reset rates** to return to the sample.

**You get.** Updated lane costs/transit and a `apply_bids` decision-log entry. Compare → **Bids** shows the same rollup.

**Watch out.** Applying a winner is a data change, not a scenario — the old rates are gone unless you reset or undo in your own copy. Duplicate the project first for a clean before/after.

---

## W11 · Set the network constraints

**Goal.** Tell the optimiser what "good" means.

**Where.** **Network → click empty background → Network constraints**, or **Data → Constraints linked to Network**.

**Steps.**
1. **Service radius** (default 250 mi) and **Max DCs (open)** — counts open DCs and candidates; plants are not counted.
2. **CapEx budget** ($M); the API also accepts a separate `maxPlants` when plants are optimisable.
3. **Service target** (95%) and **Hard service constraints** (forbid unmet demand instead of penalising it).
4. **Max lead time** (days) to cut slow lanes/modes.
5. Optional: `aggregateProductsByGroup`, `maxProductCommodities`, `carbonPricePerTonne`, `optimizePlants`, `forceOpenSeed`, `enforceLaneCapacity`.
6. **Run**.

**You get.** A different feasible region, and therefore possibly a different network. The run log records the values actually used.

**Watch out.** **Hard service** turns "expensive" into "Infeasible" — use it when a service failure is genuinely unacceptable, and read [W20](#w20--diagnose-an-infeasible-run) when it triggers. **Max DCs** counts candidates even when they stay closed.

---

## W12 · Greenfield candidate design

**Goal.** Decide where new DCs *could* go before committing to a site.

**Where.** **Greenfield**.

**Steps.**
1. Choose the demand set, site count (2–6), service miles and whether to lock existing sites.
2. **Run** to generate candidates with score and reach.
3. Select candidates, name the delta, **Promote → Candidates delta**.
4. **Scenarios → Compose** with a base scenario to create the what-if.

**You get.** A ranked candidate list, a mini-map, and a composed scenario with KPIs.

**Watch out.** Candidate generation is a **mock heuristic on the static sample demand**, and composed KPIs come from a formula — it is not a MIP sitting on your current network. Use it to frame the question, then put the candidates into the real network and **Run** to get an actual decision.

---

## W13 · Design a hub-and-spoke network

**Goal.** Replace point-to-point inbound with hubs and spokes.

**Where.** **Hubs**.

**Steps.**
1. Confirm or change the suggested hubs (**Suggest 2 hubs / Suggest 3 hubs**).
2. Choose **Assign spokes by** distance / volume / balanced (volume weight 0.45).
3. Choose the new-lane mode and whether to replace existing demand-inbound lanes.
4. Read **Before vs After** KPIs and hub loads.
5. Name the draft and **Apply + draft scenario**.

**You get.** Hub→spoke lanes, spoke assignments, a new Active scenario, and an `apply_hub` log entry.

**Watch out.** The preview can overload a hub (the sample's Columbus hits 114% in balanced mode). That is information, not a bug — the draft scenario is a hypothesis to run the MIP on.

---

## W14 · Design service territory

**Goal.** Assign customers to serving DCs/plants and see gaps and overlaps.

**Where.** **Territory**.

**Steps.**
1. Select the servers.
2. Choose **Assign by** distance / capacity / lanes.
3. Set coverage miles (400) and lead days (3).
4. Read coverage %, gaps, overlaps and load vs capacity.
5. **Apply as scenario + update preferred lanes**.

**You get.** Territory colours on the map, a preferred-lane set, a new scenario, and an `apply_territory` log entry.

**Watch out.** Assignment is a policy, not an optimisation. It is most useful as a **starting point** and as the `preferred_lanes` section of the handoff package.

---

## W15 · Merge an acquired network

**Goal.** Combine two networks and resolve id collisions.

**Where.** **Merge**.

**Steps.**
1. **Load sample acquired** or import the acquired network JSON.
2. Review **Sources** (Primary / Acquired / Merged preview) and the **Conflicts** table.
3. For each conflict choose **Keep both (rename acquired)**, **Keep primary only**, or **Replace with acquired**.
4. **Apply merge + draft scenario**, then **Run**.

**You get.** A merged network, a "Merged baseline (M&A draft)" scenario, and a `run_optimize`-ready model. The sample merge is 14 nodes / 14 lanes with 2 conflicts.

**Watch out.** The merge is structural (ids, endpoints, capacities) — it does not reconcile cost bases or calendars. Check lane rates and CapEx assumptions after merging.

---

# Part C — Optimise and explain

## W16 · Run the optimiser and read the status

**Goal.** Get the recommended network and know how much to trust it.

**Where.** Top chrome **Run** (same machinery powers Roadmap → Optimize timing and Compare → Robust).

**Steps.**
1. Click **Run**.
2. Watch the chip: `Queued` → `running %` on the job API, or `Checking optimize API…` on the sync path.
3. Read the final status line left to right: solver · status · seconds · model · service · objective split · SKU/group count · mode mix · binding lane caps.
4. Hover the run pill for the **model log**: model size, solver, status, and the explain re-solve count.
5. Open **Compare → Matrix** for the full objective breakdown.

**You get.** A new scenario with `optimizeMeta`: open/closed IDs, flows, objective breakdown, capacity/lane duals, product breakdown, lane utilisation, infeasibility report and (optionally) explain cards.

**Watch out.** `Optimal` means optimal **for the model you sent**, not for reality. The top three reasons a result is wrong are: demand in the wrong unit, a missing lane that forces an off-lane proxy, and a `capacityMin` that quietly forbids the cheap design. Check those before believing a big saving.

---

## W17 · Read the plain-language narrative

**Goal.** Explain the result to someone who will not read a matrix.

**Where.** **Compare → Matrix** (top card) and the onboarding result.

**Steps.**
1. Open Compare on the optimised scenario.
2. Read **In plain words** / **Run narrative**.
3. Follow the numbers back to the objective breakdown and the explain cards.

**You get.** A short, traceable story: what opened, what closed, what it costs, what drove it. Every number is traceable to the run result rather than generated prose.

**Watch out.** The narrative describes the **MIP's** choice. If the model is wrong, the narrative is confidently wrong — fix the data first.

---

## W18 · Explain why a site is open or closed

**Goal.** Defend or challenge an individual decision.

**Where.** **Network → select a site → "Why this site?"**, **Compare → Why this network**, **Brief**.

**Steps.**
1. Select a site after a run.
2. Read the badge (Opened / Kept open / Closed / Kept closed), utilisation, cost-to-serve, reachable demand and capacity dual.
3. Read the **counterfactual**: what happens if the decision is flipped. `Infeasible` is a valid and useful answer.
4. Use **Compare → Why this network** for the ranked list of opened and closed sites.

**You get.** A per-site argument with a dollar flip cost, service impact, and which other sites would move. For the sample: closing Austin strands 27.7M units (+$317.23M including penalty); closing Atlanta costs +$850k; opening Reno costs +$700k.

**Watch out.** Counterfactuals re-solve the MIP with that facility forced to the opposite state (bounded by `budgetSec`), so explain adds wall time. It explains **local** moves; it is not a full sensitivity analysis ([W26](#w26--sensitivity-tornado--monte-carlo)).

---

## W19 · Read the pre-run guardrails

**Goal.** Understand why Run refused to start, or catch a bad model before spending a solve.

**Where.** Status bar on **Run**; detail in **Data → Validation scorecard**; API `/optimize/validate`.

**Steps.**
1. Click **Run**.
2. If blocked, read `Run blocked — <reason>. Fix: <fix>. (+N more)`.
3. Fix the first error; the rest are usually consequences.
4. Optionally ask for a deeper check with `POST /optimize/validate?deep=true`, which solves and turns infeasibility root causes into blocking issues.

**You get.** A reason and a fix, not a stack trace. Typical blocks: no network, no demand, duplicate ids, orphan demand, non-positive capacity, a BOM cycle.

**Watch out.** Guardrails are **fast structural checks**, not a proof of feasibility. A model can pass them and still be Infeasible; that is what [W20](#w20--diagnose-an-infeasible-run) is for. An older API without the route is skipped silently.

---

## W20 · Diagnose an infeasible run

**Goal.** Find which constraint family is impossible, and by how much.

**Where.** Run result **Infeasibility diagnostics** in **Compare → Matrix**, plus **Shortfall tables** in results.

**Steps.**
1. Run. An infeasible run still creates a scenario (`Optimize Infeasible <time>`) and does **not** apply open/close decisions.
2. Read the first hint and its entities.
3. Use the relaxation result: "with minimums relaxed the model solves (service 91.8%, $122.76M)" tells you the minimum throughput is the blocker, not reachability.
4. Fix the named constraint (lower `capacityMin`, add the missing lane, raise lane capacity, loosen radius/lead time) and re-run.

**You get.** Codes such as `MIN_THROUGHPUT_CONFLICT`, `LANE_CAPACITY_CONFLICT`, `UNREACHABLE_DEMAND`, `NO_CAPABLE_FACILITY`, `HARD_SERVICE_INFEASIBLE`, plus shortfall tables (lane cap vs required, facility min vs feasible throughput).

**Watch out.** `UNREACHABLE_DEMAND` is often **context**, not the root cause; the relaxation probe is the part to trust. Probes re-solve up to three times, so an infeasible run takes longer than a feasible one. This is best-effort diagnosis, not a full IIS.

---

## W21 · Work without the API (heuristic fallback)

**Goal.** Keep designing when the API is unreachable.

**Where.** **Run** with the API stopped.

**Steps.**
1. Stop the API (or work air-gapped).
2. **Run**.

**You get.** `Heuristic v1 — greedy open/close (not a full MIP)`, roughly 58.8% service on the sample, and a scenario you can still compare visually. All client-side analysis (DES-lite, sensitivity, inventory, resilience, territory, hubs) still works.

**Watch out.** Never present a heuristic result as an optimisation. The status line says so on purpose; keep that label in any screenshot or export.

---

# Part D — Scenarios and analysis

## W22 · Create a what-if from a preset

**Goal.** Answer a common shock question in one click.

**Where.** **Scenarios → Sensitivity presets**.

**Steps.**
1. Choose **Fuel +20%**, **Demand shift East**, **Node outage (DC)**, or **Tariff / duty (MX inbound)**.
2. A new what-if is created from the Active scenario.
3. **Run** it, or compare it without a MIP.

**You get.** A named scenario with changed lane costs/demand/status, ready to compare.

**Watch out.** Presets are **data transforms**, not new models. Re-run to get a new optimum; comparing a preset to an optimised network without re-running compares an assumption change to a decision change.

---

## W23 · Compose a scenario from deltas

**Goal.** Combine a promoted change (greenfield candidates, inbound lanes) with a base future.

**Where.** **Scenarios → Compose**.

**Steps.**
1. Promote a delta (for example Greenfield candidates), or use a scenario produced by an apply action (BOM inbound, hubs, territory).
2. In Scenarios, choose the base and the delta(s), name the result, **Compose**.
3. Run or compare.

**You get.** A new scenario combining both. Composed KPIs come from a formula until you run the MIP.

**Watch out.** Composition is additive and does not resolve contradictions (two deltas opening the same site). Run the composed scenario before trusting its KPIs.

---

## W24 · Compare scenarios

**Goal.** Decide between futures without losing your place.

**Where.** **Compare** (up to 5 scenarios; defaults Baseline + Active).

**Steps.**
1. Pick the scenarios and the Reference.
2. Use the tabs by question:
   - **Matrix** — KPIs, objective breakdown, flows by mode/lane capacity, explain, diagnostics, SKU breakdown.
   - **Map diff** — what changes where.
   - **Waterfall** — what moved the cost.
   - **Cost-to-serve** — customer-level landed cost (uses MIP flows when present).
   - **DES-lite / Sensitivity / Inventory / Resilience** — service and risk.
   - **Mode mix / Products / Bids / BOM / Territory** — structural detail.
   - **Robust** — the scenario-tree result.
3. Add **comments** or check the **decision log** next to the comparison.

**You get.** A defensible side-by-side, with the optimised run's objective decomposed rather than a single cost number.

**Watch out.** Deltas are against the **Reference**, not against the previous tab. When the Baseline has been recomputed by a run, that is the honest comparison; before the first run it is still the seed.

---

## W25 · Cost-to-serve a customer

**Goal.** See which customers are expensive to serve and from where.

**Where.** **Compare → Cost-to-serve**.

**Steps.**
1. Run the MIP so flows exist.
2. Open the tab and sort by landed cost.
3. Compare against the network design and expected service DC.

**You get.** Per-customer transport + variable OpEx, a service DC, and totals that reconcile to the objective's transport + OpEx.

**Watch out.** Without a run it falls back to distance heuristics. CTS explains **variable** cost; it does not allocate fixed CapEx.

---

## W26 · Sensitivity: tornado + Monte Carlo

**Goal.** Know which assumption actually matters.

**Where.** **Compare → Sensitivity**, or **Scenarios → Cost tornado + Monte Carlo**.

**Steps.**
1. Run on the Active scenario.
2. Read the one-at-a-time tornado across six drivers (transport $/mi, fuel, tariff, demand, facility fixed, inventory holding).
3. Read the Monte Carlo distribution (default 300 trials, seed 42) with P10/P50/P90.

**You get.** A ranked driver list and a cost distribution; the result is stored on the scenario.

**Watch out.** OAT ranges are planning assumptions, not fitted distributions. The MC treats drivers as independent; real fuel and transport costs are correlated.

---

## W27 · Service stress test (DES-lite)

**Goal.** Estimate fill rate and late demand under lead-time and demand noise.

**Where.** **Compare → DES-lite**.

**Steps.**
1. Select the Active scenario.
2. Run the Monte Carlo (default 200 trials, demand noise 15%, lead noise 20%, target 5 days, seed 42).
3. Read fill rate and late-demand %.

**You get.** A service distribution stored on the scenario.

**Watch out.** DES-lite is a lightweight simulation, not a full discrete-event model of docks, waves or appointments.

---

## W28 · Inventory policy

**Goal.** Attach safety stock and inventory dollars to the design.

**Where.** **Compare → Inventory**.

**Steps.**
1. Edit per-DC/plant service target, lead time, demand σ and holding cost.
2. Choose simple `z·σ·√LT` or the ASCM combined method.
3. **Apply to Active KPIs**.

**You get.** Inv $ and units on the scenario KPIs, and inventory targets in Handoff.

**Watch out.** Multi-echelon is "lite": it does not optimise where stock sits, it costs the policy you specify.

---

## W29 · Resilience / single points of failure

**Goal.** Find the sites whose loss breaks service.

**Where.** **Compare → Resilience**.

**Steps.**
1. Set the threshold (default = service target).
2. Score the network.
3. Read critical nodes and the service drop if each is removed.

**You get.** A SPOF list and a Risk KPI update, stored on the scenario.

**Watch out.** Requires lane-aware reachability and a real drop (≥0.5 pp **and** below threshold) — a site that is merely important but not breaking service is not flagged. It tests single-node loss only, not correlated failures.

---

## W30 · Check product mix, BOM and territory in the comparison

**Goal.** Verify the design is structurally sound, not just cheap.

**Where.** **Compare → Products / BOM / Bids / Mode mix / Territory**.

**Steps.**
1. **Products** — per-SKU/group demand, served, service %, transport.
2. **BOM** — rows, components, implied RM, lane gaps.
3. **Bids** — carrier bid rollup and per-lane apply.
4. **Mode mix** — lane count and flow share by mode, CO₂ share.
5. **Territory** — coverage summary and assignments.

**You get.** The "is this actually operable?" view behind the cost number.

**Watch out.** These tabs read the current model and the last MIP; after editing data, re-run before quoting them.

---

# Part E — Timing, uncertainty and carbon

## W31 · Build a CapEx roadmap

**Goal.** Phase open/close/expand events over 2–8 years.

**Where.** **Roadmap**.

**Steps.**
1. Set the base year label and number of years.
2. Add events: kind (open/expand/close), year, facility, name, CapEx $M, capacity delta.
3. Read the Gantt-lite timeline and cumulative CapEx/capacity table.
4. **Export to Brief** if the roadmap is part of the recommendation.

**You get.** A roadmap the multi-period optimiser can time, and year slices you can turn into scenarios.

**Watch out.** A roadmap event on a facility that is not in the network is materialised as a DC node. An `open` event means the site starts **closed** until that year — that is intentional (the event *is* the opening).

---

## W32 · Optimise investment timing (NPV)

**Goal.** Choose *when* to spend, not just whether.

**Where.** **Roadmap → Optimize timing** (calls `/optimize/multi-period`).

**Steps.**
1. Choose **Choose timing (NPV)** or **Force timeline**.
2. Set the discount rate (default 10%).
3. Run. Read NPV total, CapEx/OpEx/transport NPV, per-year rows, and the chosen year for each event.
4. **Apply year slice** (through year) to create a scenario, or **Export NPV to Brief**.

**You get.** NPV-minimising timing, with each period solved on the **Run model** (SKUs, BOM, lane modes, carbon, lane fixed charges) and periods linked by event binaries. Y0 equals the single-period Run.

**Watch out.** Demand growth is uniform across the horizon, and the CapEx budget is enforced at Y0 only in the current model. Larger rosters can stop at the time limit with a non-zero gap — the status says so.

---

## W33 · Robust / scenario-tree optimisation

**Goal.** Choose a network that performs across several futures.

**Where.** **Scenarios → Robust optimize**, or **Compare → Robust**.

**Steps.**
1. Ensure 2–5 scenarios exist (they are used as shocks; otherwise the built-in Base / Soft / Surge set is used).
2. Choose the objective: **Expected cost**, **Minimax**, or **CVaR-lite** (α 0.3).
3. Run.
4. Read first-stage opens, per-scenario costs, worst case, and the EVPI-style gap.

**You get.** A shared first-stage design with per-scenario flows. Built-in shocks on the sample open Austin/Columbus/Atlanta (Reno closes): E[cost] $101.14M, worst $122.19M, CVaR-lite $107.45M, EVPI $0.

**Watch out.** Robust is **design enumeration** (wait-and-see optima + the two-stage design, re-solved per scenario), not one monolithic two-stage MIP. Minimum throughput may be relaxed under a demand shock and is flagged per scenario.

---

## W34 · Put a price on carbon

**Goal.** See how a carbon price changes the design.

**Where.** **Network constraints / Data → CO₂ emission factors**, then **Run**.

**Steps.**
1. Set `carbonPricePerTonne` (e.g. 100) and confirm emission factors and unit weights.
2. Run.
3. Read `carbonM` and `transportCo2Tonnes` in the objective breakdown.

**You get.** A carbon cost consistent with the reported CO₂ (same tonnes), e.g. $0.5495M on the sample at $100/t, total $98.8201M.

**Watch out.** CO₂ is modelled transport only (tonne-miles × factor). Unit weights are planning assumptions by SKU/group/default; an explicit lane-mode `co2KgPerUnit` overrides the weight. Backhaul and load factor are not modelled.

---

# Part F — Data and reference

## W35 · Work with the enterprise data model

**Goal.** Understand and edit the canonical pack.

**Where.** **Data → Enterprise data model**.

**Steps.**
1. **Export pack JSON** to inspect or edit externally.
2. **Import pack JSON** to load changes.
3. Read the scorecard and issue list; fix errors before import.

**You get.** A versioned (`enterprise-data-v1`) file that any Flowform instance can load and that the MIP consumes directly.

**Watch out.** The web rebuilds this pack from studio state on every Run, so editing the pack file alone is not persistent unless you import it. Keep the exported pack with the project when archiving.

---

## W36 · Product groups, capabilities and unit weights

**Goal.** Model product families, who can handle them, and their CO₂ weight.

**Where.** **Data → Product / commodity groups**, **Facility capabilities**, **Unit weights**.

**Steps.**
1. Switch the catalog (Ambient/Chilled/Hazmat or Finished/WIP/RM).
2. Set demand mix by node.
3. Tick capabilities per facility and optional per-product capacity caps.
4. Set unit weights (kg/unit) per SKU/group and a project default.

**You get.** Per-commodity flows and a CO₂ number tied to real weights.

**Watch out.** Capabilities accept SKU **or** group ids; a group cap applies to every SKU in that group. Setting a capability without capacity can still leave demand unreachable.

---

## W37 · Set up a bill of materials

**Goal.** Model finished goods ← components/raw material, with inbound supply.

**Where.** **Data → Bill of materials**.

**Steps.**
1. Set FG demand shares.
2. Add BOM rows: parent FG, child component/RM, qty per unit, plant and/or supplier.
3. Read **Implied RM demand** and **Echelon flows**.
4. **Highlight BOM lanes** to see gaps on the map.
5. **Draft inbound scenario** to create missing supplier→plant lanes.

**You get.** `bomDemand` arcs in the MIP, implied RM volumes, and an inbound-lane scenario.

**Watch out.** A BOM cycle is a hard error (−15 score). Supplier lanes have no mode choice yet; they carry cost but not a mode.

---

## W38 · Lane rate tables and bids

See [W10](#w10--add-carrier-bids-to-a-lane). Use the Data view when you want the whole book rather than one corridor.

---

## W39 · Fix validation errors

**Goal.** Get from a rejected import to a clean model.

**Where.** **Data → Validation scorecard**.

**Steps.**
1. Read the first error, its entity id, and the hint.
2. Fix at the source (CSV, pack, or Data editor).
3. Re-validate; repeat until `errorCount = 0`.
4. Warnings are judgment calls; read them before dismissing.

**You get.** An importable pack and a score you can quote. A BOM cycle, orphan demand, duplicate site id or non-positive capacity will always block.

**Watch out.** Import is blocked on **errors**, not warnings. A warning such as a geocode gap does not stop the solve but distorts distance-based costs.

---

# Part G — Decide and hand off

## W40 · Record the decision trail

**Goal.** Keep an auditable history of what was tried.

**Where.** **Compare / Brief / Projects → Decision log**.

**Steps.**
1. Work normally; meaningful actions append automatically (activate scenario, run, apply hub/territory/roadmap/BOM/bids/sensitivity, handoff, share).
2. Filter by action type.
3. **Export JSON** for the project file.

**You get.** An append-only log inside the project snapshot, plus server-side `AuditEvent` rows for `/v1` actions.

**Watch out.** The browser log is per project and travels with the JSON; the server audit trail is per tenant. They are complementary, not the same table.

---

## W41 · Comment on a scenario

**Goal.** Leave context for the reviewer.

**Where.** **Compare** and **Brief** → Comments panel.

**Steps.**
1. Add author, timestamp and body.
2. Switch scenarios to see the thread.

**You get.** A per-scenario discussion stored in the project.

**Watch out.** Comments are local to the project file; there is no real-time collaboration or notification.

---

## W42 · Share a read-only stub

**Goal.** Send a pointer to a study.

**Where.** Top chrome **Share**.

**Steps.**
1. Click **Share**.
2. Flowform copies a `flowform://share?…&readonly=1` link and downloads `<name>.share.json`.

**You get.** A share pack containing the project JSON and a deep-link stub.

**Watch out.** There is **no receiver** for the `flowform://` link yet; send the JSON and import it ([W03](#w03--open-an-existing-project-file)) for a working handoff.

---

## W43 · Write the Decision Brief

**Goal.** Turn the analysis into a recommendation someone can sign.

**Where.** **Brief**.

**Steps.**
1. Choose the **Recommended scenario**.
2. Review the scenario cards and the **Why this network** panel.
3. Tick the assumptions that actually hold (six defaults, five checked by default) and add notes.
4. **Download Markdown** or **Printable HTML**.

**You get.** `flowform-brief-<horizon>.md` / `.html`: recommendation, KPIs, assumptions, notes and the explain section. **Send to Handoff** carries it forward.

**Watch out.** The brief copies the current numbers. Re-run after any data change, and check the KPI source (API vs seed) before publishing.

---

## W44 · Produce the handoff package

**Goal.** Give planning a clean, structured design.

**Where.** **Brief → Send to Handoff**, then **Handoff**.

**Steps.**
1. Send the brief to Handoff.
2. Review the section tabs: overview, network, preferred lanes, territory, CapEx, products, BOM, inventory, scenarios, README, raw JSON.
3. **Download JSON** (`flowform.handoff.v1`) and **Ops brief (Markdown)**.

**You get.** `flowform-handoff-<horizon>-flowform.handoff.v1.json` plus an ops brief. Sites, lanes, preferred territory, CapEx calendar, product mix, BOM implied RM, inventory targets and scenario metadata — a contract stub for Ritara intake.

**Watch out.** This is a **file contract**, not a live sync; no Ritara code is embedded. Inventory targets are policy outputs, not commitments.

---

# Part H — Projects, workspace and platform

## W45 · Manage projects

**Goal.** Keep studies separate and portable.

**Where.** **Projects**.

**Steps.**
1. **New project**, **Rename**, **Duplicate**, **Export**, **Open**, **Delete**.
2. Export writes `<name>.flowform.json`; import restores it.
3. Delete is disabled when only one project remains.

**You get.** Independent studies; each carries its own scenarios, data and log.

**Watch out.** Deleting a project deletes its browser copy. With workspace sync on, the server copy is deleted separately by the sync path — check the banner before assuming it is gone everywhere.

---

## W46 · Save to a workspace and work offline

**Goal.** Keep projects beyond one browser and share them across machines.

**Where.** **Projects → workspace banner**.

**Steps.**
1. Start the API with `DATABASE_URL` and `AUTH_MODE=dev` (or `workos`).
2. Reload the web app. The banner should read **Saved to your workspace.**
3. If projects exist only locally, click **Move my N local project(s) to my workspace**.
4. If the API is down, keep working: edits stay local and queue; the banner says **Workspace unreachable**.
5. Turn sync off entirely with `VITE_PROJECT_STORE=local`.

**You get.** A local-first studio with a server mirror, offline queue, and one-click migration. The mapping is `flowform-server-links`; pending uploads are `flowform-sync-pending`.

**Watch out.** The mirror is **last-write-wins from the browser** — it does not send `If-Match`. Two people editing one project will overwrite each other; the API's 409 exists for clients that track versions. There is no login screen in the web app yet ([W48](#w48--sign-in-and-roles)).

---

## W47 · Run a long solve and cancel it

**Goal.** Use the async job API without losing the UI.

**Where.** Top chrome job chip; any **Run**, **Optimize timing** or **Robust** action.

**Steps.**
1. Start the solve. The chip shows `Run · queued 20% · Solving` (or Roadmap/Robust).
2. Keep editing other rooms; the job polls in the background.
3. Click **Cancel** to stop it. The server flips the run to `cancelled`; a late result is discarded.

**You get.** Progress, cancel, and a result identical to the sync path (same request→engine mapping). If the job API is unavailable, the client falls back to a direct solve and the chip says `direct`.

**Watch out.** A run that has reached the server is **never silently re-run** on the sync path; if it fails server-side, you get the failure. Cancelling is best-effort at the transport level — the database status is authoritative.

---

## W48 · Sign in and roles

**Goal.** Use the workspace with more than one person.

**Where.** API `/v1/auth/*`; web account menu in the top chrome (sign in, role, organisation, refresh, sign out).

**Steps.**
1. Choose `AUTH_MODE`: `dev` (headers), `jwt` (Bearer JWT), or `workos` (AuthKit).
2. For WorkOS: set `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, and `WORKOS_REDIRECT_URI` (e.g. `http://localhost:5180/auth/callback`) in the API. Add project origins to the WorkOS Dashboard redirect list; extra allowlist entries go in `WORKOS_ALLOWED_REDIRECT_URIS`.
3. Open the web, click the account chip, and **Sign in**. AuthKit returns to `/auth/callback`, the API checks the signed state, and the app stores the session.
4. Use the menu to switch organisation (if you belong to several), refresh the session, or sign out. Sign-out clears local tokens and ends the WorkOS session.
5. Owners can generate an SSO/directory setup link with `POST /v1/auth/admin-portal`.

**Notes.** `redirect_uri` not on the allowlist → 400. Missing, forged or expired `state` → 400 before the code is exchanged. A WorkOS token minted for another client → 401. Access tokens stay in memory; the refresh token is in `sessionStorage`, never `localStorage`.
6. In `AUTH_MODE=off` (default) the menu reads **Local workspace** and the studio behaves as before.

**You get.** Tenants from `org_id`, users from `sub`, auto-provisioning, and RBAC:

| Role | Can |
|---|---|
| viewer | read projects, snapshots, scenarios, runs, run events |
| editor | + create/update projects & scenarios, start/cancel runs |
| admin | + delete projects & scenarios |
| owner | + WorkOS Admin Portal, future billing |

**Watch out.** `AUTH_MODE=off` makes every `/v1` call 401; the solve endpoints stay open. `AUTH_MODE=dev` trusts `X-Dev-*` headers, so it is accepted **only from loopback clients with no proxy header** (the API logs a `DEV AUTH` warning at startup, and the account menu shows it). Use `DEV_AUTH_ALLOW_REMOTE=1` only for an isolated dev container whose port is loopback-bound. The browser has sign-in, refresh, sign-out and an organisation picker; invite flow, SSO self-serve portal and project ACLs are still to come.

---

## W49 · Themes, keyboard and horizon

**Goal.** Work comfortably and set the planning horizon.

**Where.** Top chrome theme toggle and horizon picker; `?` for help.

**Steps.**
1. Toggle **☀ Light / ☾ Dark**; the choice persists in `flowform-theme` and follows the OS on first load.
2. Press `?` to open shortcuts; `Esc` closes help, then clears selection.
3. **Shift+click** multi-selects nodes or lanes.
4. Shortcuts are ignored while typing in inputs/textareas/contenteditable.
5. Set **Horizon** to FY26 / FY27 / FY28. It labels the planning horizon and names the Brief and Handoff exports (`flowform-brief-FY28.md`).

**You get.** Persisted theme and predictable selection behaviour.

**Watch out.** Search (`⌘K`) is still a stub — it does nothing.

---

# Part I — API-only use

## W50 · Call the solve API with curl

**Goal.** Integrate Flowform without the UI.

**Where.** `apps/api` with the venv active, API on `:5182`.

**Steps.**
1. Build a sample payload from the test helper:
   ```bash
   python3 -c "import json; from tests.test_demo_cost_scaling import sample_payload; json.dump(sample_payload(), open('/tmp/ff-sample.json','w'))"
   ```
2. Call it:
   ```bash
   curl -s -X POST localhost:5182/optimize \
     -H 'content-type: application/json' -d @/tmp/ff-sample.json | python3 -m json.tool
   ```
3. Read `status`, `objectiveBreakdown`, `openIds` / `closedIds`, `flows`, `kpis`, `shadowPrices`.

**You get.** The same result the UI gets: `Optimal`, `$98.2706M`, `closedIds ["n8"]`, `servicePct 100`.

**Watch out.** Payloads are size-capped and time-limited ([W53](#w53--handle-limits-and-errors)). A 422 means the schema is wrong; a 400 means the model is unusable as sent; a 503 means the solver stopped at a limit.

---

## W51 · Pre-check a payload without solving

**Goal.** Validate a request cheaply before a long solve.

**Where.** `POST /optimize/validate`.

**Steps.**
1. Post the same `{network, constraints}` body.
2. Read `ok`, `blocking`, `issues[]` and `shortfalls`.
3. Add `?deep=true` to also solve and turn Infeasible root causes into blocking issues.

**You get.** A machine-readable guardrail result; the cheap path does not consume a solve slot.

**Watch out.** `deep=true` does solve, so it is not free. Structural `ok` does not guarantee feasibility.

---

## W52 · Use the async run API

**Goal.** Queue a solve, stream progress, cancel, and fetch the result.

**Where.** `/v1/projects/{project_id}/runs`.

**Steps.**
1. `POST /v1/projects/{id}/runs` with `{kind: "optimize" | "multi-period" | "stochastic", payload, scenarioId?}` → **202** run.
2. Poll `GET …/runs/{rid}` (result appears when terminal), or stream `GET …/runs/{rid}/events` (SSE `status`, `done`, `timeout`, `gone`).
3. `POST …/runs/{rid}/cancel` to stop.

**You get.** The same JSON as the sync endpoint, plus a durable `Run` row with input hash and engine/solver versions.

**Watch out.** Requires a workspace (`DATABASE_URL`, auth). The stream has a 15-minute deadline and a 15 s heartbeat; treat it as a convenience and poll the run for the source of truth.

---

## W53 · Handle limits and errors

**Goal.** Know exactly why a request was refused, without guessing.

**Where.** Every solve endpoint.

| Limit | Default | Override |
|---|---|---|
| Nodes / lanes / demand rows | 5,000 / 20,000 / 5,000 | `constraints.maxNetworkNodes` etc. |
| SKUs / roadmap events / scenarios | 500 / 200 / 10 | `constraints.maxCommodities` etc. |
| Solver wall clock | 120 s (clamped 1–600) | `constraints.solverTimeLimitSec` |
| Concurrent solves per worker | 2 | `MAX_CONCURRENT_SOLVES` |

| Status | Meaning | What to do |
|---|---|---|
| 422 | Schema rejected by pydantic | Fix the field named in `loc` |
| 400 | Bad or oversized model (also `ValueError` from the engine) | Read the message; split the study or raise the named cap |
| 429 | Worker busy (`Retry-After: 2`) | Retry shortly; reduce concurrency |
| 503 | Time limit reached, or solver missing | Simplify, raise the limit, or check `highspy` |
| 500 | Unexpected; logged server-side | Quote the timestamp; the response deliberately says nothing internal |

**Watch out.** An oversized request is **rejected, never truncated** — a truncated network would report an optimum for a model you did not send. A time-limited solve is not a result and is never returned as a zero-cost network.

---

## W54 · Reproduce the MIP in another language

**Goal.** Reimplement or audit the model.

**Where.** `apps/api/README.md` (contract), `apps/engine/flowform_engine/solver.py`, `apps/api/tests/golden/cases.py`.

**Steps.**
1. Read the units and cost-scale rules first (§4.3 of the blueprint).
2. Use the golden cases as the oracle: sample, stress-120/200, infeasible, roadmap, robust, explain.
3. Match `objectiveBreakdown`, `openIds`, `kpis.servicePct` before matching flows (alternate optima are real).

**You get.** A model you can defend line by line.

**Watch out.** `CO₂` and `totalM` can have multiple equally optimal solutions, which is why the golden harness excludes objective-indeterminate fields on some cases rather than pretending they are stable.

---

# Part J — Worked recipes

## R1 · "Should we close our Reno DC?"

1. Open Network → Run (baseline optimum).
2. Select Reno → **Why this site?** → read the flip cost (+$700k to open).
3. Force Reno closed in the Inspector, Run again → compare to the recommendation.
4. Brief → recommend the better scenario; add the flip evidence to notes.

**Decision:** keep it closed if the flip is positive and service holds. If the flip is negative, the constraint set (radius, lane, capacity) is forcing the site open — fix the constraint, not the site.

## R2 · "Where should the next DC go?"

1. **Greenfield** → generate 3–6 candidates.
2. **Promote** the shortlist; **Compose** with the current network.
3. Set candidate CapEx and capacity in Network.
4. **Run**. Read which candidates open, and the explain card for each closed one.
5. **Robust** with demand/cost shocks before committing.

**Decision:** open only the candidate that survives both the deterministic run and the robust objective.

## R3 · "Our service target is 98% — what does it cost?"

1. Set **Service target** 98 and **Hard service** on.
2. Run. If infeasible, read [W20](#w20--diagnose-an-infeasible-run) and find the shortfall.
3. Compare the 95% and 98% scenarios in **Compare → Matrix**.

**Decision:** quote the delta and the binding constraint, not just "it costs more".

## R4 · "A carrier bid would cut linehaul 8% — should we take it?"

1. **Data → Lane rate tables & bids** → apply the bid to the affected corridors.
2. Run.
3. Compare the new scenario against the old one in **Mode mix** and **Cost-to-serve**.

**Decision:** accept only if the saving survives the service/lane-capacity constraints; a cheaper bid often shifts volume onto a lane that is already binding.

## R5 · "We are acquiring a regional 3PL — what does the combined network look like?"

1. **Merge** → import the acquired network.
2. Resolve id conflicts; **Apply merge + draft scenario**.
3. Run; inspect overlapping DCs and duplicated lanes.
4. Roadmap: phase closures and CapEx.
5. Handoff for the integration team.

**Decision:** the merged design, the closure list and the CapEx calendar — not a single cost number.

---

# Part K — Boundaries

Flowform **is** a strategic network-design studio: fixed-charge multi-echelon MIP, multi-period NPV, scenario-tree robustness, explainability, data validation, and a handoff contract.

Flowform **is not**:

- an APS, scheduler, MRP or order-promising engine;
- a live connection to Ritara (the handoff is a file contract);
- a full GIS (the map is a design surface with a schematic fallback);
- a discrete-event simulator (DES-lite is a Monte Carlo approximation);
- a multi-user real-time editor (the workspace is a versioned mirror, comments are local);
- a substitute for measured cost and weight data (defaults are assumptions and are labelled as such).

If a request needs one of those, the honest answer is "not here" — and the handoff package is the bridge to the tool that does it.

---

## Appendix A — Environment reference

| Variable | Where | Default | Purpose |
|---|---|---|---|
| `VITE_API_URL` | web | `http://127.0.0.1:5182` | Solve + workspace API |
| `VITE_PROJECT_STORE` | web | `api` | `local` disables server mirroring |
| `VITE_RUN_MODE` | web | `jobs` | `sync` forces the pre-job path |
| `VITE_DEV_TENANT`, `VITE_DEV_USER` | web | — | Dev auth headers |
| `VITE_BASEMAP`, `VITE_CARTO_API_KEY` | web | OpenFreeMap | Basemap choice |
| `VITE_SENTRY_DSN` (+ `VITE_SENTRY_ENVIRONMENT`, `VITE_SENTRY_RELEASE`) | web | — | Browser error reporting; unset = off |
| `DATABASE_URL` | api | `…@127.0.0.1:5433/flowform` | Postgres/PostGIS |
| `AUTH_MODE` | api | `off` | `dev` (loopback only) / `jwt` / `workos` |
| `DEV_AUTH_ALLOW_REMOTE` | api | — | `1` accepts dev headers from any peer (isolated containers only) |
| `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, `WORKOS_REDIRECT_URI` | api | — | AuthKit |
| `WORKOS_ALLOWED_REDIRECT_URIS`, `WORKOS_STATE_SECRET` | api | — | Extra redirect allowlist; login-state HMAC key |
| `WORKOS_ENFORCE_CLIENT_CLAIM` | api | `1` | Require `client_id`/`azp` to match |
| `QUEUE_BACKEND` | api | `inline` | `inline` / `arq` / `manual` |
| `REDIS_URL` | api | `redis://127.0.0.1:6380/0` | arq |
| `MAX_CONCURRENT_SOLVES` | api | `2` | Per-worker solve slots |
| `MAX_PROJECTS_PER_TENANT` | api | `100` | Workspace project count (`403` past it) |
| `MAX_VERSIONS_PER_PROJECT` | api | `50` | Snapshot history kept per project; older versions are pruned on save |
| `MAX_TENANT_STORAGE_BYTES` | api | `512 MiB` | Stored snapshot bytes per workspace |
| `MAX_PROJECT_SNAPSHOT_BYTES` | api | `5 MiB` | One snapshot body (`413` past it) |
| `SOLVE_QUEUE_WAIT_S` | api | `5` | Wait before 429 |
| `RUN_EVENTS_MAX_S` | api | `900` | SSE deadline |

## Appendix B — Files you will see

| File | Produced by |
|---|---|
| `<name>.flowform.json` | Projects → Export |
| `<name>.share.json` | Top chrome → Share |
| `flowform-brief-<horizon>.md` / `.html` | Brief |
| `flowform-handoff-<horizon>-flowform.handoff.v1.json` | Handoff |
| `flowform-handoff-ops-<horizon>.md` | Handoff |
| `<project>.decision-log.json` | Decision log → Export |
| `stress-120/200-demand.enterprise.json` | Built-in sample packs |

## Appendix C — Where to go next

- **How it is built** → [`MASTER_BLUEPRINT.md`](MASTER_BLUEPRINT.md) (architecture, model, API, limits, limitations).
- **How to verify it** → [`MANUAL_TEST_WORKBOOK.md`](MANUAL_TEST_WORKBOOK.md) (WF00–WF20, expected values, defect log).
- **Why it is built this way** → [`adr/`](adr/README.md) (hosting, auth, jobs, tiles, analytics, solver adapter).
- **What is next** → [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md) and blueprint §12.
