# Flowform — product blueprint (MVP)

## One-liner

Map-first studio to design and compare supply chain network footprints, then hand a brief to Ritara for APS.

## Problem

Network / footprint decisions (where to put plants, DCs, suppliers; which lanes; which service radii) are often trapped in spreadsheets or buried inside planning tools. Teams need a **design** surface before they optimize a plan.

## Solution (MVP)

A local web app where a planner can:

1. Open a **Project** and land on the **Network** canvas  
2. Sketch or load a footprint (**Greenfield** mode supported as empty canvas + stubs)  
3. Branch **Scenarios** and **Compare** deltas at a conceptual level  
4. Capture a **Brief** and prepare **Handoff** toward Ritara  

No solver, no live GIS tiles, no Ritara API in MVP — placeholders and IA only.

## Personas

- Supply chain network designer / footprint lead  
- Ops strategy / IBP partner reviewing options  
- (Downstream) Ritara planner receiving a design brief  

## IA (product areas)

Projects · Network · Greenfield · Scenarios · Compare · Brief · Data · Handoff  

## MVP deliverables

| Deliverable | Status target |
|-------------|---------------|
| Repo scaffold (Vite + React + TS) | Done in this repo |
| Network Canvas page titled **Flowform** | Done (placeholder UI) |
| IA stubs for all product areas | Done (nav chrome) |
| UX brief + this blueprint | Done |
| Real map engine / data model / export | Post-MVP |

## Non-goals

- APS, MRP, scheduling, execution  
- Copying or embedding Ritara source  
- Publishing / deploying this scaffold  
- Multi-user auth  

## Success metrics (later)

- Time to first named scenario from empty project  
- Ability to export a handoff package Ritara can ingest  
- Qualitative: “this feels like design, not another planner”

## Tech (MVP)

- `apps/web` — Vite, React, TypeScript  
- Docs in `/docs`  
- Local git only; no remote required for scaffold  

## Sequenced next (post-scaffold)

1. Lightweight network JSON model (nodes, lanes, scenario diffs)  
2. Map library choice (e.g. MapLibre) behind the canvas  
3. Scenario compare UX  
4. Handoff schema aligned with Ritara intake (contract only — no source copy)  
