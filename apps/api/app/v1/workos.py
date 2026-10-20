"""WorkOS adapter (ADR-002) — implemented against WorkOS's documented REST API,
inert until ``WORKOS_API_KEY`` and ``WORKOS_CLIENT_ID`` are set.

* AuthKit login:  GET  https://api.workos.com/user_management/authorize
                  (client_id, redirect_uri, response_type=code, provider=authkit, state)
* Code exchange:  POST https://api.workos.com/user_management/authenticate
                  {client_id, client_secret=<API key>, grant_type=authorization_code, code}
* Refresh:        same endpoint, grant_type=refresh_token
* Access tokens:  JWT, iss https://api.workos.com, JWKS https://api.workos.com/sso/jwks/<client_id>,
                  claims sub, org_id, role, roles, permissions, sid
* Admin Portal:   POST https://api.workos.com/portal/generate_link {organization, intent}
                  (self-serve SSO / Directory Sync setup for customer IT)
* Organizations:  POST https://api.workos.com/organizations {name}
"""

from __future__ import annotations

import os
from typing import Any
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .auth import Identity, auth_mode, owner, viewer

WORKOS_API = os.environ.get("WORKOS_API_BASE", "https://api.workos.com")
PORTAL_INTENTS = {"sso", "dsync", "audit_logs", "log_streams", "domain_verification"}


def workos_config() -> dict[str, str | None]:
    return {
        "api_key": os.environ.get("WORKOS_API_KEY"),
        "client_id": os.environ.get("WORKOS_CLIENT_ID"),
        "redirect_uri": os.environ.get("WORKOS_REDIRECT_URI"),
    }


def workos_enabled() -> bool:
    c = workos_config()
    return bool(c["api_key"] and c["client_id"])


def workos_jwt_settings() -> dict[str, Any]:
    c = workos_config()
    if not c["client_id"]:
        return {}  # verify_token → "no verification key configured" → 401
    return {"jwks_url": f"{WORKOS_API}/sso/jwks/{c['client_id']}", "issuer": WORKOS_API, "audience": None}


class WorkOSClient:
    def __init__(self, api_key: str, client_id: str, *, http: httpx.Client | None = None) -> None:
        self.api_key, self.client_id = api_key, client_id
        self.http = http or httpx.Client(base_url=WORKOS_API, timeout=15)

    def _post(self, path: str, body: dict[str, Any], *, bearer: bool = True) -> dict[str, Any]:
        headers = {"Authorization": f"Bearer {self.api_key}"} if bearer else {}
        r = self.http.post(path, json=body, headers=headers)
        if r.status_code >= 400:
            raise HTTPException(status_code=502, detail=f"WorkOS {path} → {r.status_code}: {r.text[:300]}")
        return r.json()

    def authorization_url(self, redirect_uri: str, state: str | None = None, *, organization_id: str | None = None) -> str:
        q = {"client_id": self.client_id, "redirect_uri": redirect_uri, "response_type": "code", "provider": "authkit"}
        if state:
            q["state"] = state
        if organization_id:
            q["organization_id"] = organization_id
        return f"{WORKOS_API}/user_management/authorize?{urlencode(q)}"

    def authenticate_with_code(self, code: str) -> dict[str, Any]:
        return self._post("/user_management/authenticate", {
            "client_id": self.client_id, "client_secret": self.api_key,
            "grant_type": "authorization_code", "code": code,
        }, bearer=False)

    def refresh(self, refresh_token: str, organization_id: str | None = None) -> dict[str, Any]:
        body = {"client_id": self.client_id, "client_secret": self.api_key,
                "grant_type": "refresh_token", "refresh_token": refresh_token}
        if organization_id:
            body["organization_id"] = organization_id
        return self._post("/user_management/authenticate", body, bearer=False)

    def portal_link(self, organization_id: str, intent: str = "sso", return_url: str | None = None) -> str:
        if intent not in PORTAL_INTENTS:
            raise HTTPException(status_code=400, detail=f"intent must be one of {sorted(PORTAL_INTENTS)}")
        body = {"organization": organization_id, "intent": intent}
        if return_url:
            body["return_url"] = return_url
        return self._post("/portal/generate_link", body)["link"]

    def create_organization(self, name: str) -> dict[str, Any]:
        return self._post("/organizations", {"name": name})


def client() -> WorkOSClient:
    if not workos_enabled():
        raise HTTPException(status_code=503, detail="WorkOS is not configured (set WORKOS_API_KEY, WORKOS_CLIENT_ID)")
    c = workos_config()
    return WorkOSClient(c["api_key"] or "", c["client_id"] or "")


router = APIRouter(prefix="/v1/auth", tags=["auth"])


@router.get("/config")
def auth_config() -> dict[str, Any]:
    """Public: what the web client should do to sign in."""
    return {"mode": auth_mode(), "workosEnabled": workos_enabled(), "roles": ["viewer", "editor", "admin", "owner"]}


@router.get("/login")
def login(redirect_uri: str | None = None, state: str | None = None) -> dict[str, str]:
    c = workos_config()
    uri = redirect_uri or c["redirect_uri"]
    if not uri:
        raise HTTPException(status_code=400, detail="redirect_uri required")
    return {"url": client().authorization_url(uri, state)}


class CodeIn(BaseModel):
    code: str


@router.post("/callback")
def callback(body: CodeIn) -> dict[str, Any]:
    """Exchange the AuthKit code; the web keeps the access/refresh tokens."""
    r = client().authenticate_with_code(body.code)
    return {k: r.get(k) for k in ("access_token", "refresh_token", "user", "organization_id")}


class PortalIn(BaseModel):
    intent: str = "sso"
    returnUrl: str | None = None


@router.post("/admin-portal")
def admin_portal(body: PortalIn, ident: Identity = Depends(owner)) -> dict[str, str]:
    """Owner-only: self-serve SSO / directory setup link for the tenant's IT admin."""
    from sqlalchemy import select

    from ..db.models import Tenant
    from ..db.session import tenant_session

    with tenant_session(ident.tenant_id) as s:
        ext = s.execute(select(Tenant.external_id).where(Tenant.id == ident.tenant_id)).scalar_one_or_none()
    if not ext:
        raise HTTPException(status_code=409, detail="tenant has no WorkOS organization yet")
    return {"link": client().portal_link(ext, body.intent, body.returnUrl)}


@router.get("/me")
def me(ident: Identity = Depends(viewer)) -> dict[str, Any]:
    return {"tenantId": str(ident.tenant_id), "userId": str(ident.user_id), "role": ident.role, "email": ident.email}
