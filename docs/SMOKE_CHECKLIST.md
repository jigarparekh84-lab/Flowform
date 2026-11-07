# Flowform — manual smoke checklist

> **Quick smoke only (~10 min).** For full manual QA, use the **[Manual Test Workbook](MANUAL_TEST_WORKBOOK.md)** (21 workflows, 199 original + 28 platform cases with captured expected values, a 20-check regression suite, and a defect log). An Excel copy with Pass/Fail dropdowns and status counts is at [`Flowform_Manual_Test_Workbook.xlsx`](Flowform_Manual_Test_Workbook.xlsx) (a point-in-time export; the Markdown is authoritative). **How to use the product:** [User Workflows](USER_WORKFLOWS.md). **Architecture and limits:** [Master Blueprint](MASTER_BLUEPRINT.md). Workbook case IDs are shown as *(→ RUN-02)*.

Room-by-room pass for a healthy local build (`npm run dev` on **5180**, optional API on **5182**). Use a fresh browser profile or clear Flowform `localStorage` keys if state looks stale.

The core path (identity → project → run → compare → brief → share, plus light/dark) is automated in CI: `cd apps/web && npm run test:e2e` (CR-032). This checklist still covers what a script should not judge — copy, layout, and the judgement calls.

**Default basemap:** OpenFreeMap (no API key). Do not require Carto for smoke.

**Sample pack:** [`apps/web/public/samples/na-footprint-2027.flowform.json`](../apps/web/public/samples/na-footprint-2027.flowform.json) — importable `flowform-project` v1 with the built-in NA network, Baseline + three what-ifs, product mix, lane rates, BOM, CapEx roadmap, and inventory policies.

**Stress packs (enterprise-data-v1):** [`stress-120-demand.enterprise.json`](../apps/web/public/samples/stress-120-demand.enterprise.json) and [`stress-200-demand.enterprise.json`](../apps/web/public/samples/stress-200-demand.enterprise.json) — load via **Projects → Load stress-*** or **Data → Load stress-*** (or Import pack JSON).

---

## 0. Load the sample project

1. Start web: `cd apps/web && npm run dev` → http://localhost:5180  
2. Open **Projects**.
3. Click **Import JSON** and choose `apps/web/public/samples/na-footprint-2027.flowform.json`  
   - Or, while the app is running, download http://localhost:5180/samples/na-footprint-2027.flowform.json then Import that file.
4. Confirm status shows imported **“NA Footprint 2027 (sample)”** and it becomes Active.
5. Optional: regenerate the pack after sample-builder changes:  
   `cd apps/web && npx tsx ../../scripts/export-sample-project.mts`

---

## 1. Projects

- [ ] Index lists at least the imported sample; **Open** / **Rename** / **Duplicate** work.
- [ ] **Export** downloads a `*.flowform.json` with `format: "flowform-project"`.
- [ ] **Import JSON** of that export creates a new project and switches Active.
- [ ] Decision log panel renders (may be empty on fresh sample).
- [ ] Delete is disabled when only one project remains; with 2+, delete works and Active updates.

---

## 2. Data

- [ ] Room tip / empty guidance visible when appropriate; **Restore sample network** reloads built-in nodes/lanes.
- [ ] Download sites / demand / lanes CSV templates; re-upload at least one without hard errors.
- [ ] Validation summary shows counts; CO₂ factors editable.
- [ ] **Unit weights (CO₂ basis)** panel: Ambient 2 / Chilled 1.5 / Hazmat 3.5 kg, default 20 kg; editing a weight changes CO₂ after Run *(→ DAT-08)*. KPI, Compare, Brief and mode mix all show 5.5 kt *(→ DAT-09)*.
- [ ] Product / commodity groups present; lane rate tables & bids list corridors; BOM table has sample FG←RM rows.
- [ ] **Lanes** card lists 9 lanes; **Delete** removes one after confirm (count → 8). Inspector on a lane also has **Delete lane**.
- [ ] Constraints snapshot reads *max N DCs (plants not counted)*; Inspector label **Max DCs (open)** (D-07).
- [ ] Reset sample for rates / BOM restores defaults without crashing.

---

## 3. Network

- [ ] Map canvas shows OpenFreeMap tiles (chrome / legend mentions OpenFreeMap unless `VITE_BASEMAP=carto`).
- [ ] Plants, DCs, demand, lanes visible; layer toggles (incl. Capacity heat, Territory) work.
- [ ] Click node / lane → Inspector updates; **Esc** clears selection; Shift+click multi-selects.
- [ ] Room tip present; empty-network empty state appears only when network is cleared.

---

## 4. Greenfield

- [ ] Adjust site count / service miles; **Generate** produces candidate DCs on map.
- [ ] Promote selected candidates → delta appears; compose into a named scenario from Scenarios (or as documented in room).

---

## 5. Hubs

- [ ] Designate hubs, auto-assign spokes (distance / volume / balanced).
- [ ] Generate hub↔spoke lanes; draft scenario with before/after KPIs without error.

---

## 6. Territory

- [ ] Assign demand to DCs/plants (distance / capacity / current lanes).
- [ ] Coverage % / gaps / overlaps render; apply preferred lanes + scenario succeeds.

---

## 7. Roadmap

- [ ] CapEx events (Y0–Y5) show on Gantt-lite; cumulative CapEx / capacity KPIs update (Y5 cumulative $29.2M).
- [ ] **Optimize timing** on the default roadmap (fresh sample) is **Optimal** in both modes: Choose timing **NPV $489.89M**, Force timeline **NPV $496.32M** on the Run model basis; basis line shows `Y0 $98.27M vs Run $98.27M — match` and a per-year breakdown table *(→ RMP-03, RMP-04)*.
- [ ] Apply a year slice as scenario; **Export to Brief** / reset sample works.

---

## 8. Scenarios

- [ ] Baseline + East Coast DC / Nearshore MX / Lean Lanes listed; activate each updates Active chrome.
- [ ] Sensitivity presets (fuel, demand, outage, tariff) apply without crash.
- [ ] Cost tornado + Monte Carlo quick-run (if exposed here) stores on Active.

---

## 9. Compare — tabs

Walk each view tab with Reference = Baseline and at least one other selected:

| Tab | Check |
|-----|--------|
| **Matrix** | KPI matrix vs Reference |
| **Map diff** | Open/close/flow marks for focus scenario |
| **Waterfall** | Cost bridge steps |
| **Cost-to-serve** | CTS rows / total |
| **DES-lite** | Run Monte Carlo → fill rate / late % on Active |
| **Sensitivity** | Tornado + MC; P10/P50/P90 |
| **Inventory** | Edit policy; Apply to Active KPIs (Inv $ / units) |
| **Resilience** | SPOF score / critical nodes → Risk KPI. Fresh Baseline @95: score **35**, critical only **Austin Plant** + **Columbus DC**; Atlanta/Reno 0 pp (D-08) |
| **Mode mix** | Mode summary for lanes |
| **Products** | Filter / mix by product group |
| **Bids** | Carrier bid compare / apply |
| **BOM** | Implied RM + echelon view |
| **Territory** | Coverage summary from territory studio |
| **Robust** | Scenario-tree optimize (expected / minimax / CVaR-lite); built-in shocks (untick chips) → opens n1, n2, n3; E **$101.14M** / worst **$122.19M** / CVaR-lite **$107.45M**; base scenario = Run $98.27M; basis note visible *(→ SCN-08)* |

- [ ] Decision log panel visible and appends on meaningful actions (optimize, apply_*, etc.).

---

## 10. Brief

- [ ] Recommended scenario + assumptions + notes editable.
- [ ] Markdown / HTML export downloads.
- [ ] Decision log / comments panels render.

---

## 11. Merge (light)

- [ ] **Load sample acquired** → 6 acquired nodes / 5 lanes, 2 conflicts (n2, l4), merged preview 14 / 14; apply merged network + draft baseline *(→ MRG-01..04)*.

---

## 12. Handoff

- [ ] Build S&OP package (`flowform.handoff.v1` shape): sites, lanes, preferred territory, CapEx years, product mix, BOM RM, inventory targets, scenarios.
- [ ] Download JSON + Markdown ops brief; no crash when payload empty then after Brief → send *(→ HND-01..04)*.

---

## 13. Map / chrome / keyboard (cross-cutting)

- [ ] **OpenFreeMap** is default basemap (no Carto key required).
- [ ] **Theme toggle** (Dark / Light) in top chrome flips `data-theme` and persists.
- [ ] **?** opens Keyboard shortcuts help; **Esc** closes help and clears map/table selection.
- [ ] Help button in chrome also opens the same dialog.
- [ ] **Run** optimize: with API up → MIP path (sample: **Optimal $98.27M**, Reno DC closed, 100% service; KPI **$98.3M −0.7 %** vs computed Baseline **$99.0M**, CO₂ **5.5 kt** *(→ RUN-02/RUN-03)*); with API down → `Heuristic v1 · service 58.8% (API offline or fallback)` (no hard hang).
- [ ] **Share** copies deep-link stub and downloads `.share.json`.

---

## 14. Platform (optional — needs Postgres)

- [ ] `docker compose up -d db` + `alembic upgrade head` succeeds; `alembic check` reports no drift *(→ PLT-01)*.
- [ ] API `AUTH_MODE=dev`, web `VITE_DEV_TENANT`/`VITE_DEV_USER` → Projects banner **Saved to your workspace** *(→ PLT-02)*.
- [ ] Stop the API, edit a project → banner warns and the edit survives; restart → the queued save drains and the version increments *(→ PLT-03/04)*.
- [ ] **Move my N local project(s) to my workspace** pushes local projects and pulls server-only ones *(→ PLT-05)*.
- [ ] Run: job chip shows `Run · queued/running %`; **Cancel** ends it as `cancelled` with no result *(→ PLT-09/10)*.
- [ ] Set Columbus capacity min 30,000 / max 1,000 → Run is blocked with a reason and fix; no scenario is created *(→ PLT-15)*.
- [ ] Projects → **Start with 4 questions** → example → Build & Run reaches a result card and Compare *(→ PLT-16)*.

---

## Pass criteria

All rooms above load without console errors that block interaction; sample import works; OpenFreeMap + theme + Esc/? behave; Compare tabs each render for the sample project; `npm run build` in `apps/web` stays green after related changes.


## Enterprise pack (Data room)

1. Open **Data** — confirm schema `enterprise-data-v1` scorecard (score, geocode, demand/lanes).
2. **Export pack JSON** — downloads `.enterprise.json`.
3. **Load stress-200** (or **Load stress-120**) — one-click fetch of `public/samples/stress-*-demand.enterprise.json` into the Active network. Same buttons exist under **Projects**.
4. Confirm scorecard: stress-200 = 212 sites · 400 demand rows · 425 lanes · score 100 (stress-120 = 132 · 240 · 265 · 100), geocode 100%.
5. **Run** optimize — chrome shows model `fixed-charge-multi-echelon-v1`, solver status, and solve seconds; MIP log mentions enterprise pack schema. stress-200: **Optimal $176.81M**, 9 open, `6 binding lane cap(s)`, solve ≈ 1 s; KPI cost **$176.8M** now includes lane fixed $0.53M (D-06) *(→ STR-03)*.
6. **Compare → Cost-to-serve** — after MIP, rows show **Service DC**, transport + variable OpEx; totals match objective transport+OpEx (gap ≈ 0).

### Stress benchmark (API)

```bash
cd apps/api && source .venv/bin/activate
pytest -q tests/test_stress_benchmark.py -s
```

Expect Optimal, open = 9, `solveSeconds` ≪ 60s on stress-120 (objective 89.1312) and stress-200 (176.8118); **3 passed**.

### Regression (defects a6d3fae + hardening pass)

```bash
cd apps/api && .venv/bin/pytest -q            # 133 passed, 4 skipped without DATABASE_URL; the 4 Postgres/RLS modules run when it is set
cd apps/web && npm run test:data && npm run build   # 8 suites (enterprise 15, CTS 2, defectFixes, sync, validation, onboarding, narrative, jobs) + build
```

- [ ] Infeasible Run with l9 removed: message starts *Root cause: facility minimum throughput…* (D-02). With l9 `capacityUnits: 1000`: min-throughput **and** *l9 (n2→n6) cap 1000 vs needed 2280 (short 1280)* (D-03).
- [ ] API `carbonPricePerTonne: 100` on the sample: `carbonM` 197.3422 = 100 × `kpis.transportCo2Tonnes` 1,973,422 / 1e6 (D-05).
- [ ] CORS: only `localhost`/`127.0.0.1` on **5180** (dev) and **5181** (preview) are allowed.

