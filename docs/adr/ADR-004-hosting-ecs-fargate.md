# ADR-004: Hosting: ECS Fargate + RDS Postgres/PostGIS + ElastiCache Redis

- **Status:** Accepted
- **Date:** 2026-10-19
- **Deciders:** Jigar Parekh

## Context

Need to host web, API, solver worker, Postgres with PostGIS and Redis with minimal ops for one maintainer.

## Decision

Run containers on **ECS Fargate** (services: api, worker; web as static assets on S3 + CloudFront). Database is **RDS for PostgreSQL** with the **PostGIS** extension. Queue/cache is **ElastiCache for Redis**. **No Kubernetes.** Defined in Terraform.

## Consequences

- No cluster nodes to patch; per-task scaling for solver workers (sized e.g. 8 vCPU / 32 GB).
- Managed backups/PITR on RDS.
- Fargate has a max task size; XXL solves may later need EC2-backed capacity providers (same ECS API).
- Local dev mirrors this with docker-compose (Postgres/PostGIS, Redis).

## Alternatives considered

- **EKS/Kubernetes** (powerful, but disproportionate ops burden).
- **App Runner** (simpler, but limited for long-running workers).
- **Heroku/Render/Fly** (fast start, but split from AWS data services and weaker enterprise posture).
