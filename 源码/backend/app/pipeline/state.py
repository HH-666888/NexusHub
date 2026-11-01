"""阶段状态机。

每道工序自己的状态只有三种，与运行的 status 不是一回事：运行可以 paused，
而阶段只是 pending（还没轮到）。
"""

from enum import StrEnum


class StageState(StrEnum):
    PENDING = "pending"
    RUNNING = "running"
    PASSED = "passed"
