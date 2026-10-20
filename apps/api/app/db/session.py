"""Engine/session helpers. ``tenant_session`` switches to the non-owner
``flowform_app`` role and sets ``app.tenant_id`` so Postgres RLS enforces
isolation even if an application query forgets its tenant filter."""

from __future__ import annotations

import os
import uuid
from contextlib import contextmanager
from functools import lru_cache
from typing import Iterator

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

DEFAULT_URL = "postgresql+psycopg://flowform:flowform@127.0.0.1:5433/flowform"
APP_ROLE = "flowform_app"


def database_url() -> str:
    return os.environ.get("DATABASE_URL", DEFAULT_URL)


@lru_cache(maxsize=4)
def get_engine(url: str | None = None) -> Engine:
    return create_engine(url or database_url(), pool_pre_ping=True, future=True)


@contextmanager
def tenant_session(tenant_id: uuid.UUID, url: str | None = None) -> Iterator[Session]:
    factory = sessionmaker(bind=get_engine(url), expire_on_commit=False)
    with factory() as s, s.begin():
        s.execute(text(f"SET LOCAL ROLE {APP_ROLE}"))
        s.execute(text("SELECT set_config('app.tenant_id', :t, true)"), {"t": str(tenant_id)})
        yield s


@contextmanager
def admin_session(url: str | None = None) -> Iterator[Session]:
    """Owner session (bypasses RLS) — tenant provisioning only."""
    factory = sessionmaker(bind=get_engine(url), expire_on_commit=False)
    with factory() as s, s.begin():
        yield s
