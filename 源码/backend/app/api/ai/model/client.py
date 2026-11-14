"""模型客户端。

只做一件事：把 messages 发给 DeepSeek，返回内容与用量。
不在这里做业务判断，也不伪造任何用量。
"""

from __future__ import annotations

from dataclasses import dataclass

import json

import httpx


class ModelError(Exception):
    """模型不可用（网络、限流、服务端错误）。"""


class ModelFormatError(Exception):
    """模型返回的内容无法解析成约定结构。"""


@dataclass
class ModelReply:
    content: str
    model: str
    prompt_tokens: int
    completion_tokens: int
    latency_ms: int
    finish_reason: str = ""
    tool_calls: list[dict] | None = None


class ModelClient:
    def __init__(
        self,
        api_key: str,
        base_url: str = "https://api.deepseek.com",
        timeout: float = 60.0,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        if not api_key:
            raise ModelError("没有配置 DEEPSEEK_API_KEY")
        self._key = api_key
        self._base = base_url.rstrip("/")
        self._http = httpx.Client(timeout=timeout, transport=transport)

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
        body: dict = {
            "model": model,
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": temperature,
        }
        if json_mode:
            body["response_format"] = {"type": "json_object"}
        if tools:
            body["tools"] = tools
            body["tool_choice"] = tool_choice or "auto"

        last_error: Exception | None = None
        for attempt in range(3):
            try:
                began = _now_ms()
                response = self._http.post(
                    f"{self._base}/chat/completions",
                    headers={"Authorization": f"Bearer {self._key}"},
                    json=body,
                )
                if response.status_code == 429 or response.status_code >= 500:
                    raise ModelError(f"HTTP {response.status_code}")
                if response.status_code >= 400:
                    raise ModelError(f"HTTP {response.status_code}: {response.text[:200]}")
                data = response.json()
                usage = data.get("usage") or {}
                message = data["choices"][0].get("message") or {}
                return ModelReply(
                    content=message.get("content") or "",
                    tool_calls=message.get("tool_calls") or None,
                    model=data.get("model", model),
                    prompt_tokens=int(usage.get("prompt_tokens") or 0),
                    completion_tokens=int(usage.get("completion_tokens") or 0),
                    latency_ms=_now_ms() - began,
                    finish_reason=str(data["choices"][0].get("finish_reason") or ""),
                )
            except ModelError as error:
                last_error = error
                if attempt < 2:
                    _sleep(1.5 ** attempt)
            except (httpx.HTTPError, KeyError, ValueError) as error:
                last_error = ModelError(str(error))
                if attempt < 2:
                    _sleep(1.5 ** attempt)
        raise ModelError(str(last_error) if last_error else "模型调用失败")

    def stream(
        self,
        messages: list[dict],
        model: str,
        *,
        max_tokens: int = 800,
        temperature: float = 0.2,
    ) -> "ModelStream":
        body: dict = {
            "model": model,
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": temperature,
        }
        return ModelStream(self, body, model)

    def close(self) -> None:
        self._http.close()


def _now_ms() -> int:
    import time

    return int(time.time() * 1000)


def _sleep(seconds: float) -> None:
    import time

    time.sleep(seconds)


class ModelStream:
    """真正的 SSE 流式响应：边收边吐 delta，结束后在 reply 上留完整结果。"""

    def __init__(self, client: ModelClient, body: dict, model: str) -> None:
        self._client = client
        self._body = dict(body)
        self._model = model
        self.reply: ModelReply | None = None

    def __iter__(self):
        body = dict(self._body)
        body["stream"] = True
        body["stream_options"] = {"include_usage": True}
        began = _now_ms()
        pieces: list[str] = []
        usage: dict = {}
        finish = ""
        model_name = self._model

        with self._client._http.stream(
            "POST",
            f"{self._client._base}/chat/completions",
            headers={"Authorization": f"Bearer {self._client._key}"},
            json=body,
        ) as response:
            if response.status_code >= 400:
                response.read()
                raise ModelError(f"HTTP {response.status_code}: {response.text[:200]}")
            for line in response.iter_lines():
                if not line:
                    continue
                if not line.startswith("data:"):
                    continue
                raw = line[5:].strip()
                if raw == "[DONE]":
                    break
                try:
                    chunk = json.loads(raw)
                except ValueError:
                    continue
                if chunk.get("model"):
                    model_name = chunk["model"]
                if chunk.get("usage"):
                    usage = chunk["usage"]
                choices = chunk.get("choices") or []
                if not choices:
                    continue
                choice = choices[0]
                finish = choice.get("finish_reason") or finish
                delta = choice.get("delta") or {}
                text = delta.get("content") or ""
                if text:
                    pieces.append(text)
                    yield text

        self.reply = ModelReply(
            content="".join(pieces),
            model=model_name,
            prompt_tokens=int(usage.get("prompt_tokens") or 0),
            completion_tokens=int(usage.get("completion_tokens") or 0),
            latency_ms=_now_ms() - began,
            finish_reason=finish,
        )
