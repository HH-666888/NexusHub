"""运行的数据形状。

字段保持旧版形状，前端可以直接复用；
运行 id 统一带 `r-` 前缀。
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


class RunOut(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    prompt: str
    stage: str
    status: str
    total_cost_cny: float = Field(default=0.0, alias="totalCostCny")
    created_at: int = Field(alias="createdAt")
    updated_at: int = Field(alias="updatedAt")


class EventOut(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    seq: int
    kind: str
    payload: dict
    created_at: int = Field(alias="createdAt")


def run_to_dict(run) -> dict:
    return {
        "id": run.id,
        "prompt": run.prompt,
        "stage": run.stage,
        "status": run.status,
        "totalCostCny": float(run.total_cost_cny or 0),
        "createdAt": run.created_at,
        "updatedAt": run.updated_at,
    }