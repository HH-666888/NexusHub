"""自主开发：按架构依赖逐个调模型写文件。

真实写盘、真实校验、失败重试一次；失败原因如实上报。
一个模块可以声明多个文件，按声明顺序逐个生成；每个文件都是一个独立任务节点。
"""

from __future__ import annotations

import hashlib
import re
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
{web_ui}
规则：
1. 不要输出 JSON，不要 Markdown 代码围栏，不要解释。
2. 技术栈：Python 3.12 + sqlite3；如需 Web 框架只能用 FastAPI。
3. 允许使用本工程内的其它文件（用相对导入或同目录 import），但不得引入第三方依赖。
4. 必须实现列出的验收标准。
5. 如果给了「上次错误」，必须修掉，不要重复同样写法。
6. 不得出现 TODO、pass 占位、写死的示例数据；建表脚本也不要 INSERT 演示数据，空库启动。
7. 代码里的标点必须是半角 ASCII：不要用全角括号、全角冒号、全角引号、全角竖线（｜）。
8. 不设行数上限：按验收标准完整实现，该有的校验、错误处理、空状态、样式都写全；
   不要为了省行数牺牲完整性，也不要加与需求无关的抽象层。
9. 前端页面必须用 fetch 调用后端接口，不得只用 localStorage 假装持久化。
10. 必须输出完整文件，不能中途省略或截断。
11. 写 API 入口时必须定义 `app = FastAPI()`（变量名就是 app），装配阶段会 `from api.main import app`。
12. API 入口不要定义 `GET /` 或任何返回 HTML 的路由。页面由 web 模块的 index.html 提供，
    接口只负责 JSON；否则预览打开的是接口里那个简陋页面，真正设计好的页面永远不会被访问。
13. 所有 @app.get/post/put/patch/delete 路由必须写在 api/main.py；其它 api/*.py 只放普通函数、
    数据访问和校验逻辑，由 main.py 导入调用（前端要按 main.py 抽取真实路由清单）。
14. SQLite 的 CHECK 约束里不能用 date('now')、datetime('now') 这类非确定函数，
    否则 INSERT 会报 "non-deterministic use of date() in a CHECK constraint"；
    “日期不能晚于今天”这类规则放应用层校验，CHECK 只做格式和非空/范围检查。
"""

WEB_UI = """
界面质量要求（评委第一眼看到的就是界面，必须做到）：
1. 面向用户的文案全部用中文：标题、按钮、表头、空状态、提示；变量名和接口字段保持英文。
2. 用 :root 定义 4 到 6 个颜色变量（主色、页面底色、卡片底色、文字色、边框色），全站统一引用。样式可以内联，也可以拆到 web/style.css 等文件并在 html 里用相对路径引用。
3. 布局用 grid 或 flex，内容区最大宽度 1100px 居中；卡片 16px 圆角、轻阴影、24px 内边距；控件高度统一 36px。
4. 禁止裸控件：input、button、select 必须设置 padding、边框、圆角、字号，按钮要有 hover 与禁用状态。
5. 必须有空状态文案、提交成功或失败的提示、必填项校验提示。
6. 需求里出现的统计数字（总数、合计、占比）必须真的渲染出来，不能只放标题。
7. 首屏要饱满：标题区、操作区、内容区层次分明，不能出现大片空白。
"""

USER = """需求：{goal}
验收标准：{acceptance}
模块职责：{responsibility}
要覆盖的验收项：{covers}
文件路径：{file}
同模块其它文件（只读参考，不要重复实现）：{siblings}
已有契约（必须严格遵守字段名与路由）：
{context}
后端实际路由（前端必须逐字照抄，不要自造 /api/v1 之类的前缀）：
{routes}
上次错误：{error}
上次输出（有错，供修复参考，最多 3000 字）：
{previous}
"""

ROLE = {"db": "数据库", "api": "后端", "web": "前端"}


def _actual_routes(run_id: str) -> str:
    """把已经写好的 api/main.py 里的真实路由抽出来，交给前端照抄。

    设计阶段给的契约只是"计划"，后端真正落地时路径可能不同（比如少了一层 /v1）。
    前端照着计划写，接口 404，页面就"加载失败"——测试阶段只测 OpenAPI 里的路由，
    根本发现不了。所以这里以磁盘上的真实代码为准。
    """
    root = files.workspace_root(run_id)
    text = ""
    for name in ("api/main.py", "api/main.py".replace("/", "\\")):
        path = root / name
        if path.is_file():
            text = path.read_text(encoding="utf-8", errors="replace")
            break
    if not text:
        return "无（后端还没生成，先按契约写）"
    paths = re.findall(r'@app\.(get|post|put|patch|delete)\(\s*["\']([^"\']+)["\']', text, re.I)
    if not paths:
        return "无"
    return "\n".join(f"{method.upper()} {path}" for method, path in paths)


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
    is_doc = path.lower().endswith((".md", ".txt"))
    if not is_doc and "```" in content:
        return "输出里含 Markdown 代码围栏"
    import re

    if not is_doc and re.search(r"(?im)^\s*(#|//|--|<!--|/\*)\s*TODO\s*[:：]", content):
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
        if path == "api/main.py":
            if "FastAPI(" not in content:
                return "api/main.py 没有创建 FastAPI 实例"
            if not any(token in content for token in ("@app.", "@router.", "add_api_route", "include_router")):
                return "api/main.py 没有路由，疑似输出被截断"
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
    content = lines[1]
    # 模型经常在一个回复里顺手把后续文件也写出来；只取当前文件，
    # 否则第二个 FILE: 之后的内容会被当成代码塞进当前文件，直接语法错误。
    import re

    next_file = re.search(r"(?m)^\s*FILE:\s*\S+", content)
    if next_file:
        content = content[: next_file.start()]
    content = _strip_fence(content)
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
        system_text = SYSTEM.format(
            role=ROLE.get(module.get("id"), "开发"),
            web_ui=WEB_UI if module.get("id") == "web" else "",
        )
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
                    routes=_actual_routes(run_id) if module.get("id") == "web" else "无",
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
    # 入口文件最后写：main.py 要 import store/models/services，
    # 先把被依赖文件生成出来，入口才看得到真实函数名。
    main_paths = [p for p in paths if p.endswith("api/main.py")]
    paths = [p for p in paths if p not in main_paths] + main_paths

    client = build_client("build")
    model = model_for("build")
    written: list[str] = []
    total_lines = 0
    module_context = context
    try:
        for path in paths:
            task_id = _task_id(run_id, module_id, path)
            title = f"写{path.rsplit('/', 1)[-1]}"
            began = time.monotonic()
            recorder.task(run_id, "started", task_id=task_id, stage="build", title=title, kind="code", file=path, group=module.get("name") or module_id)
            try:
                _, content = _build_file(
                    client,
                    model,
                    run_id=run_id,
                    spec=ctx.spec or {},
                    module=module,
                    path=path,
                    siblings=[p for p in paths if p != path],
                    context=module_context,
                )
                files.write_file(run_id, path, content)
                _emit_file(run_id, path, content)
                # 同一模块内后面的文件必须看到前面文件的真实定义，
                # 否则 main.py 会 import store.py 里根本不存在的函数。
                module_context = (module_context + "\n\n" if module_context else "") + f"### {path}\n{content[:3000]}"
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
                title=f"写{path.rsplit('/', 1)[-1]}",
                kind="code",
                file=path,
                group=module.get("name") or module["id"],
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
