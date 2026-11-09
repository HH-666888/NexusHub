"""v2 模型层单测：单价、解析、客户端、录制。"""

from __future__ import annotations

import json
from datetime import datetime

import httpx
import pytest

from app.v2.ai.cost.pricing import cost_cny, price_of, tier_of
from app.v2.ai.model.client import ModelClient, ModelError, ModelReply
from app.v2.ai.model.record import RecordedModelClient
from app.v2.ai.model.schema import parse_json, structured
from pydantic import BaseModel


class Demo(BaseModel):
    text: str


def test_tier_peak_and_offpeak() -> None:
    peak = datetime(2026, 1, 1, 10, 0, tzinfo=__import__("zoneinfo").ZoneInfo("Asia/Shanghai"))
    late = datetime(2026, 1, 1, 2, 0, tzinfo=__import__("zoneinfo").ZoneInfo("Asia/Shanghai"))
    assert tier_of(peak) == "peak"
    assert tier_of(late) == "offpeak"


def test_cost_is_usage_times_price() -> None:
    price = price_of("deepseek-chat")
    expected = round(
        (1000 * price.in_price + 500 * price.out_price) / 1_000_000,
        6,
    )
    assert cost_cny("deepseek-chat", 1000, 500) == expected


def test_parse_strips_fences() -> None:
    assert parse_json('```json\n{"text":"ok"}\n```') == {"text": "ok"}


def test_client_maps_usage(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == "Bearer test-key"
        body = json.loads(request.content)
        assert body["model"] == "deepseek-chat"
        assert body["response_format"] == {"type": "json_object"}
        return httpx.Response(
            200,
            json={
                "model": "deepseek-chat",
                "choices": [{"message": {"content": '{"text":"hi"}'}}],
                "usage": {"prompt_tokens": 12, "completion_tokens": 3},
            },
        )

    client = ModelClient("test-key", transport=httpx.MockTransport(handler))
    reply = client.complete([{"role": "user", "content": "hi"}], "deepseek-chat", json_mode=True)
    assert reply.content == '{"text":"hi"}'
    assert reply.prompt_tokens == 12
    assert reply.completion_tokens == 3


def test_client_rejects_without_key() -> None:
    with pytest.raises(ModelError):
        ModelClient("")


def test_client_raises_on_4xx() -> None:
    client = ModelClient(
        "bad",
        transport=httpx.MockTransport(lambda request: httpx.Response(401, text="nope")),
    )
    with pytest.raises(ModelError):
        client.complete([{"role": "user", "content": "x"}], "deepseek-chat")


def test_structured_repairs_once() -> None:
    calls = {"n": 0}

    class FakeClient:
        def complete(self, messages, model, **kwargs):  # noqa: ANN001
            calls["n"] += 1
            content = "not json" if calls["n"] == 1 else '{"text":"fixed"}'
            return ModelReply(content, model, 1, 1, 1)

    value, reply = structured(FakeClient(), [{"role": "user", "content": "x"}], "m", Demo)
    assert value.text == "fixed"
    assert calls["n"] == 2


def test_record_then_replay(tmp_path) -> None:
    inner = ModelClient(
        "k",
        transport=httpx.MockTransport(
            lambda request: httpx.Response(
                200,
                json={
                    "model": "deepseek-chat",
                    "choices": [{"message": {"content": "hello"}}],
                    "usage": {"prompt_tokens": 1, "completion_tokens": 2},
                },
            )
        ),
    )
    recorder = RecordedModelClient(inner, "record", tmp_path)
    first = recorder.complete([{"role": "user", "content": "x"}], "deepseek-chat")
    assert first.content == "hello"

    replay = RecordedModelClient(None, "replay", tmp_path)
    second = replay.complete([{"role": "user", "content": "x"}], "deepseek-chat")
    assert second.content == "hello"


def test_replay_missing_raises(tmp_path) -> None:
    replay = RecordedModelClient(None, "replay", tmp_path)
    with pytest.raises(ModelError):
        replay.complete([{"role": "user", "content": "missing"}], "deepseek-chat")