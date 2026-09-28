# Flowform

**Codename:** Flowform — network / footprint design studio.

Map-first studio for supply chain **network design**: greenfield footprint, scenario exploration, compare, DES-lite service simulation, and handoff to Ritara for APS / planning. **Not APS.** Flowform designs the network; Ritara runs the plan.

> No Ritara source was copied. Map-first network design studio — designs the footprint; Ritara runs the plan.

---

## Product vision

Supply chain leaders need a place to **draw and stress-test the footprint** before committing capacity, lanes, and inventory policy. Flowform is that place:

- **Map-primary** — the network is the canvas, not a sidebar afterthought.
- **Scenario-native** — diverge, name, and compare futures without leaving the map.
- **Service stress-test** — DES-lite Monte Carlo (lead-time + demand noise → fill rate / late demand %).
- **Inventory policy** — multi-echelon lite safety stock (ASCM combined or simple z·σ·√LT); Inv $ / units on Active KPIs.
- **Resilience** — SPOF scoring: nodes whose removal drops service below threshold.
- **Handoff-ready** — enriched S&OP package (sites, lanes, preferred territory, CapEx years, product mix, BOM implied RM, inventory targets, scenarios) with schema README; JSON + Markdown ops brief toward Ritara.
- **Multi-commodity** — product groups (Ambient/Chilled/Hazmat or Finished/WIP/RM) tag demand, lanes, and facility capacity; filter Network / Compare KPIs by group.
- **Lane rate tables** — carrier bids per corridor ($/unit or $/mile, transit, capacity); compare cheapest / fastest / balanced and apply onto lane cost.
- **Bill-of-materials** — FG ← components/RM with qty per unit; implied RM demand + Plant←Supplier / FG←RM echelon flows; optional inbound-lane scenario.
- **Service territory** — assign demand to DCs/plants by distance, capacity, or current lanes; coverage % within miles/lead-time; gaps/overlaps; apply preferred lanes + scenario.
- **CapEx roadmap** — multi-year (Y0–Y5) open/close/expand phasing with CapEx $ + capacity delta; Gantt-lite + cumulative KPIs; apply year slice as scenario or export into Brief.

---

## Rooms map

| Room | Role |
|------|------|
| **Projects** | Workspace home; create / rename / duplicate / delete design studies (localStorage) |
| **Network** | Map canvas — nodes, sites, lanes, capacities, constraints inspector (primary surface) |
| **Greenfield** | Blank-slate footprint design (site candidates, demand anchors) |
| **Hubs** | Hub-and-spoke design — designate hubs, auto-assign spokes, draft scenario + before/after KPIs |
| **Territory** | Service territory / coverage — assign demand to servers, gaps/overlaps, preferred lanes + scenario |
| **Roadmap** | CapEx phasing — multi-year open/close/expand events, Gantt-lite, cumulative CapEx/capacity, year-slice scenarios |
| **Scenarios** | Named what-ifs + sensitivity presets (fuel, demand shift, outage, tariff/duty) |
| **Compare** | Matrix / map-diff / waterfall / cost-to-serve / DES-lite / **Sensitivity** (tornado + MC) / **Inventory** / **Resilience** / **Products** / **Bids** / **BOM** / **Territory** |
| **Brief** | Decision Brief — recommendation, assumptions, Markdown / HTML export |
| **Data** | CSV upload (sites / demand / lanes), validation, CO₂ factors, **product / commodity groups**, **lane rate tables & bids**, **bill of materials** |
| **Merge** | M&A merge studio — import acquired network, resolve conflicts, draft merged baseline |
| **Handoff** | S&OP package: sites/lanes, preferred territory lanes, CapEx years, product mix, BOM RM, inventory targets, scenario meta — JSON + Markdown ops brief (Ritara intake stub) |

Nav serves the map. See `docs/UX_BRIEF.md` and `docs/PRODUCT_BLUEPRINT.md`.

---

## Architecture

```
Flowform/
├── README.md
├── docker-compose.yml          # web :5180 + api :5182
├── .dockerignore
├── .github/workflows/ci.yml
├── docs/
│   ├── UX_BRIEF.md
│   └── PRODUCT_BLUEPRINT.md
└── apps/
    ├── web/                    # Vite + React + TypeScript (port 5180)
    │   ├── Dockerfile
    │   └── src/                # UI, state, DES-lite, optimize client
    └── api/                    # FastAPI optimize (PuLP + HiGHS/CBC, port 5182)
        ├── Dockerfile
        ├── app/
        └── tests/              # pytest health + optimize smoke
```

| Piece | Stack | Port | Role |
|-------|-------|------|------|
| **web** | Vite, React 19, TypeScript, MapLibre GL | **5180** | Studio UI; Projects persist in localStorage; Run prefers API then heuristic |
| **api** | FastAPI, PuLP, HiGHS (highspy) / CBC | **5182** | `POST /optimize` MIP facility open/close + assignment |

> Ports are **5180 / 5182**, not 5173 (Ritara). Preview build uses 5181 locally.

When the API is down, web **Run** falls back to the client heuristic with an explicit status message.

---

## One-command Docker

Requires Docker Desktop (or Engine + Compose v2).

```bash
cd /Users/jigar/Projects/Flowform
docker compose up --build
```

| Service | URL |
|---------|-----|
| Web | http://localhost:5180 |
| API health | http://127.0.0.1:5182/health |

Stop with `Ctrl+C` or `docker compose down`.

Build args: web image bakes `VITE_API_URL=http://127.0.0.1:5182` so the browser talks to the published API port on the host.

---

## Local runbook (without Docker)

### Prerequisites

- Node.js 20+ (22 recommended) and npm
- Python 3.10+ (3.12 recommended) with venv

### 1. Optimize API (port 5182)

```bash
cd /Users/jigar/Projects/Flowform/apps/api
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --host 127.0.0.1 --port 5182
```

Health: http://127.0.0.1:5182/health  
Smoke: `pytest -q` from `apps/api` (with venv active).  
Contract details: `apps/api/README.md`.

### 2. Web (port 5180)

```bash
cd /Users/jigar/Projects/Flowform/apps/web
npm install
npm run dev
```

Open http://localhost:5180.

| Command | Purpose |
|---------|---------|
| `npm run dev` | Dev server + HMR on **5180** |
| `npm run build` | Typecheck + production build |
| `npm run preview` | Serve production build on **5181** |
| `npm run lint` | Lint (oxlint) |

Optional: `VITE_API_URL` (default `http://127.0.0.1:5182`) so **Run** can reach the API.

Basemap defaults to **OpenFreeMap** (free for commercial use, no API key). Optional Carto: set `VITE_BASEMAP=carto` and `VITE_CARTO_API_KEY` in `apps/web/.env.local` (gitignored; Carto needs `?key=`). Hard-refresh after env changes.

### DES-lite

In **Compare → DES-lite**: run Monte Carlo on the **Active** scenario (lead-time noise + demand noise → fill rate / late demand %). Results are stored on the scenario (`desLite`) and persist with the project in localStorage.

### Cost sensitivity (tornado + Monte Carlo)

In **Compare → Sensitivity** (and a quick-run panel under **Scenarios → Sensitivity presets**): shock cost drivers ±% (transport $/mi, fuel, tariff, demand volume, facility fixed, inventory holding). One-at-a-time tornado vs baseline cost KPI, plus lightweight Monte Carlo (default 300 trials) with histogram and P10/P50/P90. Results store on the scenario (`costSensitivity`). Range hints reuse fuel / tariff / demand sensitivity presets.

### Inventory & Resilience

- **Compare → Inventory** — edit per DC/plant service target, lead time, demand σ, holding cost; choose simple or ASCM combined safety stock; **Apply to Active KPIs** attaches Inv $ / units.
- **Compare → Resilience** — score SPOFs (critical nodes); score and critical list store on the Active scenario and update Risk KPI.
- **Scenarios → Tariff / duty** — sensitivity preset for inbound lanes from MX / nearshore region.
- **Compare → Sensitivity** / **Scenarios → Cost tornado + Monte Carlo** — OAT tornado on cost drivers (transport $/mi, fuel, tariff, demand, facility fixed, inventory holding) plus lightweight MC (P10/P50/P90 + histogram); results store on the Active scenario.

### Collaboration, M&A, mode mix

- **Share** (top chrome) — copies a read-only `flowform://share?…` deep-link stub and downloads a `.share.json` pack (project JSON embed).
- **Comments** — per-scenario threads (author, timestamp, body) in project localStorage; panel on **Compare** and **Brief**.
- **Merge** room — import/sample acquired network, conflict list for duplicate ids, apply merged network + draft baseline scenario.
- **Hubs** room — hub-and-spoke design: designate hubs, assign spokes by distance/volume/balanced, generate hub↔spoke lanes, draft scenario with before/after KPIs.
- **Capacity heat** — Network Layers → Capacity heat colors facilities by demand load vs capacity (green→amber→red).
- **Transport mode** — lane mode (Road/Rail/Air/Ocean/Intermodal) editable in Network Inspector; cost rescales via mode relatives; **Compare → Mode mix** summary.

---

## CI

GitHub Actions (`.github/workflows/ci.yml`):

- **web** — `npm ci` + `npm run build`
- **api** — `pip install -r requirements.txt` + `pytest` (health + optimize smoke)

---

## MVP scope (in / out)

**In:** Projects (localStorage), Network + MapLibre (+ capacity heat), Greenfield, Hubs (hub-spoke), Territory, Roadmap (CapEx), Scenarios + sensitivity (incl. tariff), Compare (DES-lite, Sensitivity tornado/MC, Inventory, Resilience, Mode mix, Products, Bids, BOM, Territory), Brief export + comments, Data CSV + CO₂ + BOM + rates, M&A Merge studio, Share stub, Handoff S&OP package (`flowform.handoff.v1`), PuLP optimize API, Docker Compose, CI.

**Out (for now):** Paid map keys, auth / multi-tenant, cloud deploy, direct Ritara API, APS / scheduling / MRP, full discrete-event simulation.

---

## Related

- **Ritara** — APS / planning (downstream handoff target). Flowform does not embed or fork Ritara.
- Prior aborted attempt **Sutra** (if present under Projects) is unrelated; leave it alone.
