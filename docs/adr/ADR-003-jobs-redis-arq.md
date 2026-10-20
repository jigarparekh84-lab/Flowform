# ADR-003: Background jobs: Redis + Arq behind a thin queue interface

- **Status:** Accepted
- **Date:** 2026-10-19
- **Deciders:** Jigar Parekh

## Context

All solver endpoints are synchronous today. Large solves, explain counterfactuals, roadmap and robust runs need async jobs with progress and cancel (FF-105).

## Decision

Use **Redis + Arq** (asyncio Python worker). Application code depends only on a thin internal interface (`enqueue(kind, payload) -> run_id`, `status(run_id)`, `cancel(run_id)`, progress events) so the backend can be swapped (e.g. SQS, Celery) without touching endpoints. Run state of record lives in Postgres (`runs` table); Redis is transport only.

## Consequences

- Minimal moving parts; the same Redis serves cache and SSE pub/sub.
- Arq is small and Python-native; the interface protects us if it is outgrown.
- Redis loss can drop queued jobs; runs are re-queueable from Postgres.
- Sync endpoints remain unchanged.

## Alternatives considered

- **Celery** (heavier, more config).
- **AWS SQS + Lambda/ECS** (more AWS-specific glue; harder to run locally).
- **Temporal** (excellent durability, too much infrastructure for v1).
