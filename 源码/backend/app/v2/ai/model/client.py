"""v2 模型客户端。

只做一件事：把 messages 发给 DeepSeek，返回内容与用量。
不在这里做业务判断，也不伪造任何用量。
"""

from __future__ import annotations

from dataclasses import dataclass

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
    ) -> ModelReply:
        body: dict = {
            "model": model,
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": temperature,
        }
        if json_mode:
            body["response_format"] = {"type": "json_object"}

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
                return ModelReply(
                    content=data["choices"][0]["message"]["content"] or "",
                    model=data.get("model", model),
                    prompt_tokens=int(usage.get("prompt_tokens") or 0),
                    completion_tokens=int(usage.get("completion_tokens") or 0),
                    latency_ms=_now_ms() - began,
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

    def close(self) -> None:
        self._http.close()


def _now_ms() -> int:
    import time

    return int(time.time() * 1000)


def _sleep(seconds: float) -> None:
    import time

    time.sleep(seconds)