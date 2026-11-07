"""The project snapshot reader is bounded and validates its input.

These tests exercise the reader directly so they do not need a database; the
route-level CRUD tests remain in ``test_projects_api.py``.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from app.v1 import projects


def _request(chunks: list[bytes], headers: dict[str, str] | None = None) -> Request:
    pending = list(chunks)

    async def receive() -> dict[str, Any]:
        if not pending:
            return {"type": "http.disconnect"}
        body = pending.pop(0)
        return {
            "type": "http.request",
            "body": body,
            "more_body": bool(pending),
        }

    raw_headers = [
        (name.lower().encode("latin-1"), value.encode("latin-1"))
        for name, value in (headers or {}).items()
    ]
    return Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/v1/projects",
            "headers": raw_headers,
        },
        receive,
    )


def _read(request: Request) -> tuple[str, dict[str, Any]]:
    return asyncio.run(projects._snapshot(request))


def test_reads_a_valid_snapshot() -> None:
    raw, doc = _read(_request([b'{"meta":{"name":"Network study"}}']))
    assert json.loads(raw) == doc
    assert doc["meta"]["name"] == "Network study"


def test_declared_content_length_over_limit_is_rejected_before_reading() -> None:
    request = _request(
        [b"{}"],
        {"content-length": str(projects.MAX_SNAPSHOT_BYTES + 1)},
    )
    with pytest.raises(HTTPException) as exc:
        _read(request)
    assert exc.value.status_code == 413
    assert "MAX_PROJECT_SNAPSHOT_BYTES" in exc.value.detail


def test_chunked_body_over_limit_is_rejected_without_content_length() -> None:
    half = projects.MAX_SNAPSHOT_BYTES // 2 + 1
    request = _request([b"x" * half, b"x" * half])
    with pytest.raises(HTTPException) as exc:
        _read(request)
    assert exc.value.status_code == 413


def test_non_utf8_body_is_a_client_error() -> None:
    request = _request([b"\xff\xfe"])
    with pytest.raises(HTTPException) as exc:
        _read(request)
    assert exc.value.status_code == 422


def test_invalid_json_is_a_client_error() -> None:
    request = _request([b"{not json"])
    with pytest.raises(HTTPException) as exc:
        _read(request)
    assert exc.value.status_code == 422


def test_non_object_json_is_a_client_error() -> None:
    request = _request([b"[1, 2, 3]"])
    with pytest.raises(HTTPException) as exc:
        _read(request)
    assert exc.value.status_code == 422
