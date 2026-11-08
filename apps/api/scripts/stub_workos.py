#!/usr/bin/env python3
"""Stand-in WorkOS API for the Playwright identity round trip (CR-032).

``apps/web/playwright.auth.config.ts`` boots this on loopback and points the API
at it with ``WORKOS_API_BASE``. The API is *not* mocked: it mints a real signed
state, the browser really leaves for ``/user_management/authorize``, really comes
back to ``/auth/callback``, and the code is exchanged and verified (RS256 + JWKS)
by the same code a WorkOS tenant drives. Only the identity provider is local.

Implemented surface — the subset ``app/v1/workos.py`` documents:

* ``GET  /user_management/authorize``                 → 302 back with ``code``/``state``
  (no login form: this stands for an already-authenticated AuthKit session)
* ``POST /user_management/authenticate``              → ``authorization_code`` and
  ``refresh_token`` grants; a code is single-use, a refresh token is rotated,
  and a grant naming an organization the user has no active membership in is
  refused (the refresh token is not spent by the rejected grant)
* ``GET  /sso/jwks/<client_id>``                      → the public half of the signing key
* ``GET  /user_management/organization_memberships``  → the user's organizations;
  with ``organization_id`` the authoritative single-membership lookup the API uses
  to confirm a listing entry
* ``GET  /user_management/sessions/logout``           → 302 to ``return_to``
* ``GET  /_stub/state`` / ``POST /_stub/reset``       → what the tests assert on
* ``POST /_stub/advertise-phantom``                   → make the membership listing
  stale (advertise an org the token grant will refuse)
* ``POST /_stub/revoke``                              → drop a membership after a
  listing was read (the listing/grant race)

Usage::

    python scripts/stub_workos.py --port 5194 \\
        --public-url http://127.0.0.1:5194 --app-url http://127.0.0.1:5190
"""

from __future__ import annotations

import argparse
import json
import secrets
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlencode, urlsplit

import jwt
from cryptography.hazmat.primitives.asymmetric import rsa
from jwt.algorithms import RSAAlgorithm

KID = "e2e-signing-key"
ACCESS_TOKEN_TTL_S = 300
DEFAULT_ORG = "org_e2e_acme"
#: The membership set a token can be minted for, and the role a token minted for
#: that organization carries — the app maps WorkOS' `member` slug to editor, so an
#: organization switch visibly changes the role as well as the tenant. Each run
#: keeps its own copy (`StubState.memberships`) so a test can revoke one mid-flight.
MEMBERSHIPS: tuple[dict[str, Any], ...] = (
    {
        "organization_id": DEFAULT_ORG,
        "organization_name": "Acme Distribution",
        "status": "active",
        "role": {"slug": "owner"},
    },
    {
        "organization_id": "org_e2e_beta",
        "organization_name": "Beta Logistics",
        "status": "active",
        "role": {"slug": "member"},
    },
    {
        "organization_id": "org_e2e_gone",
        "organization_name": "Former Employer",
        "status": "inactive",
        "role": {"slug": "member"},
    },
)
#: A membership the listing can be made to advertise while the token grant refuses
#: it — a stale list entry the API cannot verify, which is how a visitor could be
#: offered a switch into a workspace they no longer belong to.
PHANTOM_ORG = {
    "organization_id": "org_e2e_phantom",
    "organization_name": "Phantom Holdings",
    "status": "active",
    "role": {"slug": "admin"},
}


class StubState:
    """Codes, tokens and counters shared by the request threads."""

    def __init__(self, *, client_id: str, public_url: str, app_url: str, email: str) -> None:
        self.client_id = client_id
        self.public_url = public_url.rstrip("/")
        self.app_url = app_url.rstrip("/")
        self.email = email
        self.subject = "user_e2e_owner"
        # PyJWT only exposes JWK conversion; the key itself comes from cryptography.
        self.private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        self.lock = threading.Lock()
        self.codes: dict[str, dict[str, Any]] = {}
        self.refresh_tokens: set[str] = set()
        self.memberships: list[dict[str, Any]] = [dict(m) for m in MEMBERSHIPS]
        #: `organization_id` values the API looked up one at a time.
        self.lookups: list[str] = []
        self.revocations: list[str] = []
        self.authorizations: list[dict[str, Any]] = []
        self.exchanges: list[dict[str, Any]] = []
        self.refreshes: list[dict[str, Any]] = []
        self.refusals: list[dict[str, Any]] = []
        self.logouts: list[dict[str, Any]] = []
        #: When true, `/organization_memberships` also lists PHANTOM_ORG.
        self.phantom = False

    def jwks(self) -> dict[str, Any]:
        jwk = json.loads(RSAAlgorithm.to_jwk(self.private_key.public_key()))
        jwk.update({"kid": KID, "use": "sig", "alg": "RS256"})
        return {"keys": [jwk]}

    def active_org_ids(self) -> set[str]:
        """Organizations a token can actually be minted for — the grant allowlist."""
        return {str(m["organization_id"]) for m in self.memberships if m["status"] == "active"}

    def role_for(self, organization_id: str) -> str:
        for m in self.memberships:
            if m["organization_id"] == organization_id:
                return str(m["role"]["slug"])
        return "member"

    def revoke(self, organization_id: str) -> None:
        """Drop a membership between a listing and the switch that follows it."""
        with self.lock:
            self.memberships = [m for m in self.memberships if m["organization_id"] != organization_id]
            self.revocations.append(organization_id)

    def mint(self, *, session_id: str, organization_id: str) -> dict[str, Any]:
        """An access token the API can verify, plus a rotatable refresh token."""
        now = int(time.time())
        claims = {
            "iss": self.public_url,
            "sub": self.subject,
            "email": self.email,
            "org_id": organization_id,
            # The role travels with the organization, exactly as WorkOS scopes it.
            "role": self.role_for(organization_id),
            "sid": session_id,
            "client_id": self.client_id,
            "iat": now,
            "exp": now + ACCESS_TOKEN_TTL_S,
            "jti": secrets.token_hex(8),
        }
        access_token = jwt.encode(claims, self.private_key, algorithm="RS256", headers={"kid": KID})
        refresh_token = f"rt_{secrets.token_urlsafe(18)}"
        with self.lock:
            self.refresh_tokens.add(refresh_token)
        return {
            "access_token": access_token,
            "refresh_token": refresh_token,
            "user": {"id": self.subject, "email": self.email, "first_name": "Ada", "last_name": "Owner"},
            "organization_id": organization_id,
        }

    def snapshot(self) -> dict[str, Any]:
        with self.lock:
            return {
                "authorizations": list(self.authorizations),
                "exchanges": list(self.exchanges),
                "refreshes": list(self.refreshes),
                "refusals": list(self.refusals),
                "lookups": list(self.lookups),
                "revocations": list(self.revocations),
                "logouts": list(self.logouts),
                "codes_issued": len(self.codes),
            }

    def reset(self) -> None:
        with self.lock:
            self.codes.clear()
            self.refresh_tokens.clear()
            self.authorizations.clear()
            self.exchanges.clear()
            self.refreshes.clear()
            self.refusals.clear()
            self.logouts.clear()
            self.lookups.clear()
            self.revocations.clear()
            self.memberships = [dict(m) for m in MEMBERSHIPS]
            self.phantom = False


def make_handler(state: StubState) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "stub-workos/1.0"

        # ------------------------------------------------------------ plumbing

        def log_message(self, fmt: str, *args: Any) -> None:
            print(f"[stub-workos] {self.command} {self.path} — {fmt % args}", flush=True)

        def _body(self) -> dict[str, Any]:
            raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
            if not raw:
                return {}
            try:
                parsed = json.loads(raw)
            except ValueError:
                return {}
            return parsed if isinstance(parsed, dict) else {}

        def _send(self, code: int, payload: dict[str, Any], headers: dict[str, str] | None = None) -> None:
            body = json.dumps(payload).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            for key, value in (headers or {}).items():
                self.send_header(key, value)
            self.end_headers()
            self.wfile.write(body)

        def _redirect(self, location: str) -> None:
            self.send_response(302)
            self.send_header("Location", location)
            self.send_header("Content-Length", "0")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()

        def _query(self) -> dict[str, str]:
            q = parse_qs(urlsplit(self.path).query)
            return {k: (v[0] if v else "") for k, v in q.items()}

        # ------------------------------------------------------------ routing

        def do_GET(self) -> None:
            try:
                path = urlsplit(self.path).path
                if path.startswith("/sso/jwks/"):
                    if path.rsplit("/", 1)[-1] != state.client_id:
                        return self._send(404, {"error": "unknown client"})
                    return self._send(200, state.jwks())
                if path == "/user_management/authorize":
                    return self._authorize()
                if path == "/user_management/organization_memberships":
                    return self._memberships()
                if path == "/user_management/sessions/logout":
                    return self._logout()
                if path == "/_stub/state":
                    return self._send(200, state.snapshot())
                if path in {"/health", "/_stub/health"}:
                    return self._send(200, {"ok": True})
                return self._send(404, {"error": "not found"})
            except Exception:  # noqa: BLE001 — a test double must answer, not die
                traceback.print_exc()
                return self._send(500, {"error": "stub failure"})

        def do_POST(self) -> None:
            try:
                path = urlsplit(self.path).path
                if path == "/user_management/authenticate":
                    return self._authenticate()
                if path == "/_stub/reset":
                    state.reset()
                    return self._send(200, {"ok": True})
                if path == "/_stub/advertise-phantom":
                    # Make the listing stale without making the org switchable.
                    state.phantom = True
                    return self._send(200, {"ok": True})
                if path == "/_stub/revoke":
                    # Membership lost after a listing was already read.
                    organization_id = str(self._body().get("organization_id") or "")
                    if not organization_id:
                        return self._send(400, {"error": "organization_id required"})
                    state.revoke(organization_id)
                    return self._send(200, {"ok": True})
                return self._send(404, {"error": "not found"})
            except Exception:  # noqa: BLE001
                traceback.print_exc()
                return self._send(500, {"error": "stub failure"})

        # ------------------------------------------------------------ endpoints

        def _authorize(self) -> None:
            q = self._query()
            if q.get("client_id") != state.client_id:
                return self._send(400, {"error": "invalid_client"})
            if q.get("response_type") != "code" or q.get("provider") != "authkit":
                return self._send(400, {"error": "unsupported_request"})
            redirect_uri, returned_state = q.get("redirect_uri", ""), q.get("state", "")
            if not redirect_uri or not returned_state:
                return self._send(400, {"error": "redirect_uri and state are required"})
            parts = urlsplit(redirect_uri)
            if parts.scheme not in {"http", "https"} or not parts.netloc:
                return self._send(400, {"error": "invalid_redirect_uri"})

            code = f"code_{secrets.token_urlsafe(12)}"
            session_id = f"session_{secrets.token_hex(6)}"
            with state.lock:
                state.codes[code] = {
                    "state": returned_state,
                    "redirect_uri": redirect_uri,
                    "session_id": session_id,
                    "used": False,
                }
                state.authorizations.append(
                    {
                        "client_id": q["client_id"],
                        "redirect_uri": redirect_uri,
                        "state": returned_state,
                        "response_type": q["response_type"],
                        "provider": q["provider"],
                    }
                )
            return self._redirect(f"{redirect_uri}?{urlencode({'code': code, 'state': returned_state})}")

        def _authenticate(self) -> None:
            body = self._body()
            grant = body.get("grant_type")
            if grant == "authorization_code":
                code = str(body.get("code") or "")
                with state.lock:
                    record = state.codes.get(code)
                    if record is None or record["used"]:
                        # A replayed or unknown code: the API maps this 4xx to 401.
                        return self._send(400, {"error": "invalid_grant", "error_description": "code not usable"})
                    record["used"] = True
                    session_id = str(record["session_id"])
                    state.exchanges.append({"code": code, "state": record["state"], "session_id": session_id})
                return self._send(200, state.mint(session_id=session_id, organization_id=DEFAULT_ORG))

            if grant == "refresh_token":
                presented = str(body.get("refresh_token") or "")
                organization_id = str(body.get("organization_id") or DEFAULT_ORG)
                with state.lock:
                    if presented not in state.refresh_tokens:
                        return self._send(400, {"error": "invalid_grant", "error_description": "refresh token revoked"})
                    if organization_id not in state.active_org_ids():
                        # A switch to an organization this user does not belong to is
                        # refused. The rejected grant does not spend the refresh token,
                        # so the session the caller already holds stays usable — the
                        # same deal WorkOS offers a client that names the wrong org.
                        state.refusals.append(
                            {"organization_id": organization_id, "reason": "no active membership"}
                        )
                        return self._send(
                            400,
                            {"error": "invalid_grant", "error_description": "no active membership for organization"},
                        )
                    state.refresh_tokens.discard(presented)  # rotation: one use only
                    state.refreshes.append(
                        {"organization_id": body.get("organization_id"), "granted": organization_id}
                    )
                return self._send(200, state.mint(session_id=f"session_{secrets.token_hex(6)}", organization_id=organization_id))

            return self._send(400, {"error": "unsupported_grant_type"})

        def _memberships(self) -> None:
            q = self._query()
            if q.get("user_id") != state.subject:
                return self._send(404, {"error": "user not found"})
            wanted = q.get("organization_id")
            if wanted:
                # A single-membership lookup is authoritative: it answers from the
                # real set, so a stale listing entry cannot confirm itself.
                with state.lock:
                    state.lookups.append(wanted)
                    rows = [m for m in state.memberships if m["organization_id"] == wanted]
                return self._send(200, {"data": rows})
            # The listing may lag behind (PHANTOM_ORG is advertised but not real).
            rows = list(state.memberships) + ([PHANTOM_ORG] if state.phantom else [])
            return self._send(200, {"data": rows})

        def _logout(self) -> None:
            q = self._query()
            session_id, return_to = q.get("session_id", ""), q.get("return_to", "")
            with state.lock:
                state.logouts.append({"session_id": session_id, "return_to": return_to})
            target = return_to or "/"
            if target.startswith("/"):
                target = f"{state.app_url}{target}"
            elif urlsplit(target).scheme not in {"http", "https"}:
                target = f"{state.app_url}/"
            return self._redirect(target)

    return Handler


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--port", type=int, default=5194)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--public-url", default="", help="origin the API calls; also the token iss")
    ap.add_argument("--app-url", default="http://127.0.0.1:5190", help="where relative return_to paths go")
    ap.add_argument("--client-id", default="client_e2e")
    ap.add_argument("--email", default="owner@acme.test")
    args = ap.parse_args()

    public_url = args.public_url or f"http://{args.host}:{args.port}"
    state = StubState(client_id=args.client_id, public_url=public_url, app_url=args.app_url, email=args.email)
    httpd = ThreadingHTTPServer((args.host, args.port), make_handler(state))
    httpd.daemon_threads = True
    print(f"[stub-workos] listening on {public_url} (iss={state.public_url}, client={state.client_id})", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
