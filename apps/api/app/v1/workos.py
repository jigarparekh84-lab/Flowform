"""WorkOS adapter (ADR-002) — implemented against WorkOS's documented REST API,
inert until ``WORKOS_API_KEY`` and ``WORKOS_CLIENT_ID`` are set.

* AuthKit login:  GET  https://api.workos.com/user_management/authorize
                  (client_id, redirect_uri, response_type=code, provider=authkit, state)
* Code exchange:  POST https://api.workos.com/user_management/authenticate
                  {client_id, client_secret=<API key>, grant_type=authorization_code, code}
* Refresh:        same endpoint, grant_type=refresh_token (+ organization_id = switch org)
* Logout:         GET  https://api.workos.com/user_management/sessions/logout
                  (session_id from the access token's ``sid`` claim, return_to)
* Memberships:    GET  https://api.workos.com/user_management/organization_memberships?user_id=
* Access tokens:  JWT, iss https://api.workos.com, JWKS https://api.workos.com/sso/jwks/<client_id>,
                  claims sub, org_id, role, roles, permissions, sid, client_id
* Admin Portal:   POST https://api.workos.com/portal/generate_link {organization, intent}
                  (self-serve SSO / Directory Sync setup for customer IT)
* Organizations:  POST https://api.workos.com/organizations {name}

Security posture (CR-010/CR-011):

* **Redirect allowlist** — ``WORKOS_REDIRECT_URI`` plus ``WORKOS_ALLOWED_REDIRECT_URIS``
  (comma separated). Loopback redirects to ``/auth/callback`` are always allowed
  (RFC 8252 native-app rule) so local dev works; anything else is a 400.
* **State nonce** — ``/v1/auth/login`` issues an HMAC-signed, expiring state that
  binds the redirect URI (and return path). ``/v1/auth/callback`` rejects a
  missing, tampered, expired or mismatched state before spending the code.
* **Token audience** — access tokens must carry this application's ``client_id``
  (or ``azp``); a token minted for another WorkOS client is rejected. Set
  ``WORKOS_ENFORCE_CLIENT_CLAIM=0`` only if an issuer omits the claim.
* Tokens are only ever returned with ``Cache-Control: no-store``.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from typing import Any
from urllib.parse import urlencode, urlsplit

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel

from .auth import Identity, auth_mode, dev_auth_warning, normalize_role, owner, viewer

WORKOS_API = os.environ.get("WORKOS_API_BASE", "https://api.workos.com")
PORTAL_INTENTS = {"sso", "dsync", "audit_logs", "log_streams", "domain_verification"}
STATE_TTL_S = 600
_LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "[::1]", "::1"}


def workos_config() -> dict[str, str | None]:
    return {
        "api_key": os.environ.get("WORKOS_API_KEY"),
        "client_id": os.environ.get("WORKOS_CLIENT_ID"),
        "redirect_uri": os.environ.get("WORKOS_REDIRECT_URI"),
        "state_secret": os.environ.get("WORKOS_STATE_SECRET"),
    }


def workos_enabled() -> bool:
    c = workos_config()
    return bool(c["api_key"] and c["client_id"])


def _flag(name: str, default: bool = True) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() not in {"0", "false", "no", "off"}


def workos_jwt_settings() -> dict[str, Any]:
    c = workos_config()
    if not c["client_id"]:
        return {}  # verify_token → "no verification key configured" → 401
    return {
        "jwks_url": f"{WORKOS_API}/sso/jwks/{c['client_id']}",
        "issuer": WORKOS_API,
        "audience": None,
        # WorkOS session tokens carry `client_id` (and historically `azp`); there
        # is no documented `aud` claim, so the client id is the audience check.
        "client_id": c["client_id"],
        "enforce_client_claim": _flag("WORKOS_ENFORCE_CLIENT_CLAIM", True),
    }


# ---------------------------------------------------------------- redirects


def allowed_redirect_uris() -> tuple[str, ...]:
    """Explicitly configured redirect URIs (the loopback dev fallback is separate)."""
    c = workos_config()
    uris: list[str] = []
    if c["redirect_uri"]:
        uris.append(c["redirect_uri"])
    uris += [u.strip() for u in os.environ.get("WORKOS_ALLOWED_REDIRECT_URIS", "").split(",") if u.strip()]
    return tuple(uris)


def _is_loopback_redirect(uri: str) -> bool:
    """RFC 8252 loopback redirect: any port on a loopback host, /auth/callback."""
    try:
        parts = urlsplit(uri)
    except ValueError:
        return False
    return (
        parts.scheme == "http"
        and (parts.hostname or "").lower() in _LOOPBACK_HOSTS
        and parts.path.rstrip("/") == "/auth/callback"
        and not parts.query
        and not parts.fragment
    )


def validate_redirect_uri(uri: str) -> str:
    """Reject anything not on the allowlist so a stolen code cannot be sent elsewhere."""
    if not uri:
        raise HTTPException(status_code=400, detail="redirect_uri required")
    try:
        parts = urlsplit(uri)
    except ValueError:
        raise HTTPException(status_code=400, detail="redirect_uri is not a valid URL") from None
    if parts.scheme not in {"http", "https"} or not parts.netloc:
        raise HTTPException(status_code=400, detail="redirect_uri must be an absolute http(s) URL")
    if parts.fragment or parts.username or parts.password:
        raise HTTPException(status_code=400, detail="redirect_uri must not contain a fragment or credentials")
    if _is_loopback_redirect(uri):
        return uri
    for allowed in allowed_redirect_uris():
        try:
            a = urlsplit(allowed)
        except ValueError:
            continue
        if (
            parts.scheme == a.scheme
            and parts.netloc.lower() == a.netloc.lower()
            and parts.path == a.path
            and parts.query == a.query
        ):
            return uri
    raise HTTPException(
        status_code=400,
        detail="redirect_uri is not allowlisted (set WORKOS_REDIRECT_URI or WORKOS_ALLOWED_REDIRECT_URIS)",
    )


def validate_return_to(return_to: str | None) -> str | None:
    """Only same-app relative paths or origins already trusted as redirect URIs."""
    if not return_to:
        return None
    value = return_to.strip()
    if not value or any(ch in value for ch in "\r\n\t"):
        raise HTTPException(status_code=400, detail="returnTo is not a valid path")
    if value.startswith("/") and not value.startswith("//") and "\\" not in value:
        return value
    try:
        parts = urlsplit(value)
    except ValueError:
        raise HTTPException(status_code=400, detail="returnTo is not a valid URL") from None
    if parts.scheme not in {"http", "https"} or not parts.netloc:
        raise HTTPException(status_code=400, detail="returnTo must be a relative path or absolute URL")
    trusted = {urlsplit(u).netloc.lower() for u in allowed_redirect_uris() if urlsplit(u).netloc}
    if _is_loopback_redirect(f"{parts.scheme}://{parts.netloc}/auth/callback") or parts.netloc.lower() in trusted:
        return value
    raise HTTPException(status_code=400, detail="returnTo origin is not trusted")


# ---------------------------------------------------------------- signed state


def _state_secret() -> bytes:
    c = workos_config()
    secret = c["state_secret"] or c["api_key"]
    if not secret:
        raise HTTPException(status_code=503, detail="WorkOS is not configured (set WORKOS_API_KEY)")
    return secret.encode()


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _unb64(raw: str) -> bytes:
    return base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4))


def _sign(payload: str) -> str:
    return _b64(hmac.new(_state_secret(), payload.encode(), hashlib.sha256).digest())


def issue_state(redirect_uri: str, *, return_to: str | None = None, organization_id: str | None = None) -> str:
    payload = {
        "v": 1,
        "n": secrets.token_urlsafe(16),
        "r": redirect_uri,
        "e": int(time.time()) + STATE_TTL_S,
    }
    if return_to:
        payload["t"] = return_to
    if organization_id:
        payload["o"] = organization_id
    body = _b64(json.dumps(payload, separators=(",", ":")).encode())
    return f"{body}.{_sign(body)}"


def verify_state(state: str | None) -> dict[str, Any]:
    """Validate signature, expiry and shape. Never trust the payload before this."""
    if not state:
        raise HTTPException(status_code=400, detail="state required (sign in through /v1/auth/login)")
    body, _, sig = state.partition(".")
    if not body or not sig:
        raise HTTPException(status_code=400, detail="invalid state")
    if not hmac.compare_digest(_sign(body), sig):
        raise HTTPException(status_code=400, detail="invalid state")
    try:
        payload = json.loads(_unb64(body))
    except (ValueError, TypeError):
        raise HTTPException(status_code=400, detail="invalid state") from None
    if not isinstance(payload, dict) or payload.get("v") != 1:
        raise HTTPException(status_code=400, detail="invalid state")
    if int(payload.get("e") or 0) < int(time.time()):
        raise HTTPException(status_code=400, detail="state expired; sign in again")
    try:
        validate_redirect_uri(str(payload.get("r") or ""))
    except HTTPException:
        raise HTTPException(status_code=400, detail="redirect_uri is no longer allowlisted") from None
    return payload


# ---------------------------------------------------------------- client


class WorkOSClient:
    def __init__(self, api_key: str, client_id: str, *, http: httpx.Client | None = None) -> None:
        self.api_key, self.client_id = api_key, client_id
        self.http = http or httpx.Client(base_url=WORKOS_API, timeout=15)

    def _post(
        self, path: str, body: dict[str, Any], *, bearer: bool = True, auth_error: int | None = None
    ) -> dict[str, Any]:
        headers = {"Authorization": f"Bearer {self.api_key}"} if bearer else {}
        r = self.http.post(path, json=body, headers=headers)
        if r.status_code >= 400:
            # A rejected code/refresh token is the caller's credential problem (401);
            # anything else is an upstream failure (502).
            code = auth_error if auth_error and 400 <= r.status_code < 500 else 502
            raise HTTPException(
                status_code=code,
                detail=f"WorkOS {path} → {r.status_code}: {r.text[:300]}",
            )
        return r.json()

    def _get(self, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        r = self.http.get(path, params=params, headers={"Authorization": f"Bearer {self.api_key}"})
        if r.status_code >= 400:
            raise HTTPException(status_code=502, detail=f"WorkOS {path} → {r.status_code}: {r.text[:300]}")
        return r.json()

    def _authenticate(self, body: dict[str, Any]) -> dict[str, Any]:
        """Token exchange: a rejected code/refresh token is a 401, not a 502."""
        try:
            return self._post("/user_management/authenticate", body, bearer=False, auth_error=401)
        except HTTPException as e:
            if e.status_code == 401:
                raise HTTPException(status_code=401, detail="sign-in could not be completed") from None
            raise

    def authorization_url(
        self,
        redirect_uri: str,
        state: str | None = None,
        *,
        organization_id: str | None = None,
        screen_hint: str | None = None,
    ) -> str:
        q = {"client_id": self.client_id, "redirect_uri": redirect_uri, "response_type": "code", "provider": "authkit"}
        if state:
            q["state"] = state
        if organization_id:
            q["organization_id"] = organization_id
        if screen_hint in {"sign-in", "sign-up"}:
            q["screen_hint"] = screen_hint
        return f"{WORKOS_API}/user_management/authorize?{urlencode(q)}"

    def authenticate_with_code(self, code: str) -> dict[str, Any]:
        return self._authenticate({
            "client_id": self.client_id, "client_secret": self.api_key,
            "grant_type": "authorization_code", "code": code,
        })

    def refresh(self, refresh_token: str, organization_id: str | None = None) -> dict[str, Any]:
        body = {"client_id": self.client_id, "client_secret": self.api_key,
                "grant_type": "refresh_token", "refresh_token": refresh_token}
        if organization_id:
            body["organization_id"] = organization_id
        return self._authenticate(body)

    def list_memberships(self, user_id: str) -> list[dict[str, Any]]:
        """Active organizations for a user (GET /user_management/organization_memberships)."""
        data = self._get("/user_management/organization_memberships", {"user_id": user_id})
        rows = data.get("data") if isinstance(data, dict) else None
        return [r for r in (rows or []) if isinstance(r, dict)]

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


def logout_url(session_id: str | None, return_to: str | None = None) -> str | None:
    """WorkOS session logout is a browser redirect (GET, session_id + return_to)."""
    if not session_id or not workos_enabled():
        return None
    q: dict[str, str] = {"session_id": session_id}
    if return_to:
        q["return_to"] = return_to
    return f"{WORKOS_API}/user_management/sessions/logout?{urlencode(q)}"


def _expires_in(access_token: str | None) -> int | None:
    """Seconds left on the access token, so the client can schedule a refresh."""
    if not access_token:
        return None
    try:
        body = access_token.split(".")[1]
        claims = json.loads(_unb64(body))
        exp = int(claims["exp"])
    except Exception:  # noqa: BLE001 — malformed token is the caller's problem, not ours
        return None
    return max(0, exp - int(time.time()))


NO_STORE = {"Cache-Control": "no-store", "Pragma": "no-cache"}


def _session_payload(r: dict[str, Any]) -> dict[str, Any]:
    token = r.get("access_token")
    if not token:
        raise HTTPException(status_code=401, detail="sign-in could not be completed")
    return {
        "access_token": token,
        "refresh_token": r.get("refresh_token"),
        "user": r.get("user"),
        "organization_id": r.get("organization_id"),
        "expires_in": _expires_in(token),
    }


router = APIRouter(prefix="/v1/auth", tags=["auth"])


@router.get("/config")
def auth_config() -> dict[str, Any]:
    """Public: what the web client should do to sign in."""
    c = workos_config()
    warning = dev_auth_warning()
    return {
        "mode": auth_mode(),
        "workosEnabled": workos_enabled(),
        "redirectUri": c["redirect_uri"],
        "allowLoopbackRedirect": True,
        "roles": ["viewer", "editor", "admin", "owner"],
        # CR-012: the web shows this whenever a dev bypass is active.
        "devAuth": warning is not None,
        "warning": warning,
    }


@router.get("/login")
def login(
    redirect_uri: str | None = Query(default=None, alias="redirect_uri"),
    state: str | None = None,
    return_to: str | None = Query(default=None, alias="returnTo"),
    organization_id: str | None = Query(default=None, alias="organizationId"),
    screen_hint: str | None = Query(default=None, alias="screenHint"),
) -> dict[str, Any]:
    """Issue a signed state and return the AuthKit authorization URL."""
    c = workos_config()
    uri = validate_redirect_uri(redirect_uri or c["redirect_uri"] or "")
    safe_return = validate_return_to(return_to)
    # A caller-supplied state is accepted only if it is a state we signed; the
    # browser should normally let the server mint it.
    if state:
        payload = verify_state(state)
        if payload.get("r") != uri:
            raise HTTPException(status_code=400, detail="state does not belong to this redirect_uri")
        issued = state
    else:
        issued = issue_state(uri, return_to=safe_return, organization_id=organization_id)
    return {
        "url": client().authorization_url(uri, issued, organization_id=organization_id, screen_hint=screen_hint),
        "state": issued,
        "expiresIn": STATE_TTL_S,
    }


class CodeIn(BaseModel):
    code: str
    state: str


@router.post("/callback")
def callback(body: CodeIn, response: Response) -> dict[str, Any]:
    """Exchange the AuthKit code after proving the state we issued came back."""
    payload = verify_state(body.state)
    try:
        r = client().authenticate_with_code(body.code)
    except HTTPException as e:
        raise HTTPException(status_code=e.status_code, detail=e.detail, headers=NO_STORE) from None
    response.headers.update(NO_STORE)
    out = _session_payload(r)
    out["return_to"] = payload.get("t")
    return out


class RefreshIn(BaseModel):
    refreshToken: str
    organizationId: str | None = None


@router.post("/refresh")
def refresh(body: RefreshIn, response: Response) -> dict[str, Any]:
    """Rotate the session, optionally switching the active organization."""
    if not body.refreshToken:
        raise HTTPException(status_code=400, detail="refreshToken required")
    r = client().refresh(body.refreshToken, body.organizationId)
    response.headers.update(NO_STORE)
    return _session_payload(r)


class LogoutIn(BaseModel):
    returnTo: str | None = None


@router.post("/logout")
def logout(body: LogoutIn, ident: Identity = Depends(viewer)) -> dict[str, Any]:
    """End the WorkOS session (if any). The client clears its own tokens regardless."""
    return_to = validate_return_to(body.returnTo)
    return {"url": logout_url(ident.session_id, return_to)}


@router.get("/organizations")
def organizations(ident: Identity = Depends(viewer)) -> dict[str, Any]:
    """Organizations this user can switch to, with the active one flagged."""
    from sqlalchemy import select

    from ..db.models import Tenant
    from ..db.session import tenant_session

    with tenant_session(ident.tenant_id) as s:
        row = s.execute(
            select(Tenant.name, Tenant.external_id).where(Tenant.id == ident.tenant_id)
        ).first()
    name, external_id = (row[0], row[1]) if row else (str(ident.tenant_id), None)

    def current() -> list[dict[str, Any]]:
        return [{
            "id": external_id or str(ident.tenant_id),
            "name": name,
            "role": ident.role,
            "active": True,
            "current": True,
        }]

    if not (workos_enabled() and ident.subject):
        return {"organizations": current(), "degraded": False}
    try:
        memberships = client().list_memberships(ident.subject)
    except HTTPException:
        # Identity provider hiccup must not hide the workspace you are already in.
        return {"organizations": current(), "degraded": True}
    orgs = []
    for m in memberships:
        oid = str(m.get("organization_id") or "")
        if not oid or str(m.get("status") or "active") != "active":
            continue
        role = m.get("role") if isinstance(m.get("role"), dict) else {}
        orgs.append({
            "id": oid,
            "name": m.get("organization_name") or oid,
            "role": normalize_role(role.get("slug") if isinstance(role, dict) else role),
            "active": True,
            "current": oid == external_id,
        })
    return {"organizations": orgs or current(), "degraded": False}


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
    return {"link": client().portal_link(ext, body.intent, validate_return_to(body.returnUrl))}


@router.get("/me")
def me(ident: Identity = Depends(viewer)) -> dict[str, Any]:
    return {
        "tenantId": str(ident.tenant_id),
        "userId": str(ident.user_id),
        "role": ident.role,
        "email": ident.email,
        "sessionId": ident.session_id,
    }
