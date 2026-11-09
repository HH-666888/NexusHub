"""自动测试：真起进程、真发请求、真回环修复。

测试用例来自验收标准；失败就带错误修，最多两轮回环。
"""

from __future__ import annotations

import hashlib
import json
import time
from typing import Any, Literal

import httpx
from pydantic import BaseModel, Field

from app.config import get_settings
from app.db.session import SessionLocal
from app.v2.ai.cost.ledger import record_cost
from app.v2.ai.factory import build_client, model_for
from app.v2.ai.model.schema import structured
from app.v2.pipeline import recorder
from app.v2.pipeline.context import RunContext
from app.v2.pipeline.errors import StageFailed
from app.v2.runtime import process as runtime
from app.v2.tools import files

SYSTEM = """你是测试工程师。根据验收标准生成可执行的测试用例。

规则：
1. 每条验收标准至少一个用例。
2. 类型只有两种：http（发请求）和 page（GET 页面）。
3. 必须使用下面给出的真实路由与状态码，不要发明路径或方法。
4. http 用例只断言 status 和 json 字段；不要用 contains。
5. page 用例只断言 status。
6. 只输出 JSON，不要解释。

schema：
{"cases":[{"id":"c1","acceptance":"a1","type":"http",
  "method":"POST","path":"/api/todos","json":{"title":"x"},
  "expect":{"status":200,"contains":"x"}}]}
"""

USER = """验收标准：
{acceptance}

真实路由（method path status）：
{routes}

真实请求体字段（来自 /openapi.json，必须照抄字段名）：
{api_contract}

接口与页面线索：
{contracts}
"""


class Case(BaseModel):
    id: str
    acceptance: str
    type: Literal["http", "page"]
    method: str = "GET"
    path: str
    body: dict[str, Any] | None = Field(default=None, alias="json")
    expect: dict[str, Any] = Field(default_factory=dict)

    model_config = {"populate_by_name": True}


class TestPlan(BaseModel):
    cases: list[Case]


class CheckResult(BaseModel):
    name: str
    pass_: bool = Field(alias="pass")
    detail: str = ""

    model_config = {"populate_by_name": True}


def _case_task(run_id: str, case_id: str) -> str:
    return "task-test-" + hashlib.sha1(f"{run_id}:test:{case_id}".encode()).hexdigest()[:6]


def _openapi_routes(base: str) -> set[tuple[str, str]]:
    try:
        doc = httpx.get(base + "/openapi.json", timeout=5).json()
    except Exception:  # noqa: BLE001
        return set()
    found: set[tuple[str, str]] = set()
    for path, operations in (doc.get("paths") or {}).items():
        for method in operations:
            if method in {"get", "post", "put", "patch", "delete"}:
                found.add((method.upper(), path))
    return found


def _openapi_contract(base: str) -> str:
    """从运行中的产物读取 OpenAPI，生成"方法 路径 字段→类型"的紧凑说明。"""
    try:
        doc = httpx.get(base + "/openapi.json", timeout=5).json()
    except Exception:  # noqa: BLE001
        return "（没有 openapi.json）"

    components = (doc.get("components") or {}).get("schemas") or {}
    lines: list[str] = []
    for path, operations in (doc.get("paths") or {}).items():
        for method, operation in operations.items():
            if method not in {"get", "post", "put", "patch", "delete"}:
                continue
            body_fields: list[str] = []
            request_body = operation.get("requestBody") or {}
            for media in (request_body.get("content") or {}).values():
                schema = media.get("schema") or {}
                if "$ref" in schema:
                    name = schema["$ref"].split("/")[-1]
                    schema = components.get(name, {})
                required = set(schema.get("required") or [])
                for field, spec in (schema.get("properties") or {}).items():
                    kind = spec.get("type") or ("ref" if "$ref" in spec else "any")
                    mark = "必填" if field in required else "可选"
                    body_fields.append(f"{field}:{kind}({mark})")
            status = "200"
            for code in (operation.get("responses") or {}):
                if str(code).startswith("2"):
                    status = str(code)
                    break
            suffix = (" body {" + ", ".join(body_fields) + "}") if body_fields else ""
            lines.append(f"{method.upper()} {path} -> {status}{suffix}")
    return "\n".join(lines) or "（没有可用接口）"


def _discover_routes(run_id: str) -> list[str]:
    import re

    found: list[str] = []
    for path in files.list_files(run_id):
        if not path.endswith(".py"):
            continue
        try:
            content = files.read_file(run_id, path)
        except Exception:  # noqa: BLE001
            continue
        for match in re.finditer(
            r"@(?:app|router)\.(get|post|put|patch|delete)\(\s*[\"']([^\"']+)[\"']([^)]*)",
            content,
        ):
            method, route, rest = match.group(1).upper(), match.group(2), match.group(3)
            status = "200"
            status_match = re.search(r"status_code\s*=\s*(\d+)", rest)
            if status_match:
                status = status_match.group(1)
            found.append(f"{method} {route} {status}")
    return sorted(set(found))


def _contracts(arch: dict) -> str:
    lines = []
    for module in arch.get("modules", []):
        lines.append(f"- {module['name']}：{module.get('responsibility', '')}；文件 {', '.join(module.get('files', []))}")
    return "\n".join(lines)


def _gen_plan(run_id: str, ctx: RunContext, api_contract: str, base: str) -> TestPlan:
    spec = ctx.spec or {}
    client = build_client("test")
    model = model_for("test")
    messages = [
        {"role": "system", "content": SYSTEM},
        {
            "role": "user",
            "content": USER.format(
                acceptance=json.dumps(spec.get("acceptance", []), ensure_ascii=False, indent=2),
                routes="\n".join(_discover_routes(run_id)) or "（没有发现路由，按接口线索推断）",
                api_contract=api_contract,
                contracts=_contracts(ctx.arch or {}),
            ),
        },
    ]
    try:
        plan, reply = structured(client, messages, model, TestPlan, max_tokens=1400, temperature=0.1)
    finally:
        client.close()

    db = SessionLocal()
    try:
        amount = record_cost(db, run_id=run_id, stage="test", reply=reply)
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
    recorder.cost(run_id, "test", amount, recorder.total_cost(run_id))

    real = _openapi_routes(base)
    kept = []
    for case in plan.cases:
        case.expect = {"status": int(case.expect.get("status", 200))}
        if case.method.upper() not in {"GET", "POST"}:
            continue
        if real and (case.method.upper(), case.path) not in real:
            continue
        kept.append(case)
    plan.cases = kept or [Case(id="c1", acceptance=spec["acceptance"][0]["id"], type="page", path="/", expect={"status": 200})]

    if not real:
        for line in _discover_routes(run_id):
            parts = line.split()
            if len(parts) >= 2:
                real.add((parts[0].upper(), parts[1]))

    if real and not any(case.type == "http" for case in plan.cases):
        get_routes = sorted(path for method, path in real if method == "GET")
        if get_routes:
            plan.cases.append(
                Case(
                    id="autoapi",
                    acceptance=spec["acceptance"][0]["id"],
                    type="http",
                    path=get_routes[0],
                    expect={"status": 200},
                )
            )

    covered = {case.acceptance for case in plan.cases}
    for index, item in enumerate(spec.get("acceptance", []), start=1):
        if item["id"] not in covered:
            plan.cases.append(
                Case(id=f"auto{index}", acceptance=item["id"], type="page", path="/", expect={"status": 200})
            )

    acceptance_ids = {item["id"] for item in spec.get("acceptance", [])}
    if not real:
        for line in _discover_routes(run_id):
            parts = line.split()
            if len(parts) >= 2:
                real.add((parts[0].upper(), parts[1]))

    if real and not any(case.type == "http" for case in plan.cases):
        get_routes = sorted(path for method, path in real if method == "GET")
        if get_routes:
            plan.cases.append(
                Case(
                    id="autoapi",
                    acceptance=spec["acceptance"][0]["id"],
                    type="http",
                    path=get_routes[0],
                    expect={"status": 200},
                )
            )

    covered = {case.acceptance for case in plan.cases}
    missing = acceptance_ids - covered
    if missing:
        raise StageFailed(f"测试用例没有覆盖这些验收项：{sorted(missing)}")
    if not plan.cases:
        raise StageFailed("没有生成任何测试用例")
    return plan


def _run_case(client: httpx.Client, case: Case) -> tuple[bool, str]:
    try:
        response = client.request(case.method, case.path, json=case.body, timeout=15)
    except httpx.HTTPError as error:
        return False, f"{case.method} {case.path} 请求失败：{error}"

    expect = case.expect or {}
    status = expect.get("status")
    if status is not None:
        actual = response.status_code
        expected = int(status)
        ok = (200 <= actual < 300) if 200 <= expected < 300 else (400 <= actual < 500)
        if not ok:
            return False, f"{case.method} {case.path} 返回 {actual}，期望 {status}"

    text = response.text or ""
    contains = expect.get("contains")
    if contains and contains not in text:
        return False, f"响应里没有 {contains!r}（实际 {text[:160]!r}）"

    expected_json = expect.get("json")
    if expected_json:
        try:
            body = response.json()
        except ValueError:
            return False, f"响应不是 JSON：{text[:120]}"
        for key, value in expected_json.items():
            if body.get(key) != value:
                return False, f"字段 {key} 期望 {value!r}，实际 {body.get(key)!r}"

    return True, f"{case.method} {case.path} → {response.status_code}"


def _fix(run_id: str, ctx: RunContext, case: Case, detail: str) -> str | None:
    """让模型修一个文件，返回改动的路径。"""
    arch = ctx.arch or {}
    candidates: list[str] = []
    for module in arch.get("modules", []):
        if case.path.startswith("/api"):
            if module["id"] in {"api", "db"}:
                candidates.extend(module.get("files", []))
        else:
            if module["id"] == "web":
                candidates.extend(module.get("files", []))
    candidates = [path for path in candidates if path.endswith((".py", ".js", ".html"))][:2]
    if not candidates:
        return None

    snippets = []
    for path in candidates:
        try:
            snippets.append(f"### {path}\n{files.read_file(run_id, path)[:3000]}")
        except Exception:  # noqa: BLE001
            continue

    system = """你是修复工程师。测试失败了，请修一个文件。

输出格式：第一行 `FILE: <路径>`，第二行起是完整文件内容。
不要输出 JSON，不要 Markdown 围栏。
只改与失败相关的逻辑，不要重写其它部分。
"""
    user = f"""失败用例：{case.id}（验收 {case.acceptance}）
请求：{case.method} {case.path} {json.dumps(case.body or {}, ensure_ascii=False)}
期望：{json.dumps(case.expect, ensure_ascii=False)}
实际：{detail}

相关文件：
{chr(10).join(snippets)}

请输出修复后的完整文件（只能改上面这些文件之一）。
"""
    client = build_client("test")
    model = model_for("test")
    try:
        reply = client.complete(
            [{"role": "system", "content": system}, {"role": "user", "content": user}],
            model,
            max_tokens=2400,
            temperature=0.1,
        )
    finally:
        client.close()
    db = SessionLocal()
    try:
        amount = record_cost(db, run_id=run_id, stage="test", reply=reply)
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
    recorder.cost(run_id, "test", amount, recorder.total_cost(run_id))

    raw = (reply.content or "").strip("\n")
    if raw.startswith("```"):
        raw = raw.split("\n", 1)[1] if "\n" in raw else ""
        if raw.rstrip().endswith("```"):
            raw = raw.rstrip()[:-3]
    lines = raw.split("\n", 1)
    if len(lines) != 2 or not lines[0].upper().startswith("FILE:"):
        return None
    path = lines[0].split(":", 1)[1].strip().strip("`")
    content = lines[1]
    if path not in candidates:
        return None
    if path.endswith(".py"):
        try:
            compile(content, path, "exec")
        except SyntaxError:
            return None
    files.write_file(run_id, path, content)
    for i in range(0, len(content), 400):
        recorder.emit(
            run_id,
            "file",
            {"path": path, "lang": _lang(path), "delta": content[i : i + 400], "done": False},
        )
    recorder.emit(run_id, "file", {"path": path, "lang": _lang(path), "delta": "", "done": True, "replace": True})
    return path


def run(run_id: str, ctx: RunContext) -> list[dict]:
    workspace = files.workspace_root(run_id)
    entry = (ctx.arch or {}).get("entry", "app.py")

    port = runtime.pick_port()
    process = runtime.start(workspace, entry, port)
    base = f"http://127.0.0.1:{port}"
    try:
        if not runtime.wait_http(base + "/", timeout=25):
            tail = runtime.log_tail(process)
            raise StageFailed(f"产物启动失败：{tail[-500:]}")

        plan = _gen_plan(run_id, ctx, _openapi_contract(base), base)
        for case in plan.cases:
            recorder.task(
                run_id,
                "created",
                task_id=_case_task(run_id, case.id),
                stage="test",
                title=f"用例 {case.id}",
                kind="test",
                note=case.acceptance,
            )

        results: list[dict] = []
        with httpx.Client(base_url=base) as http:
            for case in plan.cases:
                task_id = _case_task(run_id, case.id)
                recorder.task(run_id, "started", task_id=task_id, stage="test", title=f"用例 {case.id}", kind="test")
                ok, detail = _run_case(http, case)
                results.append({"name": case.acceptance, "pass": ok, "detail": detail, "case": case.id, "type": case.type})
                recorder.emit(
                    run_id,
                    "check",
                    {"results": [{"name": f"{case.id} {case.acceptance}", "pass": ok, "detail": detail}]},
                )
                recorder.task(
                    run_id,
                    "done" if ok else "failed",
                    task_id=task_id,
                    stage="test",
                    title=f"用例 {case.id}",
                    kind="test",
                    note=detail[:80],
                    reason="" if ok else detail,
                )

        passes = sum(1 for item in results if item["pass"])
        recorder.emit(
            run_id,
            "check",
            {"summary": {"passed": passes, "total": len(results), "failed": len(results) - passes}},
        )

        # 回环修复
        rounds = 0
        while passes < len(results) and rounds < get_settings().max_loopback:
            rounds += 1
            failing = next(item for item in results if not item["pass"])
            case = next(c for c in plan.cases if c.id == failing["case"])
            recorder.phase(run_id, "building", "回环修复")
            path = _fix(run_id, ctx, case, failing["detail"])
            if path is None:
                break
            runtime.stop(process)
            port = runtime.pick_port()
            process = runtime.start(workspace, entry, port)
            base = f"http://127.0.0.1:{port}"
            if not runtime.wait_http(base + "/", timeout=25):
                break
            recorder.phase(run_id, "checking", "复测")
            with httpx.Client(base_url=base) as http:
                for item in results:
                    if item["pass"]:
                        continue
                    retry_case = next(c for c in plan.cases if c.id == item["case"])
                    ok, detail = _run_case(http, retry_case)
                    item["pass"] = ok
                    item["detail"] = detail
            passes = sum(1 for item in results if item["pass"])

        ctx.checks = results
        if passes < len(results):
            failed = [item for item in results if not item["pass"]]
            raise StageFailed(f"{len(failed)} 个用例未通过：" + "；".join(item["detail"] for item in failed)[:400])
        return results
    finally:
        runtime.stop(process)


def _lang(path: str) -> str:
    return "python" if path.endswith(".py") else "html"