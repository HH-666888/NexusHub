"""事件构造。

所有事件都从这里产出 —— payload 与 SSE 帧是同一份 JSON（数据库契约 §3.4，
回放与直播因此共用一套前端代码）。别处手拼字典一律算违规。

每个函数只做"把参数装进对应类型"，不判业务（该不该发、发几次由 orchestrator 决定）。
"""

from typing import Any

from app.domain.arch import ArchSpec
from app.domain.artifact import Artifact
from app.domain.check import CheckResult, CheckSummary, StageCheck
from app.domain.cost import PriceTier
from app.domain.event import (
    ArchEvent,
    ArtifactEvent,
    CheckEvent,
    CostEvent,
    ErrorEvent,
    GenerateEvent,
    GeneratePhase,
    ModulesEvent,
    PhaseEvent,
    ReasoningEvent,
    RetrievalEvent,
    RetrievalHit,
    SpecEvent,
    TextEvent,
    UiEvent,
    UsageEvent,
)
from app.domain.module_build import BuildBatchSummary
from app.domain.run import TokenUsage
from app.domain.spec import AppSpec, SpecGate
from app.domain.ui import UiSpec
from app.shared.sse import format_event


def phase(value: GeneratePhase, label: str, *, callback: bool = False) -> PhaseEvent:
    """阶段推进。`callback=True` 时前端会把这句留在固定位置（回流标记）。"""
    return PhaseEvent(phase=value, label=label, note="callback" if callback else None)


def reasoning(delta: str) -> ReasoningEvent:
    return ReasoningEvent(delta=delta)


def text(delta: str) -> TextEvent:
    return TextEvent(delta=delta)


def spec_event(spec: AppSpec, gate: SpecGate, *, fallback: bool = False) -> SpecEvent:
    return SpecEvent(spec=spec, gate=gate, fallback=fallback)


def arch_event(arch: ArchSpec, check: StageCheck, *, fallback: bool = False) -> ArchEvent:
    return ArchEvent(arch=arch, check=check, fallback=fallback)


def ui_event(ui: UiSpec, check: StageCheck, *, fallback: bool = False) -> UiEvent:
    return UiEvent(ui=ui, check=check, fallback=fallback)


def modules(batch: BuildBatchSummary) -> ModulesEvent:
    return ModulesEvent(batch=batch)


def usage(
    *,
    tokens: TokenUsage,
    cost_cny: float,
    price_tier: PriceTier,
    model: str,
    latency_ms: int,
    truncated: bool,
) -> UsageEvent:
    return UsageEvent(
        usage=tokens,
        cost_cny=cost_cny,
        price_tier=price_tier,
        model=model,
        latency_ms=latency_ms,
        truncated=truncated,
    )


def check(results: list[CheckResult], summary: CheckSummary) -> CheckEvent:
    return CheckEvent(results=results, summary=summary)


def artifact(value: Artifact) -> ArtifactEvent:
    return ArtifactEvent(artifact=value)


def error(message: str, hint: str | None = None) -> ErrorEvent:
    return ErrorEvent(message=message, hint=hint)


def retrieval(query: str, hits: list[RetrievalHit], *, latency_ms: int) -> RetrievalEvent:
    """计划：RAG 的命中记录。界面据此显示"依据：某文档 §某节"。"""
    return RetrievalEvent(query=query, hits=hits, latency_ms=latency_ms)


def cost(*, stage: str, delta_cny: float, total_cny: float) -> CostEvent:
    """计划：逐笔成本，配合 usage 事件给前端的成本面板用。"""
    return CostEvent(stage=stage, delta_cny=delta_cny, total_cny=total_cny)


def to_frame(event: GenerateEvent) -> str:
    """事件 → SSE 帧。序列化统一走这里，保证与写库的 JSON 是同一份。"""
    payload: dict[str, Any] = event.model_dump(by_alias=True, mode="json")
    return format_event(payload)
