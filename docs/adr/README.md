# Architecture Decision Records

Decisions recorded per FF-119 (docs/IMPLEMENTATION_PLAN.md §13). New ADRs: copy the structure (Status, Date, Context, Decision, Consequences, Alternatives), number sequentially, never rewrite an accepted ADR — supersede it.

| ADR | Title | Status | Date |
|---|---|---|---|
| [ADR-001](ADR-001-cloud-aws-us-east-2.md) | Cloud provider and first region: AWS us-east-2 | Accepted | 2026-10-19 |
| [ADR-002](ADR-002-auth-workos.md) | Identity provider: WorkOS | Accepted | 2026-10-19 |
| [ADR-003](ADR-003-jobs-redis-arq.md) | Background jobs: Redis + Arq behind a thin queue interface | Accepted | 2026-10-19 |
| [ADR-004](ADR-004-hosting-ecs-fargate.md) | Hosting: ECS Fargate + RDS Postgres/PostGIS + ElastiCache Redis | Accepted | 2026-10-19 |
| [ADR-005](ADR-005-analytics-posthog-cloud.md) | Product analytics: PostHog Cloud | Accepted | 2026-10-19 |
| [ADR-006](ADR-006-map-tiles-protomaps.md) | Map tiles: Protomaps PMTiles on S3 + CloudFront, OpenFreeMap fallback | Accepted | 2026-10-19 |
| [ADR-007](ADR-007-solver-adapter-pulp-highs.md) | Solver layer: PuLP + HiGHS behind an adapter | Accepted | 2026-10-19 |
