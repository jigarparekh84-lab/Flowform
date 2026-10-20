# ADR-002: Identity provider: WorkOS

- **Status:** Accepted
- **Date:** 2026-10-19
- **Deciders:** Jigar Parekh

## Context

Self-serve, low-touch SaaS needs email/social sign-up for individuals and SAML/OIDC SSO + SCIM for enterprise buyers without a human doing the setup (§8.5). FF-106 adds OIDC login, JWT validation, tenant resolution and roles.

## Decision

Use **WorkOS** (AuthKit for sign-up/login; SSO and Directory Sync via the **self-serve Admin Portal** so customer IT configures SSO themselves). The API validates WorkOS-issued JWTs (JWKS) in middleware and maps WorkOS organizations to Flowform tenants. `AUTH_MODE=dev` bypasses the IdP for local and CI.

## Consequences

- Enterprise SSO closes async: customers get an Admin Portal link instead of a call.
- Vendor lock-in is limited to the identity layer behind an internal `auth` module; claims are mapped to our own user/tenant tables.
- Per-connection SSO pricing applies; acceptable at expected volumes.
- Jigar must create the WorkOS account, set redirect URIs, and provide `WORKOS_API_KEY` / `WORKOS_CLIENT_ID` for staging.

## Alternatives considered

- **Auth0** (capable; enterprise SSO pricing and admin UX are worse for self-serve).
- **Microsoft Entra External ID** (good for Azure shops; poor fit with AWS choice).
- **Self-hosted (Keycloak, etc.)** (too much ops for a solo maintainer).
