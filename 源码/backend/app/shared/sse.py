"""SSE 帧与心跳。

契约书 §6.1：只有 `data:` 行，一帧一个 JSON 对象，事件类型放在 payload.kind 里。
`no-transform`、`X-Accel-Buffering: no` 这些头在 stream 路由里设置。
"""

import json
from collections.abc import Mapping
from typing import Any

HEARTBEAT_SECONDS = 15
HEARTBEAT_FRAME = ": ping\n\n"

SSE_HEADERS = {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-store, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
}


def format_event(payload: Mapping[str, Any]) -> str:
    """一帧。compact 分隔符：少几个空格，长流里也是钱。"""
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    return f"data: {body}\n\n"
