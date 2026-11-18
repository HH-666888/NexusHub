"""集成装配：把模块代码接成一个能启动的入口。

输入是真实文件内容（截断后进提示词），输出 app.py。
校验只做语法与结构，运行验证留给测试阶段。
"""

from __future__ import annotations

import hashlib
import re
import time

from app.db.session import SessionLocal
from app.api.ai.cost.ledger import record_cost
from app.api.ai.factory import build_client, model_for
from app.api.pipeline import recorder
from app.api.pipeline.context import RunContext
from app.api.pipeline.errors import StageFailed
from app.api.tools import files

SYSTEM = """你是集成工程师。下面是各模块的真实代码，请生成一个能启动的入口文件 app.py。

要求：
1. 只输出一个文件，格式：第一行 `FILE: app.py`，第二行起是完整内容。
2. 不要输出 JSON，不要 Markdown 围栏，不要解释。
3. 启动时执行 db/schema.sql 建表（如果存在）。
4. 如果 api/main.py 里定义了 FastAPI 实例（通常叫 app），导入它。
5. 用 StaticFiles 把 web/ 目录挂到 /，但必须先摘掉 API 模块自带的根路由，
   否则预览显示的是接口里那个简陋页面，web/index.html 永远不会被访问：
   在 app.mount 之前加这一段：
       app.routes = [r for r in app.routes if getattr(r, "path", "") != "/"]
       app.mount("/", StaticFiles(directory=str(WEB_DIR), html=True), name="web")
   （WEB_DIR 用 Path(__file__).resolve().parent / "web" 算出来，并判断存在再挂）
6. 监听 0.0.0.0，端口从环境变量 PORT 读，默认 8000。
7. 文件末尾：
   if __name__ == "__main__":
       import uvicorn
       uvicorn.run(app, host="0.0.0.0", port=PORT)
8. 不要重写模块内部逻辑，只做接线。
9. 标点必须是半角 ASCII。
"""

USER = """模块代码：
{files}

入口：app.py
"""


def _task_id(run_id: str) -> str:
    return "task-assemble-" + hashlib.sha1(f"{run_id}:assemble".encode()).hexdigest()[:6]


_MOUNT_ROOT = re.compile(r'(?m)^(\s*)app\.mount\("/",\s*StaticFiles')


def _ensure_web_priority(text: str) -> str:
    """保证预览打开的是 web/index.html，而不是 API 模块自带的根路由。

    FastAPI 的普通路由优先于 mount，所以只要 api/main.py 里写了 `GET /`，
    StaticFiles 挂上去也不会被命中 —— 预览就永远是一个简陋页面。
    这里在 mount 之前插一行，把自带的根路由摘掉；插完再编译校验，坏了就还原。
    """
    if "StaticFiles" not in text or "getattr(r" in text:
        return text
    match = _MOUNT_ROOT.search(text)
    if not match:
        return text
    indent = match.group(1)
    patch = f'{indent}app.routes = [r for r in app.routes if getattr(r, "path", "") != "/"]\n'
    patched = text[: match.start()] + patch + text[match.start():]
    try:
        compile(patched, "app.py", "exec")
    except SyntaxError:
        return text
    return patched


def _parse(text: str) -> str:
    raw = (text or "").strip("\n")
    if raw.startswith("```"):
        raw = raw.split("\n", 1)[1] if "\n" in raw else ""
        if raw.rstrip().endswith("```"):
            raw = raw.rstrip()[:-3]
    lines = raw.split("\n", 1)
    if len(lines) != 2 or not lines[0].upper().startswith("FILE:"):
        raise ValueError(f"首行不是 FILE:（实际：{lines[0][:60]!r}）")
    content = lines[1]
    if not content.strip():
        raise ValueError("文件内容为空")
    return content


def _snippets(run_id: str, arch: dict) -> str:
    chunks: list[str] = []
    paths = files.list_files(run_id)
    for path in paths:
        try:
            content = files.read_file(run_id, path)
        except Exception:  # noqa: BLE001
            continue
        if len(content) > 2000:
            content = content[:1400] + "\n...# truncated ...\n" + content[-500:]
        chunks.append(f"### {path}\n{content}")
    if not chunks:
        raise StageFailed("工作区没有任何文件，无法装配")
    return "\n\n".join(chunks)[:12000]


def run(run_id: str, ctx: RunContext) -> str:
    if not ctx.arch:
        raise StageFailed("缺少架构，无法装配")

    task_id = _task_id(run_id)
    recorder.task(run_id, "created", task_id=task_id, stage="assemble", title="接线与配置", kind="wire")
    recorder.task(run_id, "started", task_id=task_id, stage="assemble", title="接线与配置", kind="wire")

    snippets = _snippets(run_id, ctx.arch)
    client = build_client("assemble")
    model = model_for("assemble")
    began = time.monotonic()
    last_error = ""
    previous = "无"
    content: str | None = None

    try:
        for _attempt in range(3):
            messages = [
                {"role": "system", "content": SYSTEM},
                {
                    "role": "user",
                    "content": USER.format(files=snippets)
                    + ("" if not last_error else f"\n上次错误：{last_error}\n上次输出（供修复）：\n{previous}"),
                },
            ]
            try:
                reply = client.complete(messages, model, max_tokens=2200, temperature=0.1)
                content = _parse(reply.content)
            except Exception as error:  # noqa: BLE001
                last_error = f"模型输出不可用：{error}"
                continue

            db = SessionLocal()
            try:
                amount = record_cost(db, run_id=run_id, stage="assemble", reply=reply)
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
            recorder.cost(run_id, "assemble", amount, recorder.total_cost(run_id))

            try:
                compile(content, "app.py", "exec")
                if "StaticFiles" not in content:
                    raise ValueError("没有挂载静态文件（StaticFiles）")
                if "PORT" not in content:
                    raise ValueError("没有从环境变量读取 PORT")
                if "__main__" not in content:
                    raise ValueError("缺少 __main__ 启动块")
                last_error = ""
                break
            except (SyntaxError, ValueError) as error:
                last_error = str(error)
                previous = content[:3000]
                content = None
    finally:
        client.close()

    if content is None:
        recorder.task(
            run_id,
            "failed",
            task_id=task_id,
            stage="assemble",
            title="接线与配置",
            kind="wire",
            reason=last_error or "装配失败",
            ms=int((time.monotonic() - began) * 1000),
        )
        raise StageFailed(last_error or "装配失败")

    content = _ensure_web_priority(content)

    files.write_file(run_id, "app.py", content)
    offset = 0
    for i in range(0, len(content), 400):
        piece = content[i : i + 400]
        offset += len(piece)
        recorder.emit(
            run_id,
            "file",
            {"path": "app.py", "lang": "python", "delta": piece, "done": False, "lines": content[:offset].count("\n")},
        )
    recorder.emit(
        run_id,
        "file",
        {"path": "app.py", "lang": "python", "delta": "", "done": True, "lines": content.count("\n")},
    )

    ms = int((time.monotonic() - began) * 1000)
    recorder.task(
        run_id,
        "done",
        task_id=task_id,
        stage="assemble",
        title="接线与配置",
        kind="wire",
        note=f"{content.count(chr(10))} 行",
        ms=ms,
        result={"files": ["app.py"], "lines": content.count("\n")},
    )
    ctx.arch["entry"] = "app.py"
    return "app.py"