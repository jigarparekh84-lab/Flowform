"""Flowform optimize API — FastAPI on port 5182."""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .solver import solve_optimize

app = FastAPI(
    title="Flowform Optimize API",
    description="MIP footprint optimize (PuLP + HiGHS/CBC). CORS for localhost:5180.",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5180",
        "http://127.0.0.1:5180",
        "http://localhost:5181",
        "http://127.0.0.1:5181",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class OptimizeRequest(BaseModel):
    network: dict[str, Any] = Field(..., description="nodes, lanes, demandVolume")
    constraints: dict[str, Any] = Field(..., description="globals + facilities")
    reference: dict[str, Any] | None = Field(
        default=None, description="Optional reference scenario for KPI deltas"
    )


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "flowform-api"}


@app.post("/optimize")
def optimize(body: OptimizeRequest) -> dict[str, Any]:
    try:
        return solve_optimize(
            {
                "network": body.network,
                "constraints": body.constraints,
                "reference": body.reference or {},
            }
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Optimize failed: {e}") from e
