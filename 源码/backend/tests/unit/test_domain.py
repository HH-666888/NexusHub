"""阶段状态机与领域模型的单测：状态取值是契约的一部分，改一个值就要改契约。"""

import pytest

from app.domain.check import CheckResult, CheckSummary
from app.domain.run import Run, RunStatus, StageId, TokenUsage
from app.pipeline.state import StageState


def test_stage_states_are_three() -> None:
    assert [s.value for s in StageState] == ["pending", "running", "passed"]


def test_run_json_uses_camel_case() -> None:
    run = Run(
        id="9f2c7a41b3e54d0f9a1c2b3d4e",
        prompt="做一个番茄钟",
        stage=StageId.PLAN,
        status=RunStatus.RUNNING,
        total_cost_cny=0.0,
        usage=TokenUsage(input=10, output=20, thinking=5),
        created_at=1793520000000,
        updated_at=1793520000000,
    )

    body = run.model_dump(by_alias=True)
    assert body["totalCostCny"] == 0.0
    assert body["createdAt"] == 1793520000000
    assert body["workflowVersion"] == "v1"
    assert body["usage"] == {"input": 10, "output": 20, "thinking": 5, "cached": None}
    # snake_case 只属于 Python 侧
    assert "total_cost_cny" not in body


def test_check_result_outputs_pass_key() -> None:
    """`pass` 是 Python 关键字，但 JSON 里必须是 pass —— 前端按这个名字读。"""
    result = CheckResult(name="无外部依赖", pass_=True, detail="0 个外链")

    body = result.model_dump(by_alias=True)
    assert body == {"name": "无外部依赖", "pass": True, "detail": "0 个外链"}


def test_check_summary_counts_are_consistent() -> None:
    summary = CheckSummary(total=8, passed=7, failed=1, failures=[])

    assert summary.total == summary.passed + summary.failed


def test_paused_is_a_run_status_not_a_phase() -> None:
    """门禁停的是运行（paused），awaiting 只是 SSE 的 phase —— 两件事别混。"""
    assert RunStatus.PAUSED in RunStatus
    assert "awaiting" not in [s.value for s in RunStatus]


@pytest.mark.parametrize("stage", ["plan", "design", "build", "assemble", "test", "deliver"])
def test_six_stages_exist(stage: str) -> None:
    assert StageId(stage).value == stage
