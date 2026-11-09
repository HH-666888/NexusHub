"""结构化输出：解析 JSON、校验、失败修复一次。

原则：解析失败就说失败，不猜、不编。
"""

from __future__ import annotations

import json
import re

from pydantic import BaseModel, ValidationError

from app.v2.ai.model.client import ModelClient, ModelFormatError, ModelReply

_FENCE = re.compile(r"^\s*```(?:json)?\s*|\s*```\s*$", re.MULTILINE)


def parse_json(text: str) -> object:
    cleaned = _FENCE.sub("", text or "").strip()
    return json.loads(cleaned)


def structured(
    client: ModelClient,
    messages: list[dict],
    model: str,
    schema: type[BaseModel],
    *,
    max_tokens: int = 800,
    temperature: float = 0.2,
) -> tuple[BaseModel, ModelReply]:
    """一次调用 + 一次修复尝试。失败抛 ModelFormatError。"""
    reply = client.complete(
        messages, model, max_tokens=max_tokens, temperature=temperature, json_mode=True
    )
    try:
        return schema.model_validate(parse_json(reply.content)), reply
    except (json.JSONDecodeError, ValidationError) as error:
        repair = list(messages) + [
            {"role": "assistant", "content": reply.content},
            {
                "role": "user",
                "content": f"上面的输出不合法：{error}。只输出修复后的 JSON，不要解释。",
            },
        ]
        reply2 = client.complete(
            repair, model, max_tokens=max_tokens, temperature=temperature, json_mode=True
        )
        try:
            return schema.model_validate(parse_json(reply2.content)), reply2
        except (json.JSONDecodeError, ValidationError) as error2:
            raise ModelFormatError(str(error2)) from error2