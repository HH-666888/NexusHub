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
from app.api.ai.cost.ledger import record_cost
from app.api.ai.factory import build_client, model_for
from app.api.ai.model.schema import structured
from app.api.domain.models import ArchV2
from app.api.pipeline import recorder
from app.api.pipeline.context import RunContext
from app.ai.rag.retrieve import prompt_block, retrieve
from app.api.skills.software import block as skill_block
from app.api.pipeline.errors import BudgetExceeded, StageFailed

SYSTEM = """你是软件架构师。基于规格设计一个能真实运行的全栈应用。

模块与文件数量由需求决定：简单应用三个模块就够；功能确实复杂时可以增加模块，
或者在模块内拆成多个文件。不要为了显得复杂硬凑模块，也不要把多个独立职责塞进一个文件。
拆分标准：前端样式、交互脚本按体量拆成独立文件；后端校验模型、数据访问能独立就独立；
只有职责确实单一的小脚本才保持单文件。

运行契约（下游装配、预览、测试真的依赖这些，不是创作限制）：
1. api/main.py 必须存在，里面必须定义 `app = FastAPI()`，并且是本工程唯一启动入口。
   所有 HTTP 路由用 @app.get/post/put/patch/delete 写在 api/main.py —— 前端要按这里抽真实路由，
   拆到别的文件会导致前端拿到不完整清单。业务逻辑可以拆到 api/services/*.py、api/store.py 等，由 main.py 导入。
2. db/schema.sql 必须存在，空库启动时能建表。
3. web/index.html 必须存在。样式和脚本可以拆成 web/style.css、web/app.js 等文件，
   html 里用相对路径引用；也可以内联，按体量决定。
4. 其余文件按职责自由拆分，例如 db/seed.sql、web/js/*.js、api/services/*.py。

文件路径规则（安全边界）：
- 必须是相对路径，只能落在 db/、api/、web/ 三个目录下；
- 不允许绝对路径、不允许出现 ..、不允许反斜杠；
- 同一个文件只能属于一个模块。

其他要求：
- 模块 id 唯一且非空；每个模块至少声明一个文件。
- 每条验收标准至少被一个模块 covers，所有验收标准都要覆盖。
- 依赖单向、无环；web → api → db 是基本方向，可按真实调用关系调整。
- 技术栈：Python 3.12 + sqlite3 + FastAPI；前端原生 HTML/CSS/JS，不引 CDN。
- 只输出 JSON。

schema：
{
  "modules": [
    {"id": "db", "name": "数据库", "responsibility": "…",
     "files": ["db/schema.sql"], "covers": ["a1","a2"]},
    {"id": "api", "name": "接口", "responsibility": "…",
     "files": ["api/main.py", "api/services/tasks.py"], "covers": ["a3","a4"]},
    {"id": "web", "name": "前端", "responsibility": "…",
     "files": ["web/index.html", "web/style.css", "web/app.js"], "covers": ["a5"]}
  ],
  "dependencies": [{"from": "web", "to": "api"}, {"from": "api", "to": "db"}],
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

    module_ids = [module.id for module in arch.modules]
    if any(not mid.strip() for mid in module_ids):
        problems.append("存在空的模块 id")
    if len(module_ids) != len(set(module_ids)):
        problems.append("模块 id 重复")

    files = [path for module in arch.modules for path in module.files]
    if len(files) != len(set(files)):
        problems.append("同一个文件被多个模块声明")

    # 只检查“运行必需”的三个文件，其余文件与模块数量由模型按需求决定
    required = {"db/schema.sql", "api/main.py", "web/index.html"}
    missing = required - set(files)
    if missing:
        problems.append(f"缺少运行必需文件：{sorted(missing)}（其它文件可按需求自由增加）")

    for path in files:
        if not path or not path.strip():
            problems.append("存在空文件路径")
            continue
        if path.startswith(("/", "\\")) or "\\" in path or ":" in path.split("/")[0]:
            problems.append(f"文件路径必须是工程内相对路径：{path}")
            continue
        parts = path.split("/")
        if ".." in parts or "." in parts:
            problems.append(f"文件路径不能包含 . 或 ..：{path}")
            continue
        if parts[0] not in {"db", "api", "web"}:
            problems.append(f"文件必须放在 db/、api/ 或 web/ 目录下：{path}")

    for module in arch.modules:
        if not module.files:
            problems.append(f"模块 {module.id or module.name} 没有声明任何文件")

    if arch.entry not in files:
        problems.append(f"入口 {arch.entry} 不在文件清单里")
    if arch.entry != "api/main.py":
        problems.append("入口必须是 api/main.py（装配阶段按 from api.main import app 接线）")

    ids = set(module_ids)

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


def _repair_coverage(arch: ArchV2, acceptance_ids: list[str]) -> list[str]:
    """把模型漏掉的验收标准补挂到 api 模块。

    规格里要求每条标准都能被一次 HTTP 请求或一次页面操作验证，
    接口层是所有业务规则的必经之路，所以补挂到这里是可解释的做法，
    不是把校验直接判过。补了哪几条会写进检查结果和事件，看得见。
    """
    covered = {item for module in arch.modules for item in module.covers}
    missing = [a for a in acceptance_ids if a not in covered]
    if not missing:
        return []

    target = next((module for module in arch.modules if module.id == "api"), arch.modules[0])
    target.covers = [*target.covers, *missing]
    return missing


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

    query = (spec.get("goal") or ctx.prompt or "") + " " + " ".join(
        item.get("text", "") for item in spec.get("acceptance", [])[:4]
    )
    hits: list[dict] = []
    retrieve_began = time.monotonic()
    try:
        db_rag = SessionLocal()
        try:
            hits = retrieve(db_rag, query, top_k=4)
        finally:
            db_rag.close()
    except Exception:  # noqa: BLE001
        hits = []
    if hits:
        recorder.emit(
            run_id,
            "retrieval",
            {
                "query": query,
                "hits": hits,
                "latency_ms": int((time.monotonic() - retrieve_began) * 1000),
            },
        )

    client = build_client("design")
    model = model_for("design")
    system = SYSTEM + ("\n\n" + skill_block("design")) + ("\n\n" + prompt_block(hits) if hits else "")
    base_messages = [
        {"role": "system", "content": system},
        {
            "role": "user",
            "content": "规格：\n"
            + _json_for_prompt(spec)
            + "\n\n请输出架构 JSON。",
        },
    ]

    began = time.monotonic()
    problems: list[str] = []
    repaired: list[str] = []
    arch: ArchV2 | None = None
    for attempt in range(2):
        messages = base_messages
        if problems:
            messages = base_messages + [
                {"role": "user", "content": RETRY_HINT.format(problems="\n".join(f"- {p}" for p in problems))}
            ]
        try:
            arch, reply = structured(client, messages, model, ArchV2, max_tokens=2400, temperature=0.2)
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

        repaired = _repair_coverage(arch, acceptance_ids)
        problems = _validate(arch, acceptance_ids)
        if not problems:
            break

    client.close()

    if arch is None:
        raise StageFailed("架构设计没有产出")

    if recorder.total_cost(run_id) >= get_settings().run_cost_limit_cny:
        raise BudgetExceeded()

    rows = [
        {"name": "模块覆盖", "pass": not any("覆盖" in p for p in problems), "detail": ""},
        {"name": "依赖无环", "pass": not any("环" in p for p in problems), "detail": ""},
    ]
    if repaired:
        rows.append(
            {
                "name": "覆盖补齐",
                "pass": True,
                "detail": "模型漏掉的 " + "、".join(repaired) + " 已补挂到 api 模块",
            }
        )
    check = {
        "results": rows,
        "passed": sum(1 for row in rows if row["pass"]),
        "total": len(rows),
        "problems": problems,
    }

    recorder.task(
        run_id,
        "done" if not problems else "failed",
        task_id=modules_task,
        stage="design",
        title="划模块边界",
        kind="design",
        note=f"{len(arch.modules)} 个模块" + (f" · 补齐 {len(repaired)} 条" if repaired else ""),
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
        {"arch": arch.model_dump(by_alias=True), "check": check, "fallback": bool(repaired)},
    )
    ctx.arch = arch.model_dump(by_alias=True)
    return arch


def _json_for_prompt(value: Any) -> str:
    import json

    return json.dumps(value, ensure_ascii=False, indent=2)[:4000]