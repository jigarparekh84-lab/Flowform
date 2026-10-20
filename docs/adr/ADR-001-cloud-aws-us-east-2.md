# ADR-001: Cloud provider and first region: AWS us-east-2

- **Status:** Accepted
- **Date:** 2026-10-19
- **Deciders:** Jigar Parekh

## Context

Flowform needs one cloud for staging and production (IMPLEMENTATION_PLAN §13, FF-114). The build is solo-maintained with AI agents, so the provider must have mature managed Postgres/PostGIS, Redis, containers, object storage and a CDN, plus good Terraform coverage. First customers are North American.

## Decision

Use **AWS**, first region **us-east-2 (Ohio)**. All infrastructure is defined in Terraform under `infra/`. Secrets live in AWS Secrets Manager / SSM Parameter Store. An EU region is added later only when a customer requires EU residency.

## Consequences

- One provider, one region keeps ops and cost low.
- us-east-2 has all needed services and is usually cheaper/less congested than us-east-1.
- EU data residency is deferred; a second region is a Terraform workspace, not a redesign.
- Jigar must create the AWS account/organization and an IAM role for CI deploys (OIDC from GitHub Actions; no long-lived keys).

## Alternatives considered

- **Azure** (strong with Entra-centric enterprise buyers; weaker fit for the chosen managed-container + Terraform path for a solo maintainer).
- **GCP** (Cloud Run is attractive, but fewer customers ask for it and Memorystore/Cloud SQL PostGIS is comparable).
- **us-east-1** (largest region, but historically the most incident-prone).
