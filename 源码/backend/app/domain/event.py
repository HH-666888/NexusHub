"""事件类型（契约书 §7）。

`kind` 是判别字段，所以用 Pydantic 的可辨识联合：解析一帧 JSON 就得到具体类型的
对象，而不是一个巨大的 dict。

**新增 kind 必须先改契约书**；前端遇到未知 kind 必须忽略而不是崩溃。
下面带「计划」字样的是契约里已登记、实现待做（tool / retrieval / cost）——
先把名字与字段占住，免得以后各写各的。
"""

from enum import StrEnum
from typing import Annotated, Literal

from pydantic import Field

from app.domain.arch import ArchSpec
from app.domain.artifact import Artifact
from app.domain.base import ApiModel
from app.domain.check import CheckResult, CheckSummary, StageCheck
from app.domain.cost import PriceTier
from app.domain.module_build import BuildBatchSummary
from app.domain.run import TokenUsage
from app.domain.spec import AppSpec, SpecGate
from app.domain.ui import UiSpec


class EventKind(StrEnum):
    # 已实现
    PHASE = "phase"
    REASONING = "reasoning"
    TEXT = "text"
    SPEC = "spec"
    ARCH = "arch"
    UI = "ui"
    MODULES = "modules"
    USAGE = "usage"
    CHECK = "check"
    ARTIFACT = "artifact"
    ERROR = "error"
    # 计划
    TOOL = "tool"
    RETRIEVAL = "retrieval"
    COST = "cost"
    # 工作台流式代码与验收结果（本轮新增，已回写契约书 §7）
    FILE = "file"
    VERDICT = "verdict"


class GeneratePhase(StrEnum):
    """`phase` 事件的 phase 字段取值。注意 `awaiting` 只在这里出现，不是运行状态。"""

    SPEC = "spec"
    ARCH = "arch"
    UI = "ui"
    BUILD = "building"
    AWAITING = "awaiting"
    GENERATING = "generating"
    CHECKING = "checking"
    SAVING = "saving"
    DELIVER = "deliver"
    DONE = "done"
    FAILED = "failed"


class PhaseEvent(ApiModel):
    kind: Literal["phase"] = "phase"
    phase: GeneratePhase
    label: str
    note: Literal["callback"] | None = None


class ReasoningEvent(ApiModel):
    kind: Literal["reasoning"] = "reasoning"
    delta: str


class TextEvent(ApiModel):
    kind: Literal["text"] = "text"
    delta: str


class SpecEvent(ApiModel):
    kind: Literal["spec"] = "spec"
    spec: AppSpec
    gate: SpecGate
    # 降级产出：界面据此区分兜底与真规格
    fallback: bool


class ArchEvent(ApiModel):
    kind: Literal["arch"] = "arch"
    arch: ArchSpec
    check: StageCheck
    fallback: bool


class UiEvent(ApiModel):
    kind: Literal["ui"] = "ui"
    ui: UiSpec
    check: StageCheck
    fallback: bool


class ModulesEvent(ApiModel):
    kind: Literal["modules"] = "modules"
    batch: BuildBatchSummary


class UsageEvent(ApiModel):
    kind: Literal["usage"] = "usage"
    usage: TokenUsage
    cost_cny: float
    price_tier: PriceTier
    model: str
    latency_ms: int
    # 被输出上限截断：是预算问题，不是能力问题
    truncated: bool


class CheckEvent(ApiModel):
    kind: Literal["check"] = "check"
    results: list[CheckResult] = []
    summary: CheckSummary


class ArtifactEvent(ApiModel):
    kind: Literal["artifact"] = "artifact"
    artifact: Artifact


class ErrorEvent(ApiModel):
    kind: Literal["error"] = "error"
    message: str
    hint: str | None = None


class RetrievalHit(ApiModel):
    """一条检索命中。source 形如 `module-splitting.md §2`，界面直接显示为"依据"。"""

    source: str
    snippet: str
    score: float


class RetrievalEvent(ApiModel):
    kind: Literal["retrieval"] = "retrieval"
    query: str
    hits: list[RetrievalHit] = []
    latency_ms: int


class CostEvent(ApiModel):
    kind: Literal["cost"] = "cost"
    stage: str
    delta_cny: float
    total_cny: float


class FileEvent(ApiModel):
    """流式代码：只发增量，完整内容最后落 artifacts。

    - `delta` 为空且 `done=True`：表示这个文件开写/收尾
    - `lines`：当前累计行数，前端直接显示「流式写入 · N 行」
    """

    kind: Literal["file"] = "file"
    path: str
    lang: str
    delta: str = ""
    done: bool = False
    lines: int = 0


class VerdictEvent(ApiModel):
    """三层验收结果（db / api / ui）。"""

    kind: Literal["verdict"] = "verdict"
    layers: list[dict] = []
    passed: int = 0
    total: int = 0


GenerateEvent = Annotated[
    PhaseEvent
    | ReasoningEvent
    | TextEvent
    | SpecEvent
    | ArchEvent
    | UiEvent
    | ModulesEvent
    | UsageEvent
    | CheckEvent
    | ArtifactEvent
    | ErrorEvent
    | RetrievalEvent
    | CostEvent
    | FileEvent
    | VerdictEvent,
    Field(discriminator="kind"),
]
