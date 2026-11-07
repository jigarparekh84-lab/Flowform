"""Quota settings and the refusal shape (CR-005) — no database needed."""

from __future__ import annotations

import pytest
from fastapi import HTTPException

from app import quotas


def test_defaults_apply_when_nothing_is_configured(monkeypatch):
    for name in (
        "MAX_PROJECTS_PER_TENANT",
        "MAX_VERSIONS_PER_PROJECT",
        "MAX_TENANT_STORAGE_BYTES",
    ):
        monkeypatch.delenv(name, raising=False)
    lim = quotas.limits()
    assert lim.max_projects == quotas.DEFAULT_MAX_PROJECTS
    assert lim.max_versions_per_project == quotas.DEFAULT_MAX_VERSIONS_PER_PROJECT
    assert lim.max_tenant_bytes == quotas.DEFAULT_MAX_TENANT_BYTES


def test_settings_are_read_per_call_so_a_deploy_needs_no_restart(monkeypatch):
    monkeypatch.setenv("MAX_PROJECTS_PER_TENANT", "7")
    monkeypatch.setenv("MAX_VERSIONS_PER_PROJECT", "3")
    monkeypatch.setenv("MAX_TENANT_STORAGE_BYTES", "1048576")
    lim = quotas.limits()
    assert (lim.max_projects, lim.max_versions_per_project, lim.max_tenant_bytes) == (
        7,
        3,
        1_048_576,
    )
    monkeypatch.setenv("MAX_PROJECTS_PER_TENANT", "9")
    assert quotas.limits().max_projects == 9


@pytest.mark.parametrize("bad", ["", "abc", "0", "-4", "1.5"])
def test_a_bad_setting_falls_back_instead_of_becoming_unlimited(bad, monkeypatch):
    """A typo must not turn a quota off (or take the API down)."""
    monkeypatch.setenv("MAX_PROJECTS_PER_TENANT", bad)
    assert quotas.limits().max_projects == quotas.DEFAULT_MAX_PROJECTS


def test_quota_refusal_names_the_limit(monkeypatch):
    err = quotas.quota_error("projects", "at the limit")
    assert err.status_code == 403
    assert err.detail == "at the limit"
    assert err.headers == {"X-Quota-Limit": "projects", "X-Quota-Remaining": "0"}
    assert isinstance(err, HTTPException)
