"""编排层异常。"""

from __future__ import annotations


class BudgetExceeded(Exception):
    """单次预算到顶，运行应暂停。"""


class StageNotReady(Exception):
    """该阶段还没实现。"""


class StageFailed(Exception):
    """阶段执行失败，且带人话原因。"""