"""CR-010 / CR-011 — WorkOS session surfaces and hardening.

Covers the signed state nonce, the redirect allowlist, refresh/organization
switching, session logout, organization listing, and the client-claim check that
stops a token minted for another WorkOS application from being replayed here.

Needs Postgres (organizations resolve the current tenant); skipped otherwise.
"""

from __future__ import annotations

import json
import logging
import os
import time
import uuid

import pytest

if not os.environ.get("DATABASE_URL"):
    pytest.skip("DATABASE_URL not set (Postgres tests)", allow_module_level=True)

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402
from app.v1 import auth as A  # noqa: E402
from app.v1 import workos as W  # noqa: E402

from .test_auth_rbac import H, ISS, KEY, tok  # noqa: E402
from .test_projects_api import _migrated  # noqa: E402,F401

APP_REDIRECT = "https://app.flowform.test/auth/callback"
WORKOS_ISS = "https://api.workos.com"


def _token(org: str | None = "org_A", role: str | None = "owner", sub: str = "user_1",
           *, session_id: str | None = None, **kw) -> str:
    if session_id:
        kw["sid"] = session_id
    return tok(org, role, sub, iss=WORKOS_ISS, client_id="client_123", **kw)


class StubClient:
    """Records what the API asked WorkOS to do; no network."""

    def __init__(self) -> None:
        self.calls: list[tuple] = []
        self.memberships: list[dict] = []
        #: Listings may be stale; the per-org lookup answers from this set.
        self.real_memberships: list[dict] = []
        self.fail_memberships = False
        self.fail_lookups = False
        self.refresh_error: Exception | None = None

    def authorization_url(self, redirect_uri, state=None, *, organization_id=None, screen_hint=None):
        self.calls.append(("authorize", redirect_uri, state, organization_id, screen_hint))
        return f"{WORKOS_ISS}/user_management/authorize?redirect_uri={redirect_uri}&state={state}"

    def authenticate_with_code(self, code):
        self.calls.append(("code", code))
        return {
            "access_token": _token(session_id="session_1"),
            "refresh_token": "rt_1",
            "user": {"id": "user_1", "email": "a@x.test"},
            "organization_id": "org_A",
        }

    def refresh(self, refresh_token, organization_id=None):
        self.calls.append(("refresh", refresh_token, organization_id))
        if self.refresh_error:
            from fastapi import HTTPException

            raise self.refresh_error
        return {
            "access_token": _token(org=organization_id or "org_A", session_id="session_2"),
            "refresh_token": "rt_2",
            "user": {"id": "user_1"},
            "organization_id": organization_id or "org_A",
        }

    def list_memberships(self, user_id, organization_id=None):
        self.calls.append(("memberships", user_id, organization_id))
        from fastapi import HTTPException

        if organization_id is None:
            if self.fail_memberships:
                raise HTTPException(status_code=502, detail="WorkOS /organization_memberships → 500")
            return self.memberships
        if self.fail_lookups:
            raise HTTPException(status_code=502, detail="WorkOS /organization_memberships → 500")
        return [m for m in self.real_memberships if m["organization_id"] == organization_id]


@pytest.fixture()
def stub(monkeypatch):
    monkeypatch.setenv("AUTH_MODE", "workos")
    monkeypatch.setenv("WORKOS_API_KEY", "sk_test_x")
    monkeypatch.setenv("WORKOS_CLIENT_ID", "client_123")
    monkeypatch.setenv("WORKOS_REDIRECT_URI", APP_REDIRECT)
    monkeypatch.setenv("WORKOS_ALLOWED_REDIRECT_URIS", "https://staging.flowform.test/auth/callback")
    monkeypatch.setenv("WORKOS_STATE_SECRET", "state_secret_for_tests")
    monkeypatch.delenv("WORKOS_ENFORCE_CLIENT_CLAIM", raising=False)
    # Confirmations live in process memory; each test starts from a cold cache.
    W.clear_confirmations()
    s = StubClient()

    class StubJWKS:
        def get_signing_key_from_jwt(self, token):
            return type("K", (), {"key": KEY.public_key()})()

    monkeypatch.setattr(A, "_jwks_client", lambda url: StubJWKS())
    monkeypatch.setattr(W, "client", lambda: s)
    return s


def _client() -> TestClient:
    return TestClient(app)


def _state(**payload) -> str:
    body = W._b64(json.dumps({"v": 1, "n": "nonce", "r": APP_REDIRECT, **payload}).encode())
    return f"{body}.{W._sign(body)}"


# ---------------------------------------------------------------- redirects


def test_login_requires_an_allowlisted_redirect_uri(stub):
    c = _client()
    evil = c.get("/v1/auth/login", params={"redirect_uri": "https://evil.test/auth/callback"})
    assert evil.status_code == 400 and "allowlisted" in evil.json()["detail"]
    assert stub.calls == [], "no authorization URL may be built for an unlisted redirect"

    # fragments and credentials are never valid redirect targets
    assert c.get("/v1/auth/login", params={"redirect_uri": f"{APP_REDIRECT}#x"}).status_code == 400
    assert c.get("/v1/auth/login", params={"redirect_uri": "https://u:p@app.flowform.test/auth/callback"}).status_code == 400

    configured = c.get("/v1/auth/login")
    assert configured.status_code == 200 and configured.json()["state"]
    staging = c.get("/v1/auth/login", params={"redirect_uri": "https://staging.flowform.test/auth/callback"})
    assert staging.status_code == 200
    loopback = c.get("/v1/auth/login", params={"redirect_uri": "http://localhost:5180/auth/callback"})
    assert loopback.status_code == 200, loopback.text
    assert stub.calls[-1][1] == "http://localhost:5180/auth/callback"

    # A state issued for one redirect cannot be reused to authorize another.
    issued = c.get("/v1/auth/login", params={"redirect_uri": APP_REDIRECT}).json()["state"]
    crossed = c.get(
        "/v1/auth/login",
        params={"redirect_uri": "https://staging.flowform.test/auth/callback", "state": issued},
    )
    assert crossed.status_code == 400 and "state" in crossed.json()["detail"]


def test_return_to_cannot_be_an_open_redirect(stub):
    c = _client()
    for bad in ("//evil.test/x", "https://evil.test/x", "/\\evil.test", "javascript:alert(1)"):
        assert c.get("/v1/auth/login", params={"returnTo": bad}).status_code == 400, bad
    ok = c.get("/v1/auth/login", params={"returnTo": "/projects?tab=2"})
    assert ok.status_code == 200


def test_config_publishes_the_redirect_uri_and_capabilities(monkeypatch):
    monkeypatch.setenv("AUTH_MODE", "workos")
    monkeypatch.setenv("WORKOS_REDIRECT_URI", APP_REDIRECT)
    cfg = _client().get("/v1/auth/config").json()
    assert cfg["mode"] == "workos" and cfg["workosEnabled"] is False
    assert cfg["redirectUri"] == APP_REDIRECT and cfg["allowLoopbackRedirect"] is True


# ---------------------------------------------------------------- state


def test_callback_requires_a_state_we_issued(stub):
    c = _client()
    assert c.post("/v1/auth/callback", json={"code": "c", "state": ""}).status_code == 400
    assert c.post("/v1/auth/callback", json={"code": "c", "state": "nope.unsigned"}).status_code == 400
    assert stub.calls == [], "a bad state must not spend the authorization code"

    # tampered payload with the original signature
    good = _state()
    body, sig = good.split(".")
    forged = W._b64(json.dumps({"v": 1, "n": "x", "r": "https://evil.test/auth/callback", "e": int(time.time()) + 60}).encode())
    assert c.post("/v1/auth/callback", json={"code": "c", "state": f"{forged}.{sig}"}).status_code == 400

    # expired state
    assert c.post("/v1/auth/callback", json={"code": "c", "state": _state(e=int(time.time()) - 5)}).status_code == 400
    assert stub.calls == []


def test_callback_exchanges_once_and_never_caches_tokens(stub):
    c = _client()
    login = c.get("/v1/auth/login", params={"returnTo": "/projects"}).json()
    r = c.post("/v1/auth/callback", json={"code": "code_1", "state": login["state"]})
    assert r.status_code == 200, r.text
    assert r.headers["cache-control"] == "no-store"
    body = r.json()
    assert body["access_token"] and body["refresh_token"] == "rt_1"
    assert body["organization_id"] == "org_A"
    assert body["return_to"] == "/projects"
    assert 0 < body["expires_in"] <= 300
    assert [c for c in stub.calls if c[0] == "code"] == [("code", "code_1")]


def test_callback_maps_a_rejected_code_to_401(stub):
    from fastapi import HTTPException

    def reject(code):
        raise HTTPException(status_code=401, detail="sign-in could not be completed")

    stub.authenticate_with_code = reject
    c = _client()
    state = c.get("/v1/auth/login").json()["state"]
    r = c.post("/v1/auth/callback", json={"code": "bad", "state": state})
    assert r.status_code == 401
    assert r.headers["cache-control"] == "no-store"


# ---------------------------------------------------------------- refresh / orgs


def test_refresh_rotates_the_session_and_can_switch_organization(stub):
    c = _client()
    r = c.post("/v1/auth/refresh", json={"refreshToken": "rt_1", "organizationId": "org_B"})
    assert r.status_code == 200 and r.headers["cache-control"] == "no-store"
    assert r.json()["organization_id"] == "org_B"
    assert stub.calls[-1] == ("refresh", "rt_1", "org_B")

    from fastapi import HTTPException

    stub.refresh_error = HTTPException(status_code=401, detail="sign-in could not be completed")
    assert c.post("/v1/auth/refresh", json={"refreshToken": "expired"}).status_code == 401
    assert c.post("/v1/auth/refresh", json={"refreshToken": ""}).status_code == 400


def test_logout_returns_the_workos_session_url(stub):
    c = _client()
    h = H(_token(session_id="session_9"))
    r = c.post("/v1/auth/logout", json={"returnTo": "/signed-out"}, headers=h)
    assert r.status_code == 200, r.text
    url = r.json()["url"]
    assert "/user_management/sessions/logout?" in url
    assert "session_id=session_9" in url and "return_to=%2Fsigned-out" in url
    assert c.post("/v1/auth/logout", json={}).status_code == 401
    assert c.post("/v1/auth/logout", json={"returnTo": "https://evil.test/x"}, headers=h).status_code == 400


def test_organizations_lists_memberships_and_flags_the_current_one(stub):
    org = f"org_{uuid.uuid4().hex[:8]}"
    listed = [
        {"organization_id": org, "organization_name": "Acme", "status": "active", "role": {"slug": "admin"}},
        {"organization_id": "org_other", "organization_name": "Beta", "status": "active", "role": {"slug": "member"}},
        {"organization_id": "org_gone", "organization_name": "Left", "status": "inactive", "role": {"slug": "member"}},
    ]
    stub.memberships = listed
    stub.real_memberships = listed
    r = _client().get("/v1/auth/organizations", headers=H(_token(org, "admin")))
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["degraded"] is False
    by_id = {o["id"]: o for o in data["organizations"]}
    assert set(by_id) == {org, "org_other"}
    assert by_id[org]["current"] is True and by_id["org_other"]["current"] is False
    assert by_id["org_other"]["role"] == "editor"
    assert "org_gone" not in by_id
    # The current org is proven by the token; the switchable one had to be confirmed.
    assert ("memberships", "user_1", "org_other") in stub.calls
    assert ("memberships", "user_1", org) not in stub.calls


def test_organizations_never_offer_a_membership_the_provider_will_not_confirm(stub):
    """A stale listing entry must not become a switch the grant then refuses."""
    org = f"org_{uuid.uuid4().hex[:8]}"
    real = {"organization_id": org, "organization_name": "Acme", "status": "active", "role": {"slug": "owner"}}
    stub.memberships = [
        real,
        {"organization_id": "org_phantom", "organization_name": "Phantom", "status": "active", "role": {"slug": "admin"}},
    ]
    stub.real_memberships = [real]
    data = _client().get("/v1/auth/organizations", headers=H(_token(org, "owner"))).json()
    assert [o["id"] for o in data["organizations"]] == [org]
    assert data["degraded"] is False
    assert ("memberships", "user_1", "org_phantom") in stub.calls, "the entry had to be checked"


def test_organizations_hide_what_they_cannot_confirm_but_keep_the_rest(stub):
    org = f"org_{uuid.uuid4().hex[:8]}"
    stub.memberships = [
        {"organization_id": org, "organization_name": "Acme", "status": "active", "role": {"slug": "owner"}},
        {"organization_id": "org_other", "organization_name": "Beta", "status": "active", "role": {"slug": "member"}},
    ]
    stub.fail_lookups = True
    data = _client().get("/v1/auth/organizations", headers=H(_token(org, "owner"))).json()
    assert [o["id"] for o in data["organizations"]] == [org], "an unverifiable switch is not offered"
    assert data["degraded"] is True, "the client is told the list is incomplete"


def test_organizations_degrade_to_the_current_tenant(stub):
    stub.fail_memberships = True
    org = f"org_{uuid.uuid4().hex[:8]}"
    r = _client().get("/v1/auth/organizations", headers=H(_token(org, "owner")))
    assert r.status_code == 200
    data = r.json()
    assert data["degraded"] is True
    assert data["organizations"] == [{"id": org, "name": org, "role": "owner", "active": True, "current": True}]


def test_confirmed_memberships_are_cached_between_listings(stub):
    """Opening the menu twice must not cost a provider call per organization."""
    org = f"org_{uuid.uuid4().hex[:8]}"
    stub.memberships = [
        {"organization_id": org, "organization_name": "Acme", "status": "active", "role": {"slug": "owner"}},
        {"organization_id": "org_other", "organization_name": "Beta", "status": "active", "role": {"slug": "member"}},
    ]
    stub.real_memberships = list(stub.memberships)
    headers = H(_token(org, "owner"))
    c = _client()

    first = c.get("/v1/auth/organizations", headers=headers).json()
    lookups = [call for call in stub.calls if call == ("memberships", "user_1", "org_other")]
    assert len(lookups) == 1

    second = c.get("/v1/auth/organizations", headers=headers).json()
    assert second == first
    assert [call for call in stub.calls if call == ("memberships", "user_1", "org_other")] == lookups
    # The listing itself is still read fresh, and the current org is never looked up.
    assert sum(1 for call in stub.calls if call[0] == "memberships" and call[2] is None) == 2
    assert ("memberships", "user_1", org) not in stub.calls


def test_a_denied_membership_is_never_cached(stub):
    """Caching a refusal would keep a re-granted organization hidden; re-check it."""
    org = f"org_{uuid.uuid4().hex[:8]}"
    real = {"organization_id": org, "organization_name": "Acme", "status": "active", "role": {"slug": "owner"}}
    stub.memberships = [
        real,
        {"organization_id": "org_phantom", "organization_name": "Phantom", "status": "active", "role": {"slug": "admin"}},
    ]
    stub.real_memberships = [real]
    headers = H(_token(org, "owner"))
    c = _client()

    for _ in range(2):
        data = c.get("/v1/auth/organizations", headers=headers).json()
        assert [o["id"] for o in data["organizations"]] == [org]
        assert data["degraded"] is False
    assert len([call for call in stub.calls if call == ("memberships", "user_1", "org_phantom")]) == 2


def test_confirmation_cache_can_be_switched_off(stub, monkeypatch):
    monkeypatch.setenv("WORKOS_ORG_CONFIRM_CACHE_S", "0")
    org = f"org_{uuid.uuid4().hex[:8]}"
    stub.memberships = [
        {"organization_id": org, "organization_name": "Acme", "status": "active", "role": {"slug": "owner"}},
        {"organization_id": "org_other", "organization_name": "Beta", "status": "active", "role": {"slug": "member"}},
    ]
    stub.real_memberships = list(stub.memberships)
    headers = H(_token(org, "owner"))
    c = _client()

    for _ in range(2):
        assert len(c.get("/v1/auth/organizations", headers=headers).json()["organizations"]) == 2
    assert len([call for call in stub.calls if call == ("memberships", "user_1", "org_other")]) == 2
    # A malformed value falls back to the default rather than failing a request.
    monkeypatch.setenv("WORKOS_ORG_CONFIRM_CACHE_S", "nonsense")
    assert W.confirm_cache_ttl() == 60.0


# ---------------------------------------------------------------- dev auth (CR-012)


def test_dev_auth_only_accepts_local_requests(monkeypatch):
    monkeypatch.setenv("AUTH_MODE", "dev")
    monkeypatch.delenv("DEV_AUTH_ALLOW_REMOTE", raising=False)
    local = TestClient(app)
    assert local.get("/v1/projects").status_code == 200

    remote = TestClient(app, client=("203.0.113.9", 5555))
    r = remote.get("/v1/projects", headers={"X-Dev-Role": "owner"})
    assert r.status_code == 401, r.text
    assert "local" in r.json()["detail"].lower()
    assert r.headers["www-authenticate"] == "Bearer"

    # A proxy in front of the API makes a "loopback" peer meaningless.
    proxied = local.get("/v1/projects", headers={"X-Forwarded-For": "203.0.113.9"})
    assert proxied.status_code == 401
    assert local.get("/v1/projects", headers={"Forwarded": "for=203.0.113.9"}).status_code == 401

    # The explicit escape hatch is for an isolated dev container/tunnel.
    monkeypatch.setenv("DEV_AUTH_ALLOW_REMOTE", "1")
    assert remote.get("/v1/projects", headers={"X-Dev-Role": "owner"}).status_code == 200


def test_dev_auth_warning_is_exposed_and_logged(monkeypatch, caplog):
    monkeypatch.setenv("AUTH_MODE", "dev")
    monkeypatch.delenv("DEV_AUTH_ALLOW_REMOTE", raising=False)
    cfg = _client().get("/v1/auth/config").json()
    assert cfg["devAuth"] is True
    assert "AUTH_MODE=dev" in cfg["warning"]
    assert "loopback clients only" in cfg["warning"]

    with caplog.at_level(logging.WARNING, logger="flowform.api"):
        A.warn_dev_auth()
    assert any("DEV AUTH" in rec.getMessage() for rec in caplog.records)

    monkeypatch.setenv("DEV_AUTH_ALLOW_REMOTE", "1")
    assert "ANY client" in _client().get("/v1/auth/config").json()["warning"]
    caplog.clear()
    with caplog.at_level(logging.CRITICAL, logger="flowform.api"):
        A.warn_dev_auth()
    assert any("DEV AUTH EXPOSED" in rec.getMessage() for rec in caplog.records)

    monkeypatch.setenv("AUTH_MODE", "off")
    off = _client().get("/v1/auth/config").json()
    assert off["devAuth"] is False and off["warning"] is None


# ---------------------------------------------------------------- token audience


def test_tokens_for_another_workos_client_are_rejected(stub, monkeypatch):
    c = _client()
    org = f"org_{uuid.uuid4().hex[:8]}"
    assert c.get("/v1/auth/me", headers=H(_token(org))).status_code == 200

    assert c.get("/v1/auth/me", headers=H(tok(org, iss=WORKOS_ISS, client_id="client_other"))).status_code == 401
    assert c.get("/v1/auth/me", headers=H(tok(org, iss=WORKOS_ISS, azp="client_other"))).status_code == 401
    assert c.get("/v1/auth/me", headers=H(tok(org, iss=WORKOS_ISS))).status_code == 401  # claim required

    # azp alone is enough when it matches (legacy tokens), and the escape hatch exists.
    assert c.get("/v1/auth/me", headers=H(tok(org, iss=WORKOS_ISS, azp="client_123"))).status_code == 200
    monkeypatch.setenv("WORKOS_ENFORCE_CLIENT_CLAIM", "0")
    assert c.get("/v1/auth/me", headers=H(tok(org, iss=WORKOS_ISS))).status_code == 200
