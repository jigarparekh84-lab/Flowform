"""FF-110: the wizard's starter model (fixture written by
apps/web/src/data/onboarding.test.ts) passes guardrails and solves."""

from __future__ import annotations

from app.solver import solve_optimize
from flowform_engine import validate_optimize

from .enterprise_payload import load_enterprise_pack, pack_to_optimize_payload


def test_wizard_starter_model_validates_and_solves():
    payload = pack_to_optimize_payload(load_enterprise_pack("onboarding-starter.enterprise.json"))
    v = validate_optimize(payload)
    assert not v["blocking"], v["issues"]
    body = solve_optimize(payload)
    assert body["status"] == "Optimal", body.get("log")
    assert body["kpis"]["servicePct"] >= 95
    assert body["openIds"]
    print(f"\n[wizard starter] total={body['objectiveBreakdown']['totalM']} open={sorted(body['openIds'])} service={body['kpis']['servicePct']}")
