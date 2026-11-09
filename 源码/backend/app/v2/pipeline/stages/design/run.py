"""架构设计：规格 → 模块、文件、依赖。

模型给出设计后，这里做机器校验：
覆盖、无环、文件唯一、入口存在。校验不过就带着问题重来一次。
"""

from __future__ import annotations

import hashlib
import time
from typing import Any

from app.config import get_settings
from app.db.session import SessionLocal
from app.v2.ai.cost.ledger import record_cost
from app.v2.ai.factory import build_client, model_for
from app.v2.ai.model.schema import structured
from app.v2.domain.models import ArchV2
from app.v2.pipeline import recorder
from app.v2.pipeline.context import RunContext
from app.v2.pipeline.errors import BudgetExceeded, StageFailed

SYSTEM = """你是软件架构师。基于规格设计一个最小可运行的全栈应用。

技术约束（必须遵守）：
1. 后端 Python 3.12 + sqlite3；如需 Web 框架只能用 FastAPI（已安装）。
2. 前端原生 HTML/CSS/JS，不引任何 CDN 或第三方库。
3. 模块 2-4 个，每个模块至少覆盖一条验收标准。
4. 依赖必须单向，不允许环。
5. 必须给出文件清单，路径相对工作区：db/…、api/…、web/…。
6. 只输出 JSON。

schema：
{
  "modules": [
    {"id": "db", "name": "数据库", "responsibility": "…",
     "files": ["db/schema.sql"], "covers": ["a1","a2"]}
  ],
  "dependencies": [{"from": "web", "to": "api"}],
  "entry": "api/main.py",
  "port": 8000
}
"""

RETRY_HINT = """上一次设计有以下问题，请逐条修掉后再输出完整 JSON：
{problems}
"""


def _task_id(run_id: str, title: str) -> str:
    return "task-design-" + hashlib.sha1(f"{run_id}:design:{title}".encode()).hexdigest()[:6]


def _validate(arch: ArchV2, acceptance_ids: list[str]) -> list[str]:
    problems: list[str] = []
    if not arch.modules:
        problems.append("没有任何模块")
        return problems

    covered = {item for module in arch.modules for item in module.covers}
    missing = [a for a in acceptance_ids if a not in covered]
    if missing:
        problems.append(f"以下验收标准没有被任何模块覆盖：{missing}")

    ids = {module.id for module in arch.modules}
    files = [path for module in arch.modules for path in module.files]
    if len(files) != len(set(files)):
        problems.append("同一个文件被多个模块声明")
    if not files:
        problems.append("没有声明任何文件")
    if arch.entry not in files:
        problems.append(f"入口 {arch.entry} 不在文件清单里")

    graph = {module.id: [] for module in arch.modules}
    for dep in arch.dependencies:
        if dep.source not in ids or dep.target not in ids:
            problems.append(f"依赖指向了不存在的模块：{dep.source} → {dep.target}")
            continue
        graph[dep.source].append(dep.target)

    state: dict[str, int] = {}

    def visit(node: str) -> bool:
        if state.get(node) == 1:
            return False
        if state.get(node) == 2:
            return True
        state[node] = 1
        for nxt in graph.get(node, []):
            if not visit(nxt):
                return False
        state[node] = 2
        return True

    for node in graph:
        if not visit(node):
            problems.append("依赖存在环")
            break
    return problems


def run(run_id: str, ctx: RunContext) -> ArchV2:
    if not ctx.spec:
        raise StageFailed("缺少规格，无法设计架构")

    spec = ctx.spec
    acceptance_ids = [item["id"] for item in spec.get("acceptance", [])]

    modules_task = _task_id(run_id, "划模块边界")
    flow_task = _task_id(run_id, "定数据流与页面")
    recorder.task(run_id, "created", task_id=modules_task, stage="design", title="划模块边界", kind="design")
    recorder.task(run_id, "created", task_id=flow_task, stage="design", title="定数据流与页面", kind="design")
    recorder.task(run_id, "started", task_id=modules_task, stage="design", title="划模块边界", kind="design")

    client = build_client("design")
    model = model_for("design")
    base_messages = [
        {"role": "system", "content": SYSTEM},
        {
            "role": "user",
            "content": "规格：\n"
            + _json_for_prompt(spec)
            + "\n\n请输出架构 JSON。",
        },
    ]

    began = time.monotonic()
    problems: list[str] = []
    arch: ArchV2 | None = None
    for attempt in range(2):
        messages = base_messages
        if problems:
            messages = base_messages + [
                {"role": "user", "content": RETRY_HINT.format(problems="\n".join(f"- {p}" for p in problems))}
            ]
        try:
            arch, reply = structured(client, messages, model, ArchV2, max_tokens=1400, temperature=0.2)
        finally:
            pass
        db = SessionLocal()
        try:
            amount = record_cost(db, run_id=run_id, stage="design", reply=reply)
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
        recorder.cost(run_id, "design", amount, recorder.total_cost(run_id))

        problems = _validate(arch, acceptance_ids)
        if not problems:
            break

    client.close()

    if arch is None:
        raise StageFailed("架构设计没有产出")

    if recorder.total_cost(run_id) >= get_settings().run_cost_limit_cny:
        raise BudgetExceeded()

    check = {
        "results": [
            {"name": "模块覆盖", "pass": not any("覆盖" in p for p in problems)},
            {"name": "依赖无环", "pass": not any("环" in p for p in problems)},
        ],
        "passed": 0 if problems else 2,
        "total": 2,
        "problems": problems,
    }

    recorder.task(
        run_id,
        "done" if not problems else "failed",
        task_id=modules_task,
        stage="design",
        title="划模块边界",
        kind="design",
        note=f"{len(arch.modules)} 个模块",
        reason="；".join(problems) if problems else "",
        ms=int((time.monotonic() - began) * 1000),
    )

    if problems:
        raise StageFailed("架构校验未通过：" + "；".join(problems))

    recorder.task(run_id, "started", task_id=flow_task, stage="design", title="定数据流与页面", kind="design")
    recorder.task(
        run_id,
        "done",
        task_id=flow_task,
        stage="design",
        title="定数据流与页面",
        kind="design",
        note=f"{len(arch.dependencies)} 条依赖",
    )

    recorder.emit(
        run_id,
        "arch",
        {"arch": arch.model_dump(by_alias=True), "check": check, "fallback": False},
    )
    ctx.arch = arch.model_dump(by_alias=True)
    return arch


def _json_for_prompt(value: Any) -> str:
    import json

    return json.dumps(value, ensure_ascii=False, indent=2)[:4000]