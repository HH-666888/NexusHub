"""skill 层：把每个阶段的能力抽成可注册、可版本化的对象。

第一版不改变行为：system prompt 仍来自各 stage 模块的常量，
这里只负责命名、版本与查找。后续要换提示词或加技能，只动这一层。
"""

from __future__ import annotations

import importlib
from dataclasses import dataclass


@dataclass(frozen=True)
class Skill:
    name: str
    stage: str
    version: str
    module: str


SKILLS: dict[str, Skill] = {
    "plan": Skill("spec.writing", "plan", "v1", "app.v2.pipeline.stages.spec.run"),
    "design": Skill("arch.design", "design", "v1", "app.v2.pipeline.stages.design.run"),
    "build": Skill("code.file", "build", "v1", "app.v2.pipeline.stages.build.run"),
    "assemble": Skill("assemble.entry", "assemble", "v1", "app.v2.pipeline.stages.assemble.run"),
    "test": Skill("test.cases", "test", "v1", "app.v2.pipeline.stages.test.run"),
    "deliver": Skill("deliver.package", "deliver", "v1", "app.v2.pipeline.stages.deliver.run"),
}


def skill_for(stage: str) -> Skill:
    try:
        return SKILLS[stage]
    except KeyError as error:
        raise KeyError(f"没有为阶段 {stage} 注册 skill") from error


def system_prompt(stage: str) -> str:
    """返回该阶段当前使用的 system prompt（真实来源仍是 stage 模块）。"""
    skill = skill_for(stage)
    module = importlib.import_module(skill.module)
    prompt = getattr(module, "SYSTEM", "")
    if not prompt:
        raise AttributeError(f"{skill.module} 没有 SYSTEM")
    return prompt


def all_skills() -> list[Skill]:
    return list(SKILLS.values())