# Flowform

**Codename:** Flowform — network / footprint design studio.

Map-first studio for supply chain **network design**: greenfield footprint, scenario exploration, compare, and handoff to Ritara for APS / planning. **Not APS.** Flowform designs the network; Ritara runs the plan.

> Fresh scaffold. No Ritara source was copied. Local only — do not upload or publish until intentional.

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

- App chrome (logo, project stub, Active scenario, Horizon, Run+Compare, ⌘K)
- Left IA nav: Projects · Network · Greenfield · Scenarios · Compare · Brief · Data · Handoff
- Network Canvas: KPI strip, layer rail, dark SVG map (nodes + Bezier lanes), inspector, Facilities|Lanes tables, scenario chips
- Placeholder rooms for non-Network areas
- Docs: UX brief + product blueprint
- Local Vite + React + TypeScript app on port **5180**

**Out (for now)**

- Real GIS / tile maps, solvers, optimization
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
    └── web/          # Vite + React + TypeScript
```

---

## How to run

Requires Node.js 20+ (or current LTS) and npm.

```bash
cd /Users/jigar/Projects/Flowform/apps/web
npm install
npm run dev
```

Open the URL Vite prints (typically `http://localhost:5180`).

Other scripts (from `apps/web`):

| Command | Purpose |
|---------|---------|
| `npm run dev` | Local dev server + HMR |
| `npm run build` | Typecheck + production build |
| `npm run preview` | Serve the production build |
| `npm run lint` | Lint |

---

## Related

- **Ritara** — APS / planning (downstream handoff target). Flowform does not embed or fork Ritara.
- Prior aborted attempt **Sutra** (if present under Projects) is unrelated; leave it alone.
