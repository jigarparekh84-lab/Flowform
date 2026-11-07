"""Tenant quotas and project-version retention (CR-005).

A workspace stores a full snapshot per save, so three limits keep one tenant's
history from filling the database. All three are environment settings read per
request, so a deployment can adjust them without a restart:

| Setting | Default | Enforced on |
|---|---|---|
| `MAX_PROJECTS_PER_TENANT` | 100 | `POST /v1/projects` |
| `MAX_VERSIONS_PER_PROJECT` | 50 | every save, by pruning older versions |
| `MAX_TENANT_STORAGE_BYTES` | 512 MiB | every snapshot write |

**Retention** keeps the newest N versions of a project and deletes the rest in
the same transaction as the write that pushed it over the limit. A save is
never rejected for being one version too many; history simply stops growing and
the current version is always among the newest N. Older versions of existing
projects are pruned on their next save (a periodic compaction job is CR-017).

**Status codes** are deliberately distinct, because a client has to tell these
apart to show the right message:

* `413` — *this* snapshot exceeds `MAX_PROJECT_SNAPSHOT_BYTES` (see `projects.py`);
* `403` — the tenant is at a quota (`X-Quota-Limit` names which one);
* `409` — the base version is stale (concurrent edit);
* `429` (CR-007, not yet) — too many requests, retry later.

The storage check sums `length(snapshot_raw)` for the tenant inside the writing
transaction; the row is rolled back if the write would cross the cap, so the
stored size can never exceed it. CR-018 replaces this aggregate with metered
counters when usage has to be billed.
"""

from __future__ import annotations

import logging
import os
import uuid
from dataclasses import dataclass
from typing import Any, cast

from fastapi import HTTPException
from sqlalchemy import delete, func, select
from sqlalchemy.engine import CursorResult
from sqlalchemy.orm import Session

from .db.models import Project, ProjectVersion

log = logging.getLogger("flowform.quotas")

DEFAULT_MAX_PROJECTS = 100
DEFAULT_MAX_VERSIONS_PER_PROJECT = 50
DEFAULT_MAX_TENANT_BYTES = 512 * 1024 * 1024


@dataclass(frozen=True)
class Limits:
    max_projects: int
    max_versions_per_project: int
    max_tenant_bytes: int


def _int_env(name: str, default: int) -> int:
    """Read a positive integer setting; a bad value falls back to the default.

    A typo in a deployment's environment must not take the API down or silently
    become an unlimited quota.
    """
    raw = (os.environ.get(name) or "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        log.warning("ignoring %s=%r: not an integer; using %d", name, raw, default)
        return default
    if value < 1:
        log.warning("ignoring %s=%r: must be >= 1; using %d", name, raw, default)
        return default
    return value


def limits() -> Limits:
    return Limits(
        max_projects=_int_env("MAX_PROJECTS_PER_TENANT", DEFAULT_MAX_PROJECTS),
        max_versions_per_project=_int_env(
            "MAX_VERSIONS_PER_PROJECT", DEFAULT_MAX_VERSIONS_PER_PROJECT
        ),
        max_tenant_bytes=_int_env("MAX_TENANT_STORAGE_BYTES", DEFAULT_MAX_TENANT_BYTES),
    )


def quota_error(kind: str, detail: str) -> HTTPException:
    """A quota refusal the client can recognise (403 + `X-Quota-Limit`)."""
    return HTTPException(
        status_code=403,
        detail=detail,
        headers={"X-Quota-Limit": kind, "X-Quota-Remaining": "0"},
    )


def project_count(session: Session, tenant_id: uuid.UUID) -> int:
    return int(
        session.execute(
            select(func.count()).select_from(Project).where(Project.tenant_id == tenant_id)
        ).scalar()
        or 0
    )


def ensure_project_slot(session: Session, tenant_id: uuid.UUID, lim: Limits) -> None:
    """Refuse a new project once the tenant is at its project limit."""
    count = project_count(session, tenant_id)
    if count >= lim.max_projects:
        raise quota_error(
            "projects",
            f"this workspace is at its {lim.max_projects}-project limit "
            "(MAX_PROJECTS_PER_TENANT). Delete a project you no longer need, "
            "or raise the limit.",
        )


def prune_versions(
    session: Session,
    tenant_id: uuid.UUID,
    project_id: uuid.UUID,
    keep: int,
) -> int:
    """Delete versions older than the newest ``keep``; returns how many went."""
    newest = session.execute(
        select(func.max(ProjectVersion.version)).where(
            ProjectVersion.tenant_id == tenant_id,
            ProjectVersion.project_id == project_id,
        )
    ).scalar()
    if newest is None:
        return 0
    cutoff = int(newest) - keep
    if cutoff < 1:
        return 0
    removed = cast(
        "CursorResult[Any]",
        session.execute(
            delete(ProjectVersion)
            .where(
                ProjectVersion.tenant_id == tenant_id,
                ProjectVersion.project_id == project_id,
                ProjectVersion.version <= cutoff,
            )
            .execution_options(synchronize_session=False)
        ),
    ).rowcount
    if removed:
        log.info(
            "project.versions_pruned tenant=%s project=%s kept=%d pruned=%d",
            tenant_id,
            project_id,
            keep,
            removed,
        )
    return int(removed or 0)


def tenant_bytes(session: Session, tenant_id: uuid.UUID) -> int:
    """Snapshot bytes stored for a tenant, counted inside the caller's transaction."""
    total = session.execute(
        select(
            func.coalesce(func.sum(func.length(ProjectVersion.snapshot_raw)), 0)
        ).where(ProjectVersion.tenant_id == tenant_id)
    ).scalar()
    return int(total or 0)


def ensure_storage(session: Session, tenant_id: uuid.UUID, lim: Limits) -> int:
    """Refuse the write when the tenant's stored snapshots exceed the cap.

    Called *after* the new version is inserted and older ones are pruned, so a
    save that also compacts history is allowed to succeed. Raising here rolls
    the whole write back: the version bump, the version row and the audit event.
    """
    used = tenant_bytes(session, tenant_id)
    if used > lim.max_tenant_bytes:
        limit_mb = lim.max_tenant_bytes / (1024 * 1024)
        used_mb = used / (1024 * 1024)
        raise quota_error(
            "storage",
            f"this workspace would store {used_mb:.1f} MB of project history, "
            f"over its {limit_mb:.1f} MB limit (MAX_TENANT_STORAGE_BYTES). "
            "Delete a project or raise the limit.",
        )
    return used
