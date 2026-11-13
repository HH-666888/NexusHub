"""一次运行在内存里的上下文。

只放数据，不碰数据库；每个阶段自己开 Session。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class RunContext:
    run_id: str
    prompt: str
    spec: dict[str, Any] | None = None
    arch: dict[str, Any] | None = None
    answers: list[dict[str, Any]] = field(default_factory=list)
    files: dict[str, str] = field(default_factory=dict)
    workspace: str = ""
    failures: list[str] = field(default_factory=list)
    checks: list[dict] = field(default_factory=list)

    def answer(self, question_id: str, fallback: str = "") -> str:
        for item in self.answers:
            if item.get("id") == question_id:
                return str(item.get("value") or fallback)
        return fallback