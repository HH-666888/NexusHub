"""规格（契约书 §8.2）。

`questions` 非空时门禁触发 —— 这是"先问清楚再动手"的落点。
"""

from enum import StrEnum

from app.domain.base import ApiModel


class AcceptanceCriterion(ApiModel):
    id: str
    text: str
    kind: str = "behavior"


class SpecScope(ApiModel):
    in_scope: list[str] = []
    out_of_scope: list[str] = []


class AppSpec(ApiModel):
    prompt: str  # 用户原话，一字不改
    goal: str
    audience: str
    scenarios: list[str] = []
    acceptance: list[AcceptanceCriterion] = []
    scope: SpecScope = SpecScope()
    questions: list[str] = []
    model: str
    generated_at: int


class SpecGate(StrEnum):
    """人工门禁的运行时取值。真相来源是 stages.ts 的 humanGate 声明 + gate-policy。"""

    DECLARED = "declared"
    PAUSE = "pause"
    CONTINUE = "continue"


class SpecAnswer(ApiModel):
    question: str
    answer: str


class SpecAnswers(ApiModel):
    answers: list[SpecAnswer] = []
    revise: bool = False


class SpecAck(ApiModel):
    """「知悉并继续」的凭据。有它就不再重复拦同一批问题。"""

    acknowledged_at: int
    questions: list[str] = []
