# ADR-006: Map tiles: Protomaps PMTiles on S3 + CloudFront, OpenFreeMap fallback

- **Status:** Accepted
- **Date:** 2026-10-19
- **Deciders:** Jigar Parekh

## Context

The web map (MapLibre) currently uses third-party tiles. Enterprise customers want no unexpected third-party requests, and we need predictable cost (FF-112).

## Decision

Serve **Protomaps PMTiles** basemaps (NA + EU extracts) from **S3 behind CloudFront**, selected by `VITE_BASEMAP=protomaps`. Keep **OpenFreeMap** as a configurable fallback (local dev and outage). Show OSM attribution.

## Consequences

- Single static files; no tile server to run; cost is storage + CDN egress.
- Extracts must be refreshed periodically (scripted).
- Requires the S3 bucket + CloudFront distribution from ADR-001/004.

## Alternatives considered

- **Mapbox / MapTiler** (paid, per-load pricing, third-party requests).
- **Self-hosted tile server** (ops burden).
- **OpenFreeMap only** (free, but third-party dependency without SLA).
