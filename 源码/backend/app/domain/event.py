"""事件类型（契约书 §7）。

`kind` 是判别字段。**新增 kind 必须先改契约书**，前端遇到未知 kind 必须忽略而不是崩溃。

带 ⏳ 的是契约里已登记、实现待做（tool / retrieval / cost）——先占住名字，
免得以后各写各的。
"""

from enum import StrEnum


class EventKind(StrEnum):
    # 已实现
    PHASE = "phase"
    REASONING = "reasoning"
    TEXT = "text"
    SPEC = "spec"
    ARCH = "arch"
    UI = "ui"
    MODULES = "modules"
    USAGE = "usage"
    CHECK = "check"
    ARTIFACT = "artifact"
    ERROR = "error"
    # ⏳ 计划
    TOOL = "tool"
    RETRIEVAL = "retrieval"
    COST = "cost"


class GeneratePhase(StrEnum):
    """`phase` 事件的 phase 字段取值。注意 `awaiting` 只在这里出现，不是运行状态。"""

    SPEC = "spec"
    ARCH = "arch"
    UI = "ui"
    BUILD = "building"
    AWAITING = "awaiting"
    GENERATING = "generating"
    CHECKING = "checking"
    SAVING = "saving"
    DONE = "done"
    FAILED = "failed"
