"""/v1/projects CRUD (FF-104). Body = ProjectSnapshot JSON (a ``*.flowform.json``
export); stored verbatim per version so GET returns the same bytes."""

from __future__ import annotations

import json
import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import select

from ..db.models import AuditEvent, Project, ProjectVersion
from ..db.session import tenant_session
from .auth import Identity, current_identity

router = APIRouter(prefix="/v1/projects", tags=["projects"])


async def _snapshot(request: Request) -> tuple[str, dict[str, Any]]:
    raw = (await request.body()).decode("utf-8")
    try:
        doc = json.loads(raw)
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=422, detail=f"invalid JSON: {e}")
    if not isinstance(doc, dict):
        raise HTTPException(status_code=422, detail="snapshot must be a JSON object")
    return raw, doc


def _name(doc: dict[str, Any], fallback: str = "Untitled project") -> str:
    meta = (doc.get("state") or {}).get("projectMeta") or doc.get("projectMeta") or {}
    return str(doc.get("name") or meta.get("name") or fallback)[:300]


def _out(p: Project) -> dict[str, Any]:
    return {
        "id": str(p.id), "name": p.name, "version": p.current_version,
        "createdAt": p.created_at.isoformat() if p.created_at else None,
        "updatedAt": p.updated_at.isoformat() if p.updated_at else None,
    }


def _get(s, ident: Identity, pid: uuid.UUID) -> Project:
    p = s.execute(
        select(Project).where(Project.id == pid, Project.tenant_id == ident.tenant_id)
    ).scalar_one_or_none()
    if p is None:
        raise HTTPException(status_code=404, detail="project not found")
    return p


@router.get("")
def list_projects(ident: Identity = Depends(current_identity)) -> dict[str, Any]:
    with tenant_session(ident.tenant_id) as s:
        rows = s.execute(
            select(Project).where(Project.tenant_id == ident.tenant_id).order_by(Project.updated_at.desc())
        ).scalars()
        return {"projects": [_out(p) for p in rows]}


@router.post("", status_code=201)
async def create_project(request: Request, ident: Identity = Depends(current_identity)) -> dict[str, Any]:
    raw, doc = await _snapshot(request)
    with tenant_session(ident.tenant_id) as s:
        p = Project(tenant_id=ident.tenant_id, name=_name(doc), current_version=1, created_by=ident.user_id)
        s.add(p)
        s.flush()
        s.add(ProjectVersion(tenant_id=ident.tenant_id, project_id=p.id, version=1, snapshot_raw=raw, created_by=ident.user_id))
        s.add(AuditEvent(tenant_id=ident.tenant_id, actor_id=ident.user_id, action="project.create", target=str(p.id)))
        s.flush()
        s.refresh(p)
        return _out(p)


@router.get("/{project_id}")
def get_project(project_id: uuid.UUID, ident: Identity = Depends(current_identity)) -> dict[str, Any]:
    with tenant_session(ident.tenant_id) as s:
        return _out(_get(s, ident, project_id))


@router.get("/{project_id}/snapshot")
def get_snapshot(project_id: uuid.UUID, version: int | None = None, ident: Identity = Depends(current_identity)) -> Response:
    with tenant_session(ident.tenant_id) as s:
        p = _get(s, ident, project_id)
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
async def update_project(project_id: uuid.UUID, request: Request, ident: Identity = Depends(current_identity)) -> dict[str, Any]:
    raw, doc = await _snapshot(request)
    with tenant_session(ident.tenant_id) as s:
        p = _get(s, ident, project_id)
        p.current_version += 1
        p.name = _name(doc, p.name)
        s.add(ProjectVersion(tenant_id=ident.tenant_id, project_id=p.id, version=p.current_version, snapshot_raw=raw, created_by=ident.user_id))
        s.add(AuditEvent(tenant_id=ident.tenant_id, actor_id=ident.user_id, action="project.update", target=str(p.id), detail={"version": p.current_version}))
        s.flush()
        s.refresh(p)
        return _out(p)


@router.delete("/{project_id}", status_code=204)
def delete_project(project_id: uuid.UUID, ident: Identity = Depends(current_identity)) -> Response:
    with tenant_session(ident.tenant_id) as s:
        p = _get(s, ident, project_id)
        s.delete(p)
        s.add(AuditEvent(tenant_id=ident.tenant_id, actor_id=ident.user_id, action="project.delete", target=str(project_id)))
    return Response(status_code=204)
