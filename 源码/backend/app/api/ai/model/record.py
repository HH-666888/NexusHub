"""录制回放：让测试与离线演示不依赖真实网络。

- off：直连
- record：直连并落盘
- replay：只读盘，未命中直接报错（不编造回复）
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from app.api.ai.model.client import ModelClient, ModelError, ModelReply


def _digest(model: str, messages: list[dict], max_tokens: int, temperature: float) -> str:
    raw = json.dumps(
        {"model": model, "messages": messages, "max_tokens": max_tokens, "temperature": temperature},
        ensure_ascii=False,
        sort_keys=True,
    )
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


class RecordedModelClient:
    """与 ModelClient 同接口，可被编排器无缝替换。"""

    def __init__(self, inner: ModelClient | None, mode: str, cassette_dir: Path) -> None:
        self._inner = inner
        self._mode = mode if mode in {"off", "record", "replay"} else "off"
        self._dir = Path(cassette_dir)
        if self._mode in {"record", "replay"}:
            self._dir.mkdir(parents=True, exist_ok=True)

    def complete(
        self,
        messages: list[dict],
        model: str,
        *,
        max_tokens: int = 800,
        temperature: float = 0.2,
        json_mode: bool = False,
        tools: list[dict] | None = None,
        tool_choice: str | None = None,
    ) -> ModelReply:
        key = _digest(model, messages, max_tokens, temperature)
        path = self._dir / f"{key}.json"

        if self._mode == "replay":
            if not path.is_file():
                raise ModelError(f"回放缺少录制：{key}")
            data = json.loads(path.read_text(encoding="utf-8"))
            return ModelReply(**data)

        if self._inner is None:
            raise ModelError("录制/直连模式需要模型客户端")
        reply = self._inner.complete(
            messages,
            model,
            max_tokens=max_tokens,
            temperature=temperature,
            json_mode=json_mode,
            tools=tools,
            tool_choice=tool_choice,
        )
        if self._mode == "record":
            path.write_text(
                json.dumps(reply.__dict__, ensure_ascii=False, indent=2), encoding="utf-8"
            )
        return reply

    def stream(
        self,
        messages: list[dict],
        model: str,
        *,
        max_tokens: int = 800,
        temperature: float = 0.2,
    ):
        if self._mode == "replay":
            raise ModelError("回放模式不支持流式")
        if self._inner is None:
            raise ModelError("录制/直连模式需要模型客户端")
        return self._inner.stream(messages, model, max_tokens=max_tokens, temperature=temperature)

    def close(self) -> None:
        if self._inner is not None:
            self._inner.close()