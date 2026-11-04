"""建运行与列表的请求/响应形状。

对外开放用 camelCase（前端直接消费），内部保持 snake_case。
字段与 `app/db/models.py` 的 Run / RunEvent / Artifact 对齐。
"""

from pydantic import BaseModel, Field


class RunCreate(BaseModel):
    prompt: str = Field(min_length=1, max_length=4000)


class EventOut(BaseModel):
    seq: int
    kind: str
    payload: dict
    createdAt: int


class ArtifactOut(BaseModel):
    name: str
    kind: str
    bytes: int
    sha256: str
    createdAt: int


def run_to_dict(run) -> dict:
    return {
        "id": run.id,
        "prompt": run.prompt,
        "stage": run.stage,
        "status": run.status,
        "workflowVersion": run.workflow_version,
        "totalCostCny": float(run.total_cost_cny or 0),
        "createdAt": run.created_at,
        "updatedAt": run.updated_at,
    }


def event_to_dict(event) -> dict:
    return {
        "seq": event.seq,
        "kind": event.kind,
        "payload": event.payload,
        "createdAt": event.created_at,
    }


def artifact_to_dict(artifact) -> dict:
    return {
        "name": artifact.name,
        "kind": artifact.kind,
        "bytes": artifact.bytes,
        "sha256": artifact.sha256,
        "createdAt": artifact.created_at,
    }