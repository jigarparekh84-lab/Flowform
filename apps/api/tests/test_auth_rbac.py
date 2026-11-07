"""FF-106: JWT verification, tenant-from-claims, RBAC matrix, WorkOS adapter.
Tokens are signed locally (RSA key generated per test run). Needs DATABASE_URL."""

from __future__ import annotations

import json
import os
import time
import uuid

import pytest

if not os.environ.get("DATABASE_URL"):
    pytest.skip("DATABASE_URL not set (Postgres tests)", allow_module_level=True)

import httpx  # noqa: E402
import jwt  # noqa: E402
from cryptography.hazmat.primitives import serialization  # noqa: E402
from cryptography.hazmat.primitives.asymmetric import rsa  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402
from app.v1 import auth as A  # noqa: E402
from app.v1 import workos as W  # noqa: E402

from .test_projects_api import _migrated  # noqa: E402,F401

KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
PEM = KEY.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode()
OTHER = rsa.generate_private_key(public_exponent=65537, key_size=2048)
ISS = "https://issuer.test"


def tok(org: str | None = "org_A", role: str | None = "owner", sub: str = "user_1", *, key=KEY, iss=ISS, exp=300, **extra) -> str:
    claims = {"sub": sub, "iss": iss, "iat": int(time.time()), "exp": int(time.time()) + exp, "email": f"{sub}@x.test", **extra}
    if org:
        claims["org_id"] = org
    if role:
        claims["role"] = role
    return jwt.encode(claims, key, algorithm="RS256", headers={"kid": "k1"})


def H(t: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {t}", "Content-Type": "application/json"}


@pytest.fixture()
def c(monkeypatch):
    monkeypatch.setenv("AUTH_MODE", "jwt")
    monkeypatch.setenv("AUTH_JWT_PUBLIC_KEY", PEM)
    monkeypatch.setenv("AUTH_JWT_ISSUER", ISS)
    monkeypatch.setenv("QUEUE_BACKEND", "manual")
    from app.jobs import queue

    queue.get_queue.cache_clear()
    yield TestClient(app)
    queue.get_queue.cache_clear()


def test_rejects_missing_bad_expired_and_foreign_tokens(c):
    assert c.get("/v1/projects").status_code == 401
    assert c.get("/v1/projects").headers["www-authenticate"] == "Bearer"
    assert c.get("/v1/projects", headers=H("not-a-jwt")).status_code == 401
    assert c.get("/v1/projects", headers=H(tok(key=OTHER))).status_code == 401
    assert c.get("/v1/projects", headers=H(tok(exp=-120))).status_code == 401
    assert c.get("/v1/projects", headers=H(tok(iss="https://evil.test"))).status_code == 401
    assert c.get("/v1/projects", headers=H(tok(org=None))).status_code == 403
    assert c.get("/v1/projects", headers=H(tok())).status_code == 200


def test_tenant_comes_from_token_claims(c):
    org_a, org_b = f"org_{uuid.uuid4().hex[:8]}", f"org_{uuid.uuid4().hex[:8]}"
    pid = c.post("/v1/projects", content=b'{"name": "A"}', headers=H(tok(org_a))).json()["id"]
    assert c.get(f"/v1/projects/{pid}", headers=H(tok(org_a, role="viewer", sub="u2"))).status_code == 200
    assert c.get(f"/v1/projects/{pid}", headers=H(tok(org_b))).status_code == 404
    me = c.get("/v1/auth/me", headers=H(tok(org_a, role="member", sub="u3"))).json()
    assert me["role"] == "editor"  # WorkOS default "member" → editor
    # dev headers are ignored in jwt mode
    assert c.get("/v1/projects", headers={"X-Dev-Tenant": str(uuid.uuid4())}).status_code == 401


ALLOWED = {
    # (method, path-template) : minimum role
    ("GET", "/v1/projects"): "viewer",
    ("POST", "/v1/projects"): "editor",
    ("GET", "/v1/projects/{pid}"): "viewer",
    ("GET", "/v1/projects/{pid}/snapshot"): "viewer",
    ("PUT", "/v1/projects/{pid}"): "editor",
    ("GET", "/v1/projects/{pid}/scenarios"): "viewer",
    ("POST", "/v1/projects/{pid}/scenarios"): "editor",
    ("PUT", "/v1/projects/{pid}/scenarios/{sid}"): "editor",
    ("DELETE", "/v1/projects/{pid}/scenarios/{sid}"): "admin",
    ("GET", "/v1/projects/{pid}/runs"): "viewer",
    ("POST", "/v1/projects/{pid}/runs"): "editor",
    ("GET", "/v1/projects/{pid}/runs/{rid}"): "viewer",
    ("POST", "/v1/projects/{pid}/runs/{rid}/cancel"): "editor",
    ("DELETE", "/v1/projects/{pid}"): "admin",
}
BODIES = {
    "/v1/projects": b'{"name": "x"}', "/v1/projects/{pid}": b'{"name": "x"}',
    "/v1/projects/{pid}/scenarios": b'{"name": "s"}', "/v1/projects/{pid}/scenarios/{sid}": b'{"name": "s"}',
    "/v1/projects/{pid}/runs": json.dumps({"payload": {"network": {"nodes": [], "lanes": [], "demandVolume": {}}, "constraints": {}}}).encode(),
}


@pytest.mark.parametrize("role", A.ROLES)
def test_rbac_matrix(c, role):
    org = f"org_{uuid.uuid4().hex[:8]}"
    own = H(tok(org, "owner", "boss"))
    me = H(tok(org, role, f"u-{role}"))
    for (method, tmpl), need in ALLOWED.items():
        pid = c.post("/v1/projects", content=b'{"name": "p"}', headers=own).json()["id"]
        sid = c.post(f"/v1/projects/{pid}/scenarios", content=b'{"name": "s"}', headers=own).json()["id"]
        rid = c.post(f"/v1/projects/{pid}/runs", content=BODIES["/v1/projects/{pid}/runs"], headers=own).json()["id"]
        path = tmpl.format(pid=pid, sid=sid, rid=rid)
        r = c.request(method, path, content=BODIES.get(tmpl), headers=me)
        allowed = A.RANK[role] >= A.RANK[need]
        assert (r.status_code != 403) == allowed, (role, method, tmpl, r.status_code, r.text[:200])
        assert r.status_code < 500, (method, tmpl, r.text[:200])


def test_dev_mode_role_header(monkeypatch):
    monkeypatch.setenv("AUTH_MODE", "dev")
    c = TestClient(app)
    t = {"X-Dev-Tenant": str(uuid.uuid4()), "Content-Type": "application/json"}
    assert c.post("/v1/projects", content=b"{}", headers={**t, "X-Dev-Role": "viewer"}).status_code == 403
    assert c.post("/v1/projects", content=b"{}", headers=t).status_code == 201  # default owner


def test_workos_mode_uses_jwks_and_is_inert_without_keys(monkeypatch):
    monkeypatch.setenv("AUTH_MODE", "workos")
    monkeypatch.delenv("WORKOS_API_KEY", raising=False)
    monkeypatch.delenv("WORKOS_CLIENT_ID", raising=False)
    c = TestClient(app)
    cfg = c.get("/v1/auth/config").json()
    assert cfg["mode"] == "workos" and cfg["workosEnabled"] is False
    assert cfg["redirectUri"] is None and cfg["allowLoopbackRedirect"] is True
    assert cfg["roles"] == list(A.ROLES)
    assert c.get("/v1/projects", headers=H(tok(iss="https://api.workos.com"))).status_code == 401
    # A bad redirect is always a 400; a valid one is a 503 while WorkOS is inert.
    assert c.get("/v1/auth/login?redirect_uri=http://x").status_code == 400
    assert c.get("/v1/auth/login?redirect_uri=http://localhost:5180/auth/callback").status_code == 503

    monkeypatch.setenv("WORKOS_CLIENT_ID", "client_123")
    monkeypatch.setenv("WORKOS_API_KEY", "sk_test_x")
    assert W.workos_jwt_settings()["jwks_url"] == "https://api.workos.com/sso/jwks/client_123"

    class StubJWKS:
        def get_signing_key_from_jwt(self, token):
            assert jwt.get_unverified_header(token)["kid"] == "k1"
            return type("K", (), {"key": KEY.public_key()})()

    monkeypatch.setattr(A, "_jwks_client", lambda url: StubJWKS())
    org = f"org_{uuid.uuid4().hex[:8]}"
    t = tok(org, "admin", iss="https://api.workos.com", client_id="client_123", sid="session_1")
    assert c.get("/v1/auth/me", headers=H(t)).json()["role"] == "admin"
    assert c.get("/v1/projects", headers=H(tok(org, iss=ISS))).status_code == 401  # wrong issuer


def test_workos_client_calls_documented_endpoints():
    seen = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append((req.method, req.url.path, json.loads(req.content or b"{}"), req.headers.get("authorization")))
        if req.url.path == "/user_management/authenticate":
            return httpx.Response(200, json={"access_token": "at", "refresh_token": "rt", "user": {"id": "user_1"}, "organization_id": "org_1"})
        if req.url.path == "/portal/generate_link":
            return httpx.Response(201, json={"link": "https://setup.workos.com/portal/x"})
        return httpx.Response(201, json={"id": "org_new", "name": "Acme"})

    cl = W.WorkOSClient("sk_test_x", "client_123", http=httpx.Client(base_url="https://api.workos.com", transport=httpx.MockTransport(handler)))
    url = cl.authorization_url("http://127.0.0.1:5180/callback", "st")
    assert url.startswith("https://api.workos.com/user_management/authorize?")
    assert "provider=authkit" in url and "response_type=code" in url and "client_id=client_123" in url
    assert cl.authenticate_with_code("code_1")["organization_id"] == "org_1"
    assert seen[-1][2] == {"client_id": "client_123", "client_secret": "sk_test_x", "grant_type": "authorization_code", "code": "code_1"}
    assert cl.portal_link("org_1", "sso") == "https://setup.workos.com/portal/x"
    assert seen[-1][:2] == ("POST", "/portal/generate_link") and seen[-1][3] == "Bearer sk_test_x"
    assert cl.create_organization("Acme")["id"] == "org_new"
    with pytest.raises(Exception):
        cl.portal_link("org_1", "bogus")
