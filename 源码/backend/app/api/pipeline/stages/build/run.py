"""自主开发：按架构依赖逐个调模型写文件。

真实写盘、真实校验、失败重试一次；失败原因如实上报。
一个模块可以声明多个文件，按声明顺序逐个生成；每个文件都是一个独立任务节点。
"""

from __future__ import annotations

import hashlib
import sqlite3
import time
from dataclasses import dataclass
from typing import Any

from pydantic import BaseModel

from app.config import get_settings
from app.db.session import SessionLocal
from app.api.ai.cost.ledger import record_cost
from app.api.ai.factory import build_client, model_for
from app.api.skills.software import block as skill_block
from app.api.ai.model.schema import structured
from app.api.pipeline import recorder
from app.api.pipeline.context import RunContext
from app.api.pipeline.errors import BudgetExceeded, StageFailed
from app.api.tools import files

SYSTEM = """你是{role}工程师。只写一个文件。

输出格式（严格遵守）：
第一行：FILE: <文件路径>
第二行开始：文件的完整内容，直到结尾。

规则：
1. 不要输出 JSON，不要 Markdown 代码围栏，不要解释。
2. 技术栈：Python 3.12 + sqlite3；如需 Web 框架只能用 FastAPI。
3. 文件必须自包含，不能 import 本工程之外的代码。
4. 必须实现列出的验收标准。
5. 如果给了「上次错误」，必须修掉，不要重复同样写法。
6. 不得出现 TODO、pass 占位、写死的示例数据。
7. 代码里的标点必须是半角 ASCII：不要用全角括号、全角冒号、全角引号、全角竖线（｜）。
8. 文件尽量不超过 150 行；只实现验收标准要求的最小功能，不要加额外的抽象层。
9. 前端页面必须用 fetch 调用后端接口，不得只用 localStorage 假装持久化。
10. 必须输出完整文件，不能中途省略或截断。
11. 写 API 入口时必须定义 `app = FastAPI()`（变量名就是 app），装配阶段会 `from api.main import app`。
"""

USER = """需求：{goal}
验收标准：{acceptance}
模块职责：{responsibility}
要覆盖的验收项：{covers}
文件路径：{file}
同模块其它文件（只读参考，不要重复实现）：{siblings}
已有契约（必须严格遵守字段名与路由）：
{context}
上次错误：{error}
上次输出（有错，供修复参考，最多 3000 字）：
{previous}
"""

ROLE = {"db": "数据库", "api": "后端", "web": "前端"}


class FileOutput(BaseModel):
    path: str
    content: str
    notes: str = ""


@dataclass
class BuildResult:
    module_id: str
    files: list[str]
    lines: int
    ms: int


def _task_id(run_id: str, module_id: str, path: str = "") -> str:
    return "task-build-" + hashlib.sha1(f"{run_id}:build:{module_id}:{path}".encode()).hexdigest()[:6]


# 只修全角竖线：它是 Python 类型联合/位运算里最常见的坏字符，
# 其它全角标点可能出现在中文字符串里，替换反而会破坏字符串。
_FULLWIDTH = {"｜": "|"}


def _sanitize(path: str, content: str) -> str:
    if path.endswith((".py", ".sql", ".js", ".html", ".css")):
        for bad, good in _FULLWIDTH.items():
            content = content.replace(bad, good)
    return content


def _verify(path: str, content: str) -> str | None:
    if not content.strip():
        return "文件内容为空"
    if "```" in content:
        return "输出里含 Markdown 代码围栏"
    import re

    if re.search(r"(?im)^\s*(#|//|--|<!--|/\*)\s*TODO\s*[:：]", content):
        return "代码里出现了 TODO: 占位注释"
    if path.endswith(".sql"):
        try:
            with sqlite3.connect(":memory:") as conn:
                conn.executescript(content)
        except sqlite3.Error as error:
            return f"SQL 执行失败：{error}"
        return None
    if path.endswith(".py"):
        try:
            compile(content, path, "exec")
        except SyntaxError as error:
            return f"Python 语法错误：{error}"
        return None
    if path.endswith(".html"):
        if "<html" not in content.lower() and "<!doctype" not in content.lower():
            return "HTML 缺少文档结构"
        return None
    return None


def _strip_fence(content: str) -> str:
    import re

    text = content.strip("\n")
    text = re.sub(r"^\s*```[a-zA-Z0-9_-]*\s*\n", "", text)
    text = re.sub(r"\n\s*```\s*$", "", text)
    return text


def _parse_file_reply(text: str) -> tuple[str, str]:
    raw = (text or "").strip("\n")
    if raw.startswith("```"):
        raw = raw.split("\n", 1)[1] if "\n" in raw else ""
        if raw.rstrip().endswith("```"):
            raw = raw.rstrip()[:-3]
    lines = raw.split("\n", 1)
    if len(lines) != 2 or not lines[0].upper().startswith("FILE:"):
        raise ValueError(f"首行不是 FILE:（实际：{lines[0][:60]!r}）")
    path = lines[0].split(":", 1)[1].strip().strip("`")
    content = _strip_fence(lines[1])
    if not content.strip():
        raise ValueError("文件内容为空")
    return path, content


def _chunks(text: str, size: int = 400) -> list[str]:
    return [text[i : i + size] for i in range(0, len(text), size)]


def _emit_file(run_id: str, path: str, content: str) -> None:
    offset = 0
    for piece in _chunks(content):
        offset += len(piece)
        recorder.emit(
            run_id,
            "file",
            {
                "path": path,
                "lang": _lang(path),
                "delta": piece,
                "done": False,
                "lines": content[:offset].count("\n"),
            },
        )
    recorder.emit(
        run_id,
        "file",
        {"path": path, "lang": _lang(path), "delta": "", "done": True, "lines": content.count("\n")},
    )


def _build_file(
    client,
    model: str,
    *,
    run_id: str,
    spec: dict,
    module: dict,
    path: str,
    siblings: list[str],
    context: str,
) -> tuple[str, str]:
    """返回 (path, content)；失败抛 StageFailed。"""
    covers = module.get("covers") or []
    acceptance = spec.get("acceptance", [])
    acceptance_text = "\n".join(
        f"- {item['id']}: {item['text']}"
        for item in acceptance
        if not covers or item["id"] in covers
    ) or "\n".join(f"- {item['id']}: {item['text']}" for item in acceptance)

    last_error = ""
    previous = "无"
    content = ""
    for _attempt in range(3):
        system_text = SYSTEM.format(role=ROLE.get(module.get("id"), "开发"))
        extra = skill_block("build")
        if extra:
            system_text += "\n\n" + extra
        messages = [
            {"role": "system", "content": system_text},
            {
                "role": "user",
                "content": USER.format(
                    goal=spec.get("goal", ""),
                    acceptance=acceptance_text,
                    responsibility=module.get("responsibility", ""),
                    covers=", ".join(covers) or "全部",
                    file=path,
                    siblings=", ".join(siblings) or "无",
                    context=context or "无",
                    error=last_error or "无",
                    previous=previous,
                ),
            },
        ]
        try:
            reply = client.complete(messages, model, max_tokens=6000, temperature=0.1)
            if reply.finish_reason == "length":
                last_error = "输出被截断（达到 token 上限），请写得更短"
                continue
            path_out, content = _parse_file_reply(reply.content)
        except Exception as error:  # noqa: BLE001
            last_error = f"模型输出不可用：{error}"
            continue

        db = SessionLocal()
        try:
            amount = record_cost(db, run_id=run_id, stage="build", reply=reply)
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
        recorder.cost(run_id, "build", amount, recorder.total_cost(run_id))

        if path_out != path:
            last_error = f"模型返回的文件路径不对：{path_out}，期望 {path}"
            continue

        content = _sanitize(path, content)
        problem = _verify(path, content)
        if problem is None:
            return path, content
        last_error = problem
        previous = content[:8000]

    # 最后一次兜底：让它写最小实现，不引 Pydantic、不做抽象
    try:
        minimal = [
            {"role": "system", "content": "你是工程师。只写一个最小可运行的文件，尽量短。不要用 Pydantic、不要依赖注入、不要类继承。只输出 FILE: 路径 + 内容。"},
            {"role": "user", "content": f"文件路径：{path}\n要求：{spec.get('goal', '')}\n上次错误：{last_error}\n请写最小实现。"},
        ]
        reply = client.complete(minimal, model, max_tokens=6000, temperature=0.0)
        _, content = _parse_file_reply(reply.content)
        content = _sanitize(path, content)
        if _verify(path, content) is None:
            db = SessionLocal()
            try:
                amount = record_cost(db, run_id=run_id, stage="build", reply=reply)
            finally:
                db.close()
            recorder.usage(run_id, model=reply.model, prompt_tokens=reply.prompt_tokens,
                           completion_tokens=reply.completion_tokens, latency_ms=reply.latency_ms, cny=amount)
            recorder.cost(run_id, "build", amount, recorder.total_cost(run_id))
            return path, content
    except Exception:  # noqa: BLE001
        pass

    if content:
        try:
            debug_dir = files.workspace_root(run_id) / "_failed"
            debug_dir.mkdir(exist_ok=True)
            (debug_dir / (path.split("/")[-1] + ".txt")).write_text(content, encoding="utf-8")
        except Exception:  # noqa: BLE001
            pass
    raise StageFailed(last_error or "模块构建失败")


def _sort_by_dependencies(modules: list[dict[str, Any]], dependencies: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """按 AI 给出的依赖图拓扑排序；成环或缺失时退回架构里的模块顺序。"""
    by_id = {m.get("id"): m for m in modules if m.get("id")}
    deps: dict[str, list[str]] = {mid: [] for mid in by_id}
    for dep in dependencies:
        source = dep.get("from") or dep.get("source")
        target = dep.get("to") or dep.get("target")
        if source in deps and target in deps:
            deps[source].append(target)

    ordered: list[dict[str, Any]] = []
    done: set[str] = set()
    visiting: set[str] = set()

    def visit(mid: str) -> None:
        if mid in done or mid in visiting:
            return
        visiting.add(mid)
        for target in deps.get(mid, []):
            visit(target)
        visiting.discard(mid)
        done.add(mid)
        if mid in by_id:
            ordered.append(by_id[mid])

    for module in modules:
        if module.get("id"):
            visit(module["id"])
    return ordered or modules


def _run_one(run_id: str, ctx: RunContext, module: dict[str, Any], context: str = "") -> BuildResult:
    module_id = module["id"]
    paths = module.get("files") or []
    if not paths:
        raise StageFailed(f"模块 {module_id} 没有声明文件")

    client = build_client("build")
    model = model_for("build")
    written: list[str] = []
    total_lines = 0
    try:
        for path in paths:
            task_id = _task_id(run_id, module_id, path)
            title = f"写{module['name']}"
            began = time.monotonic()
            recorder.task(run_id, "started", task_id=task_id, stage="build", title=title, kind="code", file=path)
            try:
                _, content = _build_file(
                    client,
                    model,
                    run_id=run_id,
                    spec=ctx.spec or {},
                    module=module,
                    path=path,
                    siblings=[p for p in paths if p != path],
                    context=context,
                )
                files.write_file(run_id, path, content)
                _emit_file(run_id, path, content)
            except Exception as error:  # noqa: BLE001
                recorder.task(
                    run_id,
                    "failed",
                    task_id=task_id,
                    stage="build",
                    title=title,
                    kind="code",
                    file=path,
                    reason=str(error),
                    attempts=3,
                    ms=int((time.monotonic() - began) * 1000),
                )
                raise
            lines = content.count("\n")
            written.append(path)
            total_lines += lines
            recorder.task(
                run_id,
                "done",
                task_id=task_id,
                stage="build",
                title=title,
                kind="code",
                file=path,
                note=f"{lines} 行",
                ms=int((time.monotonic() - began) * 1000),
                result={"file": path, "lines": lines},
            )
    finally:
        client.close()

    return BuildResult(module_id=module_id, files=written, lines=total_lines, ms=0)


def run(run_id: str, ctx: RunContext) -> list[BuildResult]:
    if not ctx.arch:
        raise StageFailed("缺少架构，无法开工")

    modules = ctx.arch.get("modules", [])
    if not modules:
        raise StageFailed("架构里没有模块")

    # 顺序由架构阶段的依赖图决定，不再写死 db → api → web
    modules = _sort_by_dependencies(modules, ctx.arch.get("dependencies") or [])

    for module in modules:
        for path in module.get("files") or []:
            recorder.task(
                run_id,
                "created",
                task_id=_task_id(run_id, module["id"], path),
                stage="build",
                title=f"写{module['name']}",
                kind="code",
                file=path,
            )

    recorder.emit(
        run_id,
        "modules",
        {
            "batch": {
                "modules": [
                    {
                        "moduleId": m["id"],
                        "name": m["name"],
                        "summary": m.get("responsibility", ""),
                        "file": (m.get("files") or [""])[0],
                        "state": "pending",
                        "progress": 0,
                        "costCny": 0,
                    }
                    for m in modules
                ],
                "mode": "sequential",
            }
        },
    )

    results: list[BuildResult] = []
    contract_parts: list[str] = []

    for module in modules:
        try:
            result = _run_one(run_id, ctx, module, context="\n\n".join(contract_parts))
        except Exception as error:  # noqa: BLE001
            raise StageFailed(f"{module.get('name', module.get('id'))}：{error}") from error

        results.append(result)
        for path in result.files:
            try:
                content = files.read_file(run_id, path)
            except Exception:  # noqa: BLE001
                continue
            contract_parts.append(f"### {path}\n{content[:3000]}")
            ctx.files[path] = content

    return results


def _lang(path: str) -> str:
    if path.endswith(".sql"):
        return "sql"
    if path.endswith(".py"):
        return "python"
    return "html"
