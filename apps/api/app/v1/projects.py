"""/v1/projects CRUD (FF-104). Body = ProjectSnapshot JSON (a ``*.flowform.json``
export); stored verbatim per version so GET returns the same bytes."""

from __future__ import annotations

import json
import os
import uuid
from typing import Any, cast

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from sqlalchemy import func, select, update
from sqlalchemy.engine import CursorResult

from .. import quotas
from ..db.models import AuditEvent, Project, ProjectVersion
from ..db.session import tenant_session
from .auth import Identity, admin, editor, viewer

router = APIRouter(prefix="/v1/projects", tags=["projects"])

#: A project snapshot is a full workspace document, not an upload endpoint.
#: Keep it bounded so one client cannot exhaust memory or tenant storage.
DEFAULT_MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024


def _snapshot_limit() -> int:
    raw = os.environ.get("MAX_PROJECT_SNAPSHOT_BYTES")
    if raw is None:
        return DEFAULT_MAX_SNAPSHOT_BYTES
    try:
        return max(1024, int(raw))
    except ValueError:
        return DEFAULT_MAX_SNAPSHOT_BYTES


MAX_SNAPSHOT_BYTES = _snapshot_limit()


def _too_large() -> HTTPException:
    limit_mb = MAX_SNAPSHOT_BYTES / (1024 * 1024)
    return HTTPException(
        status_code=413,
        detail=(
            f"project snapshot exceeds the {limit_mb:.1f} MB limit "
            "(MAX_PROJECT_SNAPSHOT_BYTES). Save a smaller project or raise the limit."
        ),
    )


async def _snapshot(request: Request) -> tuple[str, dict[str, Any]]:
    """Read a bounded JSON object from the request without buffering forever."""
    declared = (request.headers.get("content-length") or "").strip()
    if declared:
        try:
            if int(declared) > MAX_SNAPSHOT_BYTES:
                raise _too_large()
        except ValueError:
            raise HTTPException(
                status_code=400, detail="Content-Length must be an integer"
            ) from None

    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > MAX_SNAPSHOT_BYTES:
            raise _too_large()

    try:
        raw = body.decode("utf-8")
    except UnicodeDecodeError as e:
        raise HTTPException(status_code=422, detail="snapshot must be UTF-8 JSON") from e

    try:
        doc = json.loads(raw)
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=422, detail=f"invalid JSON: {e}") from e
    if not isinstance(doc, dict):
        raise HTTPException(status_code=422, detail="snapshot must be a JSON object")
    return raw, doc


def _name(doc: dict[str, Any], fallback: str = "Untitled project") -> str:
    meta = doc.get("meta") if isinstance(doc.get("meta"), dict) else None
    meta = meta or (doc.get("state") or {}).get("projectMeta") or doc.get("projectMeta") or {}
    return str(doc.get("name") or meta.get("name") or fallback)[:300]


def _out(p: Project) -> dict[str, Any]:
    return {
        "id": str(p.id), "name": p.name, "version": p.current_version,
        "createdAt": p.created_at.isoformat() if p.created_at else None,
        "updatedAt": p.updated_at.isoformat() if p.updated_at else None,
    }


def _if_match_version(request: Request) -> int | None:
    """Version from ``If-Match`` (``"7"``, ``W/"7"``, or 7), or None if absent.

    Absent means "overwrite whatever is there" — the legacy behaviour, kept so
    clients that do not track versions keep working. Present means strict.
    """
    raw = (request.headers.get("if-match") or "").strip()
    if not raw or raw == "*":
        return None
    if raw.startswith("W/"):
        raw = raw[2:].strip()
    try:
        return int(raw.strip('"'))
    except ValueError:
        raise HTTPException(
            status_code=400, detail="If-Match must be a project version number, e.g. If-Match: \"3\""
        ) from None


def _conflict(expected: int | None, current: int) -> HTTPException:
    return HTTPException(
        status_code=409,
        detail=(
            f"project changed since version {expected} (now {current}). "
            "Reload the project and re-apply your changes."
            if expected is not None
            else "project was modified by another writer. Reload the project and retry."
        ),
        headers={"ETag": f'"{current}"'},
    )


def get_project_or_404(s, ident: Identity, pid: uuid.UUID) -> Project:
    p = s.execute(
        select(Project).where(Project.id == pid, Project.tenant_id == ident.tenant_id)
    ).scalar_one_or_none()
    if p is None:
        raise HTTPException(status_code=404, detail="project not found")
    return p


@router.get("")
def list_projects(ident: Identity = Depends(viewer)) -> dict[str, Any]:
    with tenant_session(ident.tenant_id) as s:
        rows = s.execute(
            select(Project).where(Project.tenant_id == ident.tenant_id).order_by(Project.updated_at.desc())
        ).scalars()
        return {"projects": [_out(p) for p in rows]}


@router.post("", status_code=201)
async def create_project(request: Request, ident: Identity = Depends(editor)) -> dict[str, Any]:
    raw, doc = await _snapshot(request)
    lim = quotas.limits()
    with tenant_session(ident.tenant_id) as s:
        # Quotas are checked inside the writing transaction, so a refusal leaves
        # no half-created project behind (CR-005).
        quotas.ensure_project_slot(s, ident.tenant_id, lim)
        p = Project(tenant_id=ident.tenant_id, name=_name(doc), current_version=1, created_by=ident.user_id)
        s.add(p)
        s.flush()
        s.add(ProjectVersion(tenant_id=ident.tenant_id, project_id=p.id, version=1, snapshot_raw=raw, created_by=ident.user_id))
        s.flush()
        quotas.ensure_storage(s, ident.tenant_id, lim)
        s.add(AuditEvent(tenant_id=ident.tenant_id, actor_id=ident.user_id, action="project.create", target=str(p.id)))
        s.flush()
        s.refresh(p)
        return _out(p)


@router.get("/{project_id}")
def get_project(project_id: uuid.UUID, ident: Identity = Depends(viewer)) -> dict[str, Any]:
    with tenant_session(ident.tenant_id) as s:
        return _out(get_project_or_404(s, ident, project_id))


@router.get("/{project_id}/snapshot")
def get_snapshot(project_id: uuid.UUID, version: int | None = None, ident: Identity = Depends(viewer)) -> Response:
    with tenant_session(ident.tenant_id) as s:
        p = get_project_or_404(s, ident, project_id)
        v = s.execute(
            select(ProjectVersion).where(
                ProjectVersion.project_id == p.id, ProjectVersion.version == (version or p.current_version)
            )
        ).scalar_one_or_none()
        if v is None:
            raise HTTPException(status_code=404, detail="version not found")
        return Response(content=v.snapshot_raw, media_type="application/json",
                        headers={"X-Project-Version": str(v.version)})


@router.put("/{project_id}")
async def update_project(project_id: uuid.UUID, request: Request, ident: Identity = Depends(editor)) -> Response:
    """Save a new snapshot version.

    Two concurrent saves must not both claim version *n+1* (the version rows are
    unique per project), so the bump is a compare-and-swap rather than a
    read-modify-write. A client that sends ``If-Match`` gets a 409 when its base
    version is stale; without it, only the swap itself guards the update.

    Retention (CR-005) prunes versions older than the newest
    ``MAX_VERSIONS_PER_PROJECT`` in this same transaction, then the tenant
    storage cap is checked. Exceeding it rolls back the version bump too.
    """
    raw, doc = await _snapshot(request)
    expected = _if_match_version(request)
    lim = quotas.limits()
    with tenant_session(ident.tenant_id) as s:
        p = get_project_or_404(s, ident, project_id)
        base = p.current_version
        if expected is not None and expected != base:
            raise _conflict(expected, base)
        claimed = cast(
            "CursorResult[Any]",
            s.execute(
                update(Project)
                .where(Project.id == p.id, Project.current_version == base)
                .values(current_version=base + 1, updated_at=func.now())
                .execution_options(synchronize_session=False)
            ),
        ).rowcount
        if claimed != 1:
            # Lost the race between the read and the swap.
            s.refresh(p)
            raise _conflict(expected, p.current_version)
        s.refresh(p)
        p.name = _name(doc, p.name)
        s.add(ProjectVersion(tenant_id=ident.tenant_id, project_id=p.id, version=p.current_version, snapshot_raw=raw, created_by=ident.user_id))
        s.flush()
        quotas.prune_versions(s, ident.tenant_id, p.id, lim.max_versions_per_project)
        quotas.ensure_storage(s, ident.tenant_id, lim)
        s.add(AuditEvent(tenant_id=ident.tenant_id, actor_id=ident.user_id, action="project.update", target=str(p.id), detail={"version": p.current_version}))
        s.flush()
        s.refresh(p)
        out = _out(p)
    return JSONResponse(out, headers={"ETag": f'"{out["version"]}"'})


@router.delete("/{project_id}", status_code=204)
def delete_project(project_id: uuid.UUID, ident: Identity = Depends(admin)) -> Response:
    with tenant_session(ident.tenant_id) as s:
        p = get_project_or_404(s, ident, project_id)
        s.delete(p)
        s.add(AuditEvent(tenant_id=ident.tenant_id, actor_id=ident.user_id, action="project.delete", target=str(project_id)))
    return Response(status_code=204)
