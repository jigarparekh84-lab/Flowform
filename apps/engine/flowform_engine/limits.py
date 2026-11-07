"""Input-size and solver-time guards.

Every solve entry point calls :func:`guard_payload` *before* a model is built, so
a hostile or accidentally enormous payload is rejected instead of pinning a
worker, and :func:`time_limit_sec` supplies the wall-clock budget for one solve.

Rejections raise :class:`PayloadTooLarge` (a ``ValueError``) on purpose: the HTTP
layer maps that to 400 and the run worker records a failed run. An oversized
request is refused, never silently truncated — a truncated network would report
an optimum for a model the user did not send.

Defaults are deliberately generous: the reference stress pack is 200 demand
rows / ~1.2k lanes, so these bounds sit an order of magnitude above real use.
"""

from __future__ import annotations

from typing import Any

#: Mirrors the enterprise-pack scale we have benchmarked, with headroom.
DEFAULT_MAX_NODES = 5_000
DEFAULT_MAX_LANES = 20_000
DEFAULT_MAX_DEMAND_ROWS = 5_000
DEFAULT_MAX_COMMODITIES = 500
DEFAULT_MAX_ROADMAP_EVENTS = 200
DEFAULT_MAX_SCENARIOS = 10

#: One solve may not run longer than this unless the caller asks for more.
DEFAULT_TIME_LIMIT_SEC = 120.0
#: Hard ceiling — a caller-supplied limit is clamped here.
MAX_TIME_LIMIT_SEC = 600.0
#: Floor, so a caller cannot disable the guard with ``solverTimeLimitSec: 0``.
MIN_TIME_LIMIT_SEC = 1.0


class PayloadTooLarge(ValueError):
    """The payload exceeds a size guard; nothing was solved."""


def _int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _limits(payload: dict[str, Any]) -> dict[str, int]:
    """Operator overrides live on ``constraints`` (same place as other knobs)."""
    cons = payload.get("constraints") if isinstance(payload, dict) else None
    cons = cons if isinstance(cons, dict) else {}
    return {
        "nodes": _int(cons.get("maxNetworkNodes"), DEFAULT_MAX_NODES),
        "lanes": _int(cons.get("maxNetworkLanes"), DEFAULT_MAX_LANES),
        "demand": _int(cons.get("maxDemandRows"), DEFAULT_MAX_DEMAND_ROWS),
        "commodities": _int(cons.get("maxCommodities"), DEFAULT_MAX_COMMODITIES),
        "events": _int(cons.get("maxRoadmapEvents"), DEFAULT_MAX_ROADMAP_EVENTS),
        "scenarios": _int(cons.get("maxScenarios"), DEFAULT_MAX_SCENARIOS),
    }


def guard_payload(
    payload: Any,
    *,
    roadmap: bool = False,
    scenarios: bool = False,
) -> None:
    """Reject payloads too large to model. Raises :class:`PayloadTooLarge`."""
    if not isinstance(payload, dict):
        raise PayloadTooLarge("Optimize payload must be a JSON object.")
    net = payload.get("network")
    net = net if isinstance(net, dict) else {}
    lim = _limits(payload)

    def check(actual: int, cap: int, what: str, how: str) -> None:
        if actual > cap:
            raise PayloadTooLarge(
                f"{what} ({actual}) exceeds the limit of {cap}. {how}"
            )

    check(len(net.get("nodes") or []), lim["nodes"], "Network nodes",
          "Split the study into regions, or raise constraints.maxNetworkNodes.")
    check(len(net.get("lanes") or []), lim["lanes"], "Network lanes",
          "Split the study into regions, or raise constraints.maxNetworkLanes.")
    check(len(net.get("demandVolume") or {}), lim["demand"], "Demand rows",
          "Aggregate customers into fewer demand points, or raise constraints.maxDemandRows.")
    check(len(net.get("skus") or payload.get("skus") or []), lim["commodities"], "SKUs",
          "Aggregate into product groups, or raise constraints.maxCommodities.")

    if roadmap:
        events = (payload.get("roadmap") or {}).get("events") or []
        check(len(events), lim["events"], "Roadmap events",
              "Stage the roadmap in phases, or raise constraints.maxRoadmapEvents.")
    if scenarios:
        tree = payload.get("scenarioTree") or payload.get("scenarios") or {}
        rows = tree.get("scenarios") if isinstance(tree, dict) else tree
        check(len(rows or []), lim["scenarios"], "Scenarios",
              "Use at most a handful of demand/cost scenarios; raise constraints.maxScenarios.")


def time_limit_sec(
    payload: Any,
    *,
    default: float = DEFAULT_TIME_LIMIT_SEC,
) -> float:
    """Per-solve wall-clock budget from ``constraints.solverTimeLimitSec``."""
    cons = payload.get("constraints") if isinstance(payload, dict) else None
    cons = cons if isinstance(cons, dict) else {}
    try:
        raw = float(cons.get("solverTimeLimitSec", default))
    except (TypeError, ValueError):
        raw = default
    if raw != raw:  # NaN
        raw = default
    return max(MIN_TIME_LIMIT_SEC, min(raw, MAX_TIME_LIMIT_SEC))


def gap_rel(payload: Any) -> float | None:
    """Optional relative MIP gap from ``constraints.mipGapRel``.

    Off unless asked for: the default solver gap keeps golden results stable, and
    the time limit is the load-bearing guard.
    """
    cons = payload.get("constraints") if isinstance(payload, dict) else None
    cons = cons if isinstance(cons, dict) else {}
    raw = cons.get("mipGapRel")
    if raw is None:
        return None
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return None
    if value != value:  # NaN
        return None
    return max(1e-6, min(value, 0.5))
