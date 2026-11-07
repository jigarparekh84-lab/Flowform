"""CR-034: the MIP solver is pinned, and the pinned version is what runs.

A PuLP or HiGHS upgrade can change branching order, and with it objective
values, duals and the facilities a plan opens. Nothing in the application
changes, but every saved result becomes incomparable with the last release.
Each Run records ``solver_version`` for exactly this reason, which only means
something if the version is fixed by the lock rather than by whatever pip
happened to resolve on the day.

The pin is declared in two places on purpose: the engine package that owns the
dependency, and the API lock input that ships it. This test is the gate that
keeps both of those, the hashed lock, and the interpreter in agreement.
"""

from __future__ import annotations

import importlib.metadata as md
import re
import tomllib
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
ENGINE_PYPROJECT = API_DIR.parent / "engine" / "pyproject.toml"
REQUIREMENTS_IN = API_DIR / "requirements.in"
LOCK = API_DIR / "requirements.txt"

SOLVERS = ("pulp", "highspy")


def _exact_pins(lines: list[str]) -> dict[str, str]:
    pins: dict[str, str] = {}
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        for name in SOLVERS:
            match = re.match(rf"^{name}\s*==\s*([^\s,;\\]+)", line)
            if match:
                pins[name] = match.group(1)
    return pins


def _engine_pins() -> dict[str, str]:
    data = tomllib.loads(ENGINE_PYPROJECT.read_text())
    return _exact_pins(data["project"]["dependencies"])


def _api_pins() -> dict[str, str]:
    return _exact_pins(REQUIREMENTS_IN.read_text().splitlines())


def _lock_pins() -> dict[str, str]:
    return _exact_pins(LOCK.read_text().splitlines())


@pytest.mark.parametrize("name", SOLVERS)
def test_engine_pins_solver_exactly(name: str) -> None:
    """A range like ``pulp>=2.8`` lets a deploy resolve a different solver."""
    assert _engine_pins().get(name), (
        f"{ENGINE_PYPROJECT} must pin {name} to an exact version (==), "
        f"found {_engine_pins().get(name)!r}"
    )


@pytest.mark.parametrize("name", SOLVERS)
def test_api_and_engine_pins_agree(name: str) -> None:
    engine, api = _engine_pins().get(name), _api_pins().get(name)
    assert engine, f"{name} is not pinned exactly in {ENGINE_PYPROJECT}"
    assert api, f"{name} is not pinned exactly in {REQUIREMENTS_IN}"
    assert engine == api, (
        f"{name} pin drift: engine wants {engine}, API lock input wants {api}. "
        "Update both and run scripts/lock-requirements.sh."
    )


@pytest.mark.parametrize("name", SOLVERS)
def test_hashed_lock_matches_the_pin(name: str) -> None:
    """The lock can lag the .in file if it was not regenerated after a bump."""
    pin, locked = _api_pins().get(name), _lock_pins().get(name)
    assert pin, f"{name} is not pinned exactly in {REQUIREMENTS_IN}"
    assert locked == pin, (
        f"{name}: {REQUIREMENTS_IN} pins {pin} but {LOCK} pins {locked}. "
        "Run scripts/lock-requirements.sh."
    )


@pytest.mark.parametrize("name", SOLVERS)
def test_installed_version_is_the_pin(name: str) -> None:
    pin = _api_pins().get(name)
    assert pin, f"{name} is not pinned exactly in {REQUIREMENTS_IN}"
    installed = md.version(name)
    assert installed == pin, (
        f"{name} {installed} is installed but the lock pins {pin}; "
        "results produced here would not match a deployed run. "
        "Reinstall with: pip install -r requirements.txt"
    )


def test_lock_is_hash_checked() -> None:
    """Every pinned package must carry a hash, or pip installs it unverified."""
    text = LOCK.read_text()
    pinned = [
        line
        for line in text.splitlines()
        if re.match(r"^[A-Za-z0-9][A-Za-z0-9._-]*==", line)
    ]
    hashes = text.count("--hash=sha256:")
    assert pinned, f"{LOCK} has no pinned packages"
    assert hashes >= len(pinned), (
        f"{LOCK} pins {len(pinned)} packages but carries only {hashes} hashes; "
        "regenerate with --generate-hashes"
    )
