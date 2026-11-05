"""运行（契约书 §8.1）。

`paused` 是运行状态（门禁停下、等用户回答），`awaiting` 只是 SSE 的一个 phase 值。
前端判断"要不要显示门禁表单"看 status === "paused"，不要看 phase。
"""

from enum import StrEnum

from app.domain.base import ApiModel


class StageId(StrEnum):
    """六道工序。刻意用最简单、最短的词：一眼能读懂，也不用猜缩写。"""

    PLAN = "plan"
    DESIGN = "design"
    BUILD = "build"
    ASSEMBLE = "assemble"
    TEST = "test"
    DELIVER = "deliver"


class RunStatus(StrEnum):
    RUNNING = "running"
    PAUSED = "paused"
    DONE = "done"
    FAILED = "failed"
    CANCELLED = "cancelled"


class TokenUsage(ApiModel):
    """thinking 计入 output 预算 —— 这条是全局不变量，两端都不得改写含义。"""

    input: int = 0
    output: int = 0
    thinking: int = 0
    cached: int | None = None


class Run(ApiModel):
    id: str
    prompt: str
    stage: StageId
    status: RunStatus
    total_cost_cny: float = 0
    usage: TokenUsage = TokenUsage()
    created_at: int
    updated_at: int
    workflow_version: str = "v1"


class RunSummary(ApiModel):
    """列表项。`time_label` 由服务端算（服务端时间是权威，避免 SSR 与水合不一致）。"""

    id: str
    prompt: str
    stage: StageId
    status: RunStatus
    total_cost_cny: float = 0
    created_at: int
    time_label: str
