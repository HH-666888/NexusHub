"""接口的数据形状。

不复用旧版 AppSpec：旧版的 questions 是字符串列表，
门禁需要题型、选项与默认值。
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class Question(BaseModel):
    id: str
    type: Literal["single", "multi", "text"] = "single"
    text: str
    options: list[str] = Field(default_factory=list)
    default: str = ""

    def model_post_init(self, __context) -> None:  # noqa: D401
        if self.type != "text" and not self.options:
            raise ValueError(f"问题 {self.id} 是选项题，但 options 为空")


class AcceptanceItem(BaseModel):
    id: str
    text: str


class SpecV2(BaseModel):
    goal: str
    audience: str
    scenarios: list[str] = Field(default_factory=list)
    acceptance: list[AcceptanceItem] = Field(default_factory=list)
    out_of_scope: list[str] = Field(default_factory=list)
    assumptions: list[str] = Field(default_factory=list)
    questions: list[Question] = Field(default_factory=list)


class ModuleV2(BaseModel):
    id: str
    name: str
    responsibility: str
    files: list[str]
    covers: list[str] = Field(default_factory=list)


class DependencyV2(BaseModel):
    source: str = Field(alias="from")
    target: str = Field(alias="to")

    model_config = {"populate_by_name": True}


class ArchV2(BaseModel):
    modules: list[ModuleV2]
    dependencies: list[DependencyV2] = Field(default_factory=list)
    entry: str
    port: int = 8000