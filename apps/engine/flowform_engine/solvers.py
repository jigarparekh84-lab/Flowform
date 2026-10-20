"""Solver adapter layer (ADR-007).

Model code builds PuLP problems and asks an adapter for a configured PuLP
solver object. Adapters forward options verbatim, so results are identical to
constructing ``pulp.HiGHS(...)`` / ``pulp.PULP_CBC_CMD(...)`` directly. New
backends (e.g. Gurobi) implement the same protocol and register in ``ADAPTERS``.
"""

from __future__ import annotations

from typing import Any, Protocol

import pulp


class SolverAdapter(Protocol):
    #: Stable engine-facing name recorded on results (e.g. ``"pulp-highs"``).
    name: str
    #: PuLP solver id used for availability checks.
    pulp_id: str

    def available(self) -> bool: ...

    def make(self, **options: Any) -> Any:
        """Return a PuLP solver configured with ``options`` (msg, gapRel, timeLimit, ...)."""
        ...

    def version(self) -> str: ...


def _available_ids() -> set[str]:
    return set(pulp.listSolvers(onlyAvailable=True))


class PulpHighsAdapter:
    name = "pulp-highs"
    pulp_id = "HiGHS"

    def available(self) -> bool:
        return self.pulp_id in _available_ids()

    def make(self, **options: Any) -> Any:
        return pulp.HiGHS(**options)

    def version(self) -> str:
        try:
            import highspy

            h = highspy.Highs()
            return f"highs {h.versionMajor()}.{h.versionMinor()}.{h.versionPatch()} / pulp {pulp.__version__}"
        except Exception:  # pragma: no cover - diagnostic only
            return f"highs ? / pulp {pulp.__version__}"


class PulpCbcAdapter:
    name = "pulp-cbc"
    pulp_id = "PULP_CBC_CMD"

    def available(self) -> bool:
        return self.pulp_id in _available_ids()

    def make(self, **options: Any) -> Any:
        return pulp.PULP_CBC_CMD(**options)

    def version(self) -> str:
        return f"cbc (bundled) / pulp {pulp.__version__}"


#: Preference order: first available wins.
ADAPTERS: list[SolverAdapter] = [PulpHighsAdapter(), PulpCbcAdapter()]


def get_adapter(name: str) -> SolverAdapter:
    for a in ADAPTERS:
        if a.name == name:
            return a
    raise KeyError(name)


def default_adapter() -> SolverAdapter:
    """First available adapter in preference order."""
    ids = _available_ids()
    for a in ADAPTERS:
        if a.pulp_id in ids:
            return a
    raise RuntimeError(
        "No MIP solver available. Install highspy (pip install highspy) "
        "or ensure PuLP CBC binaries are present."
    )
