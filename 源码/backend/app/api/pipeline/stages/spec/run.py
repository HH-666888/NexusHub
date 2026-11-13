"""需求分析：把一句话变成可执行的规格。

真实调用模型；解析失败就报错；有问题就停下来问。
"""

from __future__ import annotations

import hashlib
import time
from typing import Any

from app.api.ai.cost.ledger import record_cost
from app.api.ai.factory import build_client, model_for
from app.api.ai.model.schema import structured
from app.api.domain.models import SpecV2
from app.api.pipeline import gate, recorder
from app.db.session import SessionLocal
from app.config import get_settings
from app.api.pipeline.context import RunContext
from app.api.pipeline.errors import BudgetExceeded

SYSTEM = """你是软件需求分析师。只做一件事：把用户的一句话变成可执行的软件规格。

硬性规则：
1. 不写代码，不设计架构，不讨论实现。
2. 每条验收标准必须能被一条 HTTP 请求或一次页面操作验证，不超过 30 个字。
3. 有歧义就问，问题数量不设上限；每个问题必须给出默认答案；能合理假设的写进 assumptions。
4. 只输出 JSON，不要 Markdown 围栏，不要解释。
5. 字段缺失视为失败。

输出 schema：
{
  "goal": "一句话说明这个软件要解决什么",
  "audience": "给谁用",
  "scenarios": ["使用场景，2-4 条"],
  "acceptance": [{"id": "a1", "text": "可验证的标准"}],
  "out_of_scope": ["明确不做的"],
  "assumptions": ["合理假设"],
  "questions": [
    {"id": "q1", "type": "single", "text": "问题", "options": ["A","B"], "default": "A"}
  ]
}

题型：single（单选）、multi（多选）、text（自由文本）。text 题可以不写 options。
"""


def _task_id(run_id: str, title: str) -> str:
    digest = hashlib.sha1(f"{run_id}:plan:{title}".encode()).hexdigest()[:6]
    return f"task-plan-{digest}"


def run(run_id: str, ctx: RunContext) -> SpecV2:
    clarify = _task_id(run_id, "澄清需求边界")
    acceptance_task = _task_id(run_id, "写验收标准")

    recorder.task(run_id, "created", task_id=clarify, stage="plan", title="澄清需求边界", kind="clarify")
    recorder.task(run_id, "created", task_id=acceptance_task, stage="plan", title="写验收标准", kind="spec")
    recorder.task(run_id, "started", task_id=clarify, stage="plan", title="澄清需求边界", kind="clarify")
    recorder.reasoning(run_id, f"先确认「{ctx.prompt[:18]}」要做什么、不做什么。")

    client = build_client("plan")
    model = model_for("plan")
    messages = [
        {"role": "system", "content": SYSTEM},
        {"role": "user", "content": f"用户需求：{ctx.prompt}\n\n请输出规格 JSON。"},
    ]

    began = time.monotonic()
    try:
        spec, reply = structured(client, messages, model, SpecV2, max_tokens=900, temperature=0.2)
    finally:
        client.close()

    db = SessionLocal()
    try:
        amount = record_cost(db, run_id=run_id, stage="plan", reply=reply)
    finally:
        db.close()
    recorder.usage(
        run_id,
        model=reply.model,
        prompt_tokens=reply.prompt_tokens,
        completion_tokens=reply.completion_tokens,
        latency_ms=reply.latency_ms,
        cny=amount,
    )
    recorder.cost(run_id, "plan", amount, recorder.total_cost(run_id))

    if recorder.total_cost(run_id) >= get_settings().run_cost_limit_cny:
        raise BudgetExceeded()

    recorder.task(
        run_id,
        "done",
        task_id=clarify,
        stage="plan",
        title="澄清需求边界",
        kind="clarify",
        note="边界已定" if not spec.questions else f"{len(spec.questions)} 个待确认",
        ms=int((time.monotonic() - began) * 1000),
    )

    recorder.task(run_id, "started", task_id=acceptance_task, stage="plan", title="写验收标准", kind="spec")

    if spec.questions:
        answers = gate.ask_user(
            run_id,
            stage="plan",
            questions=[q.model_dump() for q in spec.questions],
        )
        ctx.answers.extend(answers)
        answered = {a["id"]: str(a.get("value") or "") for a in answers}
        for question in spec.questions:
            spec.assumptions.append(f"{question.text} → {answered.get(question.id, question.default)}")

    recorder.task(
        run_id,
        "done",
        task_id=acceptance_task,
        stage="plan",
        title="写验收标准",
        kind="spec",
        note=f"{len(spec.acceptance)} 条",
    )

    recorder.emit(
        run_id,
        "spec",
        {"spec": spec.model_dump(), "gate": "declared", "fallback": False},
    )
    ctx.spec = spec.model_dump()
    return spec


