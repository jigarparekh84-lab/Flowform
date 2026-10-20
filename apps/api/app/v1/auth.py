"""Request identity (FF-104 dev bypass; FF-106 adds WorkOS JWT validation).

``AUTH_MODE=dev`` (local + CI only): identity comes from ``X-Dev-Tenant`` /
``X-Dev-User`` headers (defaults: one fixed dev tenant/user), tenant and user
rows are auto-provisioned. Any other mode rejects ``/v1/*`` with 401 until the
real IdP middleware lands.
"""

from __future__ import annotations

import os
import uuid
from dataclasses import dataclass

from fastapi import Header, HTTPException
from sqlalchemy import select

from ..db.models import Tenant, User
from ..db.session import admin_session

DEV_TENANT = uuid.UUID("00000000-0000-0000-0000-00000000d001")
DEV_NS = uuid.UUID("6f6c6f77-666f-726d-0000-000000000000")


@dataclass(frozen=True)
class Identity:
    tenant_id: uuid.UUID
    user_id: uuid.UUID
    role: str


def auth_mode() -> str:
    return os.environ.get("AUTH_MODE", "off").lower()


def _provision(tenant_id: uuid.UUID, email: str) -> uuid.UUID:
    user_id = uuid.uuid5(DEV_NS, f"{tenant_id}:{email}")
    with admin_session() as s:
        if s.get(Tenant, tenant_id) is None:
            s.add(Tenant(id=tenant_id, name=f"Dev tenant {str(tenant_id)[:8]}"))
            s.flush()
        if s.execute(select(User.id).where(User.id == user_id)).first() is None:
            s.add(User(id=user_id, tenant_id=tenant_id, email=email, role="owner"))
    return user_id


def current_identity(
    x_dev_tenant: str | None = Header(default=None),
    x_dev_user: str | None = Header(default=None),
) -> Identity:
    if auth_mode() != "dev":
        raise HTTPException(status_code=401, detail="authentication required")
    try:
        tenant_id = uuid.UUID(x_dev_tenant) if x_dev_tenant else DEV_TENANT
    except ValueError:
        raise HTTPException(status_code=400, detail="X-Dev-Tenant must be a UUID")
    email = (x_dev_user or "dev@flowform.local").strip().lower()
    return Identity(tenant_id=tenant_id, user_id=_provision(tenant_id, email), role="owner")
