"""事件构造与序列化（契约书 §7、数据库契约 §3.4）。

锁三件事：
1. 每个事件都带正确的 kind，能被可辨识联合反解出来；
2. JSON 字段名是 camelCase（回放与前端都依赖）；
3. SSE 帧是单行 data，且与写库的 JSON 是同一份。
"""

import json

import pytest
from pydantic import TypeAdapter, ValidationError

from app.domain.artifact import Artifact, ArtifactKind
from app.domain.check import CheckResult, CheckSummary
from app.domain.cost import PriceTier
from app.domain.event import GenerateEvent, GeneratePhase
from app.domain.run import TokenUsage
from app.pipeline import events


def test_phase_event_has_kind_and_camel_label() -> None:
    event = events.phase(GeneratePhase.SPEC, "正在理解需求")

    assert event.kind == "phase"
    assert event.phase == "spec"
    assert event.model_dump(by_alias=True) == {
        "kind": "phase",
        "phase": "spec",
        "label": "正在理解需求",
        "note": None,
    }


def test_callback_note_is_set_only_when_asked() -> None:
    assert events.phase(GeneratePhase.GENERATING, "接着上次跑", callback=True).note == "callback"
    assert events.phase(GeneratePhase.GENERATING, "开始生成").note is None


def test_usage_event_serialises_price_tier_as_camel() -> None:
    event = events.usage(
        tokens=TokenUsage(input=10, output=20, thinking=5),
        cost_cny=0.00231,
        price_tier=PriceTier.OFF_PEAK,
        model="deepseek-chat",
        latency_ms=18400,
        truncated=False,
    )

    payload = event.model_dump(by_alias=True)
    assert payload["priceTier"] == "offPeak"
    assert payload["costCny"] == 0.00231
    assert payload["usage"]["thinking"] == 5


def test_check_event_uses_pass_key() -> None:
    result = CheckResult(name="无外部依赖", pass_=True, detail="0 个外链")
    summary = CheckSummary(total=1, passed=1, failed=0, failures=[])

    payload = events.check([result], summary).model_dump(by_alias=True)

    assert payload["results"][0]["pass"] is True
    assert payload["summary"]["failed"] == 0


def test_artifact_event_carries_name_not_path() -> None:
    """产物内容入库后没有 path（数据库契约 §3.6），事件里也不该出现。"""
    value = Artifact(
        id=41,
        run_id="9f2c7a41b3e54d0f9a1c2b3d4e",
        kind=ArtifactKind.HTML,
        name="plan.html",
        bytes=18234,
        sha256="a" * 64,
        created_at=1793520180000,
    )

    payload = events.artifact(value).model_dump(by_alias=True)

    assert payload["artifact"]["name"] == "plan.html"
    assert "path" not in payload["artifact"]


def test_planned_events_are_registered() -> None:
    """tool / retrieval / cost 是契约里"计划"的三种，名字与字段先占住。"""
    retrieved = events.retrieval("模块划分", [], latency_ms=12)
    spent = events.cost(stage="spec", delta_cny=0.001, total_cny=0.001)

    assert retrieved.kind == "retrieval"
    assert spent.kind == "cost"
    assert spent.model_dump(by_alias=True)["deltaCny"] == 0.001


def test_every_built_event_round_trips_through_the_union() -> None:
    adapter = TypeAdapter(GenerateEvent)
    built = [
        events.phase(GeneratePhase.DONE, "完成"),
        events.reasoning("先看需求"),
        events.text("<div>"),
        events.error("模型超时", "稍后重试"),
        events.retrieval("q", [], latency_ms=1),
        events.cost(stage="spec", delta_cny=0.0, total_cny=0.0),
    ]

    for event in built:
        payload = event.model_dump(by_alias=True, mode="json")
        parsed = adapter.validate_python(payload)
        assert type(parsed) is type(event)
        assert parsed.kind == event.kind


def test_unknown_kind_is_rejected_by_the_union() -> None:
    """后端自己也不许发契约外的事件类型。"""
    adapter = TypeAdapter(GenerateEvent)

    with pytest.raises(ValidationError):
        adapter.validate_python({"kind": "brand_new_event"})


def test_frame_is_single_data_line_with_same_json_as_storage() -> None:
    event = events.text("你好")
    frame = events.to_frame(event)

    assert frame.startswith("data: ")
    assert frame.endswith("\n\n")
    assert frame.count("\n\n") == 1

    payload = json.loads(frame[len("data: ") : -2])
    assert payload == event.model_dump(by_alias=True, mode="json")
    assert "你好" in frame
