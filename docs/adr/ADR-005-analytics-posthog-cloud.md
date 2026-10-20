# ADR-005: Product analytics: PostHog Cloud

- **Status:** Accepted
- **Date:** 2026-10-19
- **Deciders:** Jigar Parekh

## Context

Low-touch growth depends on measuring activation (time-to-first-insight, funnel) without a data team (FF-109).

## Decision

Use **PostHog Cloud** (US region, aligning with us-east-2) for product events, funnels, feature flags and session replay (replay off by default, masked inputs). Events are sent through a small `apps/web/src/analytics/` wrapper; a consent banner gates non-essential tracking. No customer model data is sent as event properties.

## Consequences

- Zero infrastructure; generous free tier.
- Wrapper allows disabling or swapping vendor.
- EU customers may need PostHog EU or self-host later.
- Jigar must create the PostHog project and provide the public project key (`VITE_POSTHOG_KEY`).

## Alternatives considered

- **Self-hosted PostHog** (ops burden).
- **Amplitude / Mixpanel** (fine analytics, no feature flags in one tool, higher cost at scale).
- **GA4** (weak product analytics, privacy concerns).
