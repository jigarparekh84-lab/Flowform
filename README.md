# Flowform

**Codename:** Flowform — network / footprint design studio.

Map-first studio for supply chain **network design**: greenfield footprint, scenario exploration, compare, and handoff to Ritara for APS / planning. **Not APS.** Flowform designs the network; Ritara runs the plan.

> No Ritara source was copied. Map-first network design studio — designs the footprint; Ritara runs the plan.

---

## Vision

Supply chain leaders need a place to **draw and stress-test the footprint** before committing capacity, lanes, and inventory policy. Flowform is that place:

- **Map-primary** — the network is the canvas, not a sidebar afterthought.
- **Scenario-native** — diverge, name, and compare futures without leaving the map.
- **Handoff-ready** — export a clean brief of nodes, lanes, and assumptions into Ritara when design is done.

---

## Information architecture

| Area | Role |
|------|------|
| **Projects** | Workspace home; open / create network design projects |
| **Network** | Map canvas — nodes, sites, lanes, capacities (primary surface) |
| **Greenfield** | Blank-slate footprint design (site candidates, demand anchors) |
| **Scenarios** | Named what-ifs branched from a baseline network |
| **Compare** | Side-by-side / overlay of scenario cost, service, risk |
| **Brief** | Narrative + assumptions package for stakeholders |
| **Data** | Imports, reference tables, validation |
| **Handoff** | Export / sync design payload toward Ritara (APS) |

Nav should serve the map, not compete with it. See `docs/UX_BRIEF.md`.

---

## MVP scope

**In**

- App chrome (logo → **Projects**, Active scenario, Horizon, **Run** + Compare, theme toggle, ⌘K)
- Left IA nav: Projects · Network · Greenfield · Scenarios · Compare · Brief · Data · Handoff
- **Projects room**: create / rename / duplicate / delete design studies; full state in localStorage; export / import JSON
- Network Canvas: interactive map selection synced to inspector + tables; uses uploaded or sample data
- **MapLibre GL** basemap (free Carto/OSM raster tiles, dark+light) with SVG schematic fallback
- **Data room**: CSV upload (sites / demand / lanes), templates, validation (required columns, geocode %, baseline reconcile), load into map; **CO₂ emission factors** table
- **Candidates & constraints** in Network inspector: open/close/candidate, capacity bands, service target %, CapEx budget, max facilities
- **Run optimize**: prefers **apps/api** PuLP MIP (HiGHS/CBC) when reachable; else client **heuristic v1** with clear status
- Greenfield Studio + Scenarios library (compose + **sensitivity presets**: fuel +20%, demand shift, node outage) + Compare (matrix / map-diff / waterfall / **cost-to-serve**)
- **Decision Brief**: recommendation banner, scenario cards vs Reference, assumptions checklist, **Markdown / printable HTML export**, Send to Handoff
- Handoff room: receives brief JSON stub for Ritara intake (contract only)
- Shared React context for projects / network / constraints / scenarios / optimize / brief / emissions
- Docs: UX brief + product blueprint
- Local Vite + React + TypeScript app on port **5180**; Optimize API on **5182**

**Out (for now)**

- Paid map API keys
- Auth, multi-tenant, cloud deploy
- Direct Ritara API integration (handoff is design-only stub)
- APS / scheduling / MRP — that stays in Ritara

---

## Repo layout

```
Flowform/
├── README.md
├── .gitignore
├── docs/
│   ├── UX_BRIEF.md
│   └── PRODUCT_BLUEPRINT.md
└── apps/
    ├── web/          # Vite + React + TypeScript (port 5180)
    └── api/          # FastAPI optimize (PuLP + HiGHS/CBC, port 5182)
```

---

## How to run

### Web (port 5180)

Requires Node.js 20+ (or current LTS) and npm.

```bash
cd /Users/jigar/Projects/Flowform/apps/web
npm install
npm run dev
```

Open `http://localhost:5180`.

| Command | Purpose |
|---------|---------|
| `npm run dev` | Local dev server + HMR |
| `npm run build` | Typecheck + production build |
| `npm run preview` | Serve the production build |
| `npm run lint` | Lint |

Optional: set `VITE_API_URL` (default `http://127.0.0.1:5182`) so **Run** can reach the API.

### Optimize API (port 5182)

Requires Python 3.10+ with venv.

```bash
cd /Users/jigar/Projects/Flowform/apps/api
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --host 127.0.0.1 --port 5182
```

See `apps/api/README.md` for `POST /optimize` contract and smoke curls.
When the API is down, web **Run** falls back to the client heuristic with an explicit status message.

---

## Related

- **Ritara** — APS / planning (downstream handoff target). Flowform does not embed or fork Ritara.
- Prior aborted attempt **Sutra** (if present under Projects) is unrelated; leave it alone.
