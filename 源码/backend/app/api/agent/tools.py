"""Agent 工具：只读项目文件、语法检查、知识库检索。"""

from __future__ import annotations

import json
import sqlite3
import time

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.ai.rag.retrieve import prompt_block, retrieve
from app.db.models import AssistFile, AssistProject


TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "list_files",
            "description": "列出当前项目里的文件路径和大小",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "读取当前项目里的一个文件；路径必须来自 list_files",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string", "description": "文件路径"}},
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "check_syntax",
            "description": "检查一个文件的基础语法：Python 编译、SQL 执行、HTML 结构",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string", "description": "文件路径"}},
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_knowledge",
            "description": "从项目知识库检索开发规范；需要判断怎么做时先查",
            "parameters": {
                "type": "object",
                "properties": {"query": {"type": "string", "description": "检索问题"}},
                "required": ["query"],
            },
        },
    },
]


def _file(db: Session, project: AssistProject, path: str) -> AssistFile | None:
    path = str(path or "").strip().lstrip("/")
    if not path or ".." in path.split("/"):
        return None
    return db.execute(
        select(AssistFile).where(AssistFile.project_id == project.id, AssistFile.path == path)
    ).scalar_one_or_none()


def execute(name: str, arguments: dict, *, db: Session, project: AssistProject) -> tuple[str, dict]:
    began = time.monotonic()
    if name == "list_files":
        rows = db.execute(select(AssistFile).where(AssistFile.project_id == project.id)).scalars().all()
        if not rows:
            return "项目还没有文件。", {}
        text = "\n".join(f"{item.path} ({len(item.content)} 字符)" for item in rows)
        return text, {}

    if name == "read_file":
        path = str(arguments.get("path") or "")
        row = _file(db, project, path)
        if row is None:
            return f"找不到文件：{path}", {"path": path}
        content = row.content
        if len(content) > 6000:
            content = content[:6000] + "\n…（已截断）"
        return content, {"path": row.path, "chars": len(row.content)}

    if name == "check_syntax":
        path = str(arguments.get("path") or "")
        row = _file(db, project, path)
        if row is None:
            return f"找不到文件：{path}", {"path": path}
        content = row.content
        try:
            if path.endswith(".py"):
                compile(content, path, "exec")
                return "Python 语法通过。", {"path": path}
            if path.endswith(".sql"):
                with sqlite3.connect(":memory:") as conn:
                    conn.executescript(content)
                return "SQL 可执行。", {"path": path}
            if path.endswith(".html"):
                lowered = content.lower()
                ok = "<html" in lowered or "<!doctype" in lowered
                return ("HTML 结构存在。" if ok else "HTML 缺少文档结构。"), {"path": path}
            return "这个文件类型暂不做语法检查。", {"path": path}
        except Exception as error:  # noqa: BLE001
            return f"检查失败：{error}", {"path": path}

    if name == "search_knowledge":
        query = str(arguments.get("query") or "").strip()
        hits = retrieve(db, query, top_k=4)
        if not hits:
            return "知识库没有命中。", {"query": query}
        return prompt_block(hits), {"query": query, "hits": len(hits)}

    return f"未知工具：{name}", {}


def parse_arguments(raw: str) -> dict:
    try:
        value = json.loads(raw or "{}")
    except ValueError:
        return {}
    return value if isinstance(value, dict) else {}


def trace_item(name: str, arguments: dict, result: str, ms: int) -> dict:
    return {
        "name": name,
        "arguments": arguments,
        "result": result[:800],
        "ms": ms,
    }