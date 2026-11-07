"""Request identity + RBAC for /v1 (FF-106).

``AUTH_MODE``:
  * ``dev``    — local/CI bypass: ``X-Dev-Tenant`` (UUID), ``X-Dev-User`` (email),
                 ``X-Dev-Role`` (owner|admin|editor|viewer, default owner).
                 **Local only** (CR-012): the socket peer must be loopback (or an
                 in-process test client) and the request must not arrive through a
                 proxy, because these headers are trivially forged. A startup
                 warning and ``/v1/auth/config.warning`` keep it visible.
                 ``DEV_AUTH_ALLOW_REMOTE=1`` is the explicit escape hatch for a
                 deliberate container/tunnel setup where the port is already
                 loopback-bound.
  * ``jwt``    — verify a Bearer JWT (RS256/ES256 via ``AUTH_JWKS_URL`` or
                 ``AUTH_JWT_PUBLIC_KEY``; HS256 via ``AUTH_JWT_SECRET`` for tests).
                 ``AUTH_JWT_ISSUER`` / ``AUTH_JWT_AUDIENCE`` are enforced when set.
  * ``workos`` — ``jwt`` preconfigured for WorkOS AuthKit access tokens
                 (JWKS ``https://api.workos.com/sso/jwks/<WORKOS_CLIENT_ID>``,
                 issuer ``https://api.workos.com``). Disabled until keys exist.
  * anything else — every /v1 call is 401.

Claims → identity: tenant = ``org_id`` (WorkOS organization; also
``tenant_id``/``tid``), user = ``sub``, role = ``role`` (or first of ``roles``).
Tenants and users are provisioned on first sight (self-serve).

WorkOS tokens are additionally checked against this application's
``WORKOS_CLIENT_ID``: the ``client_id`` (or ``azp``) claim must match, so a
session minted for a different WorkOS client cannot be replayed here. There is
no documented ``aud`` claim for AuthKit access tokens, so the client id is the
audience check (``WORKOS_ENFORCE_CLIENT_CLAIM=0`` relaxes it).
"""

from __future__ import annotations

import logging
import os
import uuid
from dataclasses import dataclass
from functools import lru_cache
from typing import Any, Callable

from fastapi import Depends, Header, HTTPException, Request
from sqlalchemy import select

from ..db.models import Tenant, User
from ..db.session import admin_session

DEV_TENANT = uuid.UUID("00000000-0000-0000-0000-00000000d001")
DEV_NS = uuid.UUID("6f6c6f77-666f-726d-0000-000000000000")

ROLES = ("viewer", "editor", "admin", "owner")
RANK = {r: i for i, r in enumerate(ROLES)}
#: WorkOS default role slug "member" maps to editor; unknown roles get viewer.
ROLE_ALIASES = {"member": "editor", "modeler": "editor"}


@dataclass(frozen=True)
class Identity:
    tenant_id: uuid.UUID
    user_id: uuid.UUID
    role: str
    email: str | None = None
    subject: str | None = None
    #: WorkOS session id (``sid`` claim) — needed to revoke the session on logout.
    session_id: str | None = None

    def can(self, role: str) -> bool:
        return RANK.get(self.role, -1) >= RANK[role]


def auth_mode() -> str:
    return os.environ.get("AUTH_MODE", "off").lower()


# ---------------------------------------------------------------- dev-mode guard

#: Peers that are the same machine (or the in-process test transport).
LOCAL_PEERS = {"127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost", "testclient"}
#: If any of these is present the request came through a proxy, so the socket
#: peer is the proxy — not the client — and dev headers must not be trusted.
PROXY_HEADERS = ("x-forwarded-for", "forwarded", "x-real-ip", "x-forwarded-host", "cf-connecting-ip")


def dev_auth_allow_remote() -> bool:
    return os.environ.get("DEV_AUTH_ALLOW_REMOTE", "").strip().lower() in {"1", "true", "yes", "on"}


def is_local_request(request: Request) -> bool:
    """True when accepting the dev bypass cannot expose a shared deployment."""
    if dev_auth_allow_remote():
        return True
    if any(h in request.headers for h in PROXY_HEADERS):
        return False
    host = (request.client.host if request.client else "") or ""
    return host in LOCAL_PEERS


def dev_auth_warning() -> str | None:
    """Loud, user-visible description of the active dev bypass (None otherwise)."""
    if auth_mode() != "dev":
        return None
    scope = (
        "ANY client that can reach this port (DEV_AUTH_ALLOW_REMOTE=1)"
        if dev_auth_allow_remote()
        else "loopback clients only"
    )
    return (
        f"AUTH_MODE=dev is a header-based authentication bypass ({scope}). "
        "X-Dev-Role defaults to owner and X-Dev-Tenant picks the workspace, so "
        "this must only run on a developer machine. Set AUTH_MODE=workos or jwt "
        "for any shared deployment."
    )


def warn_dev_auth(logger: logging.Logger | None = None) -> None:
    """Call once at startup so an exposed dev bypass is impossible to miss."""
    msg = dev_auth_warning()
    if not msg:
        return
    log = logger or logging.getLogger("flowform.api")
    if dev_auth_allow_remote():
        log.critical("DEV AUTH EXPOSED — %s", msg)
    else:
        log.warning("DEV AUTH — %s", msg)


def normalize_role(raw: Any) -> str:
    r = str(raw or "").strip().lower()
    r = ROLE_ALIASES.get(r, r)
    return r if r in RANK else "viewer"


# ---------------------------------------------------------------- provisioning


def _provision(tenant_key: str, *, by_external: bool, email: str | None, subject: str,
               role: str | None) -> tuple[uuid.UUID, uuid.UUID, str]:
    with admin_session() as s:
        if by_external:
            t = s.execute(select(Tenant).where(Tenant.external_id == tenant_key)).scalar_one_or_none()
            if t is None:
                t = Tenant(id=uuid.uuid5(DEV_NS, f"ext:{tenant_key}"), name=tenant_key, external_id=tenant_key)
                s.add(t)
                s.flush()
        else:
            tid = uuid.UUID(tenant_key)
            t = s.get(Tenant, tid)
            if t is None:
                t = Tenant(id=tid, name=f"Dev tenant {str(tid)[:8]}")
                s.add(t)
                s.flush()
        uid = uuid.uuid5(DEV_NS, f"{t.id}:{subject}")
        u = s.get(User, uid)
        if u is None:
            first = s.execute(select(User.id).where(User.tenant_id == t.id).limit(1)).first() is None
            u = User(id=uid, tenant_id=t.id, email=(email or subject)[:320], external_id=subject,
                     role=role or ("owner" if first else "viewer"))
            s.add(u)
        elif role and u.role != role:
            u.role = role  # IdP is the source of truth for roles when it sends one
        return t.id, u.id, role or u.role


# ---------------------------------------------------------------- JWT


class TokenError(Exception):
    pass


@lru_cache(maxsize=8)
def _jwks_client(url: str):
    import jwt

    return jwt.PyJWKClient(url, cache_keys=True, lifespan=3600)


def jwt_settings() -> dict[str, Any]:
    if auth_mode() == "workos":
        from .workos import workos_jwt_settings

        return workos_jwt_settings()
    return {
        "jwks_url": os.environ.get("AUTH_JWKS_URL"),
        "public_key": os.environ.get("AUTH_JWT_PUBLIC_KEY"),
        "secret": os.environ.get("AUTH_JWT_SECRET"),
        "issuer": os.environ.get("AUTH_JWT_ISSUER"),
        "audience": os.environ.get("AUTH_JWT_AUDIENCE"),
    }


def verify_token(token: str, settings: dict[str, Any] | None = None) -> dict[str, Any]:
    import jwt
    from jwt.types import Options

    cfg = settings or jwt_settings()
    try:
        if cfg.get("jwks_url"):
            key: Any = _jwks_client(cfg["jwks_url"]).get_signing_key_from_jwt(token).key
            algs = ["RS256", "ES256"]
        elif cfg.get("public_key"):
            key, algs = cfg["public_key"], ["RS256", "ES256"]
        elif cfg.get("secret"):
            key, algs = cfg["secret"], ["HS256"]
        else:
            raise TokenError("no verification key configured")
        opts: Options = {"require": ["exp", "sub"], "verify_aud": bool(cfg.get("audience"))}
        claims = jwt.decode(token, key, algorithms=algs, issuer=cfg.get("issuer") or None,
                            audience=cfg.get("audience") or None, options=opts, leeway=30)
    except TokenError:
        raise
    except Exception as e:  # jwt.PyJWTError and key fetch errors
        raise TokenError(str(e)) from e
    _check_client_claim(claims, cfg)
    return claims


def _check_client_claim(claims: dict[str, Any], cfg: dict[str, Any]) -> None:
    """The token must have been minted for *this* WorkOS application."""
    cid = cfg.get("client_id")
    if not cid or not cfg.get("enforce_client_claim"):
        return
    azp = claims.get("azp")
    if azp and azp != cid:
        raise TokenError("token authorized party does not match this application")
    if claims.get("client_id") != cid and azp != cid:
        raise TokenError("token was issued for a different client")


def identity_from_claims(claims: dict[str, Any]) -> Identity:
    org = claims.get("org_id") or claims.get("tenant_id") or claims.get("tid")
    if not org:
        raise HTTPException(status_code=403, detail="token has no organization (org_id)")
    raw_role = claims.get("role") or (claims.get("roles") or [None])[0]
    role = normalize_role(raw_role) if raw_role else None
    tid, uid, eff = _provision(str(org), by_external=True, email=claims.get("email"),
                               subject=str(claims["sub"]), role=role)
    sid = claims.get("sid")
    return Identity(
        tenant_id=tid, user_id=uid, role=eff, email=claims.get("email"),
        subject=str(claims["sub"]), session_id=str(sid) if sid else None,
    )


# ---------------------------------------------------------------- dependencies


def current_identity(
    request: Request,
    x_dev_tenant: str | None = Header(default=None),
    x_dev_user: str | None = Header(default=None),
    x_dev_role: str | None = Header(default=None),
) -> Identity:
    mode = auth_mode()
    if mode == "dev":
        if not is_local_request(request):
            raise HTTPException(
                status_code=401,
                detail=(
                    "AUTH_MODE=dev only accepts local requests; use a real identity "
                    "provider for a shared deployment (DEV_AUTH_ALLOW_REMOTE=1 "
                    "overrides this for an isolated dev container)"
                ),
                headers={"WWW-Authenticate": "Bearer"},
            )
        try:
            tenant_id = uuid.UUID(x_dev_tenant) if x_dev_tenant else DEV_TENANT
        except ValueError:
            raise HTTPException(status_code=400, detail="X-Dev-Tenant must be a UUID")
        email = (x_dev_user or "dev@flowform.local").strip().lower()
        role = normalize_role(x_dev_role) if x_dev_role else "owner"
        tid, uid, _ = _provision(str(tenant_id), by_external=False, email=email, subject=email, role=None)
        return Identity(tenant_id=tid, user_id=uid, role=role, email=email, subject=email)
    if mode in ("jwt", "workos"):
        authz = request.headers.get("authorization") or ""
        if not authz.lower().startswith("bearer "):
            raise HTTPException(status_code=401, detail="bearer token required",
                                headers={"WWW-Authenticate": "Bearer"})
        try:
            claims = verify_token(authz[7:].strip())
        except TokenError as e:
            raise HTTPException(status_code=401, detail=f"invalid token: {e}",
                                headers={"WWW-Authenticate": "Bearer"}) from e
        return identity_from_claims(claims)
    raise HTTPException(status_code=401, detail="authentication required")


def require(role: str) -> Callable[..., Identity]:
    """FastAPI dependency: caller must hold ``role`` or higher."""
    assert role in RANK

    def dep(ident: Identity = Depends(current_identity)) -> Identity:
        if not ident.can(role):
            raise HTTPException(status_code=403, detail=f"requires role {role} (you are {ident.role})")
        return ident

    dep.__name__ = f"require_{role}"
    return dep


# Route policy (documented matrix; tests/test_auth_rbac.py enforces it):
#   viewer  — read projects, scenarios, runs, snapshots, run events
#   editor  — + create/update projects & scenarios, start and cancel runs
#   admin   — + delete projects & scenarios
#   owner   — everything (billing / tenant settings later)
viewer = require("viewer")
editor = require("editor")
admin = require("admin")
owner = require("owner")
