"""产物检查（契约书 §7 的 check 事件、§8）。

JSON 字段名必须是 `pass`（前端与既有事件都这么读），Python 里 `pass` 是关键字，
所以属性叫 `pass_`，靠显式 alias 输出成 `pass`。
"""

from pydantic import Field

from app.domain.base import ApiModel


class CheckResult(ApiModel):
    name: str
    pass_: bool = Field(alias="pass")
    detail: str


class CheckSummary(ApiModel):
    total: int
    passed: int
    failed: int
    failures: list[CheckResult] = []


class StageCheckItem(ApiModel):
    """单阶段（架构 / 界面）的检查条目，形状与产物检查一致。"""

    name: str
    pass_: bool = Field(alias="pass")
    detail: str


class StageCheck(ApiModel):
    """架构检查与界面检查共用的形状：逐条结果 + 汇总计数。"""

    results: list[StageCheckItem] = []
    passed: int
    total: int
