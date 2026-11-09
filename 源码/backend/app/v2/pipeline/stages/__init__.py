"""六道工序的注册表。

已实现的阶段跑真实逻辑；未实现的阶段抛 StageNotReady，
编排器把它记成明确失败，而不是假装完成。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from app.v2.pipeline.context import RunContext


class StageNotReady(Exception):
    """该阶段还没实现。"""


@dataclass(frozen=True)
class Stage:
    id: str
    phase: str
    label: str
    handler: Callable[[str, RunContext], object]


def _not_ready(stage: str):
    def _raise(run_id: str, ctx: RunContext) -> None:
        raise StageNotReady(f"阶段 {stage} 尚未实现")

    return _raise


def _spec():
    from app.v2.pipeline.stages.spec.run import run

    return run


def _design():
    from app.v2.pipeline.stages.design.run import run

    return run


def _build():
    from app.v2.pipeline.stages.build.run import run

    return run


def _assemble():
    from app.v2.pipeline.stages.assemble.run import run

    return run


def _test():
    from app.v2.pipeline.stages.test.run import run

    return run


def _deliver():
    from app.v2.pipeline.stages.deliver.run import run

    return run


STAGES: list[Stage] = [
    Stage("plan", "spec", "需求分析", _spec()),
    Stage("design", "arch", "架构设计", _design()),
    Stage("build", "building", "并行开发", _build()),
    Stage("assemble", "saving", "集成装配", _assemble()),
    Stage("test", "checking", "自动测试", _test()),
    Stage("deliver", "deliver", "验收交付", _deliver()),
]