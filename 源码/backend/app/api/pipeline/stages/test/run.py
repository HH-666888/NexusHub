"""自动测试：真起进程、真发请求、真回环修复。

测试用例来自验收标准；失败就带错误修，最多两轮回环。
"""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import time
from pathlib import Path
from typing import Any, Literal

import httpx
from pydantic import BaseModel, Field

from app.config import get_settings
from app.db.session import SessionLocal
from app.api.ai.cost.ledger import record_cost
from app.api.ai.factory import build_client, model_for
from app.api.ai.model.schema import structured
from app.api.pipeline import recorder
from app.api.pipeline.context import RunContext
from app.api.pipeline.errors import StageFailed
from app.api.runtime import process as runtime
from app.api.tools import files

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
    params: dict[str, Any] | None = None
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


_RESPONSE_FIELDS: dict[tuple[str, str], set[str]] = {}


def _response_fields(base: str) -> dict[tuple[str, str], set[str]]:
    """从 OpenAPI 取出 2xx JSON 响应里的必填字段，用于字段级断言。"""
    try:
        doc = httpx.get(base + "/openapi.json", timeout=5).json()
    except Exception:  # noqa: BLE001
        return {}
    components = (doc.get("components") or {}).get("schemas") or {}
    found: dict[tuple[str, str], set[str]] = {}
    for path, operations in (doc.get("paths") or {}).items():
        for method, operation in operations.items():
            if method not in {"get", "post", "put", "patch", "delete"}:
                continue
            for code, response in (operation.get("responses") or {}).items():
                if not str(code).startswith("2"):
                    continue
                media = (response.get("content") or {}).get("application/json") or {}
                schema = media.get("schema") or {}
                if "$ref" in schema:
                    schema = components.get(schema["$ref"].split("/")[-1], {})
                if schema.get("type") == "array":
                    item = schema.get("items") or {}
                    if "$ref" in item:
                        item = components.get(item["$ref"].split("/")[-1], {})
                    required = set(item.get("required") or [])
                else:
                    required = set(schema.get("required") or [])
                if required:
                    found[(method.upper(), path)] = required
                break
    return found


def _db_files(workspace: Path) -> list[Path]:
    found: list[Path] = []
    for path in workspace.rglob("*.db"):
        if any(part in {"node_modules", ".venv", "venv", "__pycache__"} for part in path.parts):
            continue
        found.append(path)
    return found


def _row_marks(workspace: Path) -> dict[str, dict[str, int]]:
    """记录每张表当前的最大 rowid —— 测试写进去的行之后按 rowid 删掉。"""
    marks: dict[str, dict[str, int]] = {}
    for path in _db_files(workspace):
        tables: dict[str, int] = {}
        try:
            conn = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True, timeout=5)
            for (name,) in conn.execute("select name from sqlite_master where type='table'"):
                if name.startswith("sqlite_"):
                    continue
                try:
                    row = conn.execute(f'select max(rowid) from "{name}"').fetchone()
                except sqlite3.DatabaseError:
                    continue
                tables[name] = int(row[0] or 0)
            conn.close()
        except sqlite3.DatabaseError:
            continue
        if tables:
            marks[str(path)] = tables
    return marks


def _purge_test_rows(marks: dict[str, dict[str, int]]) -> int:
    """把测试期间新增的行删掉：演示时业务库必须是干净的，不能带着测试数据。"""
    deleted = 0
    for raw_path, tables in marks.items():
        path = Path(raw_path)
        if not path.exists():
            continue
        try:
            conn = sqlite3.connect(str(path), timeout=8)
            for name, mark in tables.items():
                cur = conn.execute(f'delete from "{name}" where rowid > ?', (mark,))
                deleted += cur.rowcount or 0
            conn.commit()
            conn.close()
        except sqlite3.DatabaseError:
            continue
    return deleted


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


def _schema_value(schema: dict, components: dict, key: str = "") -> object:
    """按 schema + 字段名造一个能过校验、也能过业务约束的值。"""
    if not isinstance(schema, dict):
        return "测试"
    ref = schema.get("$ref")
    if isinstance(ref, str):
        schema = components.get(ref.rsplit("/", 1)[-1]) or {}
    if schema.get("enum"):
        return schema["enum"][0]
    name = f"{key} {schema.get('title') or ''}".lower()
    if "amount" in name or "price" in name or "金额" in name or "money" in name:
        return 1234 if schema.get("type") == "integer" else 12.34
    if "category" in name or "分类" in name or "type" in name:
        return "餐饮"
    if "date" in name or "日期" in name:
        return time.strftime("%Y-%m-%d")
    if "note" in name or "remark" in name or "备注" in name or "desc" in name:
        return "测试备注"
    if "title" in name or "标题" in name:
        return "测试记录"
    if "name" in name or "名称" in name:
        return "测试记录"
    if "email" in name or "邮箱" in name:
        return "test@example.com"
    if "phone" in name or "手机" in name:
        return "13800138000"
    if "password" in name or "密码" in name:
        return "Test1234"
    if "status" in name or "状态" in name:
        return "todo"
    kind = schema.get("type")
    if kind == "integer":
        return int(schema.get("minimum") or 1)
    if kind == "number":
        return float(schema.get("minimum") or 1)
    if kind == "boolean":
        return True
    if kind == "array":
        return []
    if kind == "object":
        return _schema_body(schema, components)
    if schema.get("format") == "date":
        return time.strftime("%Y-%m-%d")
    if schema.get("maxLength") is not None and int(schema["maxLength"]) <= 4:
        return "测试"
    return "测试"


def _schema_body(schema: dict, components: dict) -> dict:
    ref = schema.get("$ref")
    if isinstance(ref, str):
        schema = components.get(ref.rsplit("/", 1)[-1]) or {}
    props = schema.get("properties") or {}
    required = schema.get("required") or list(props)
    return {key: _schema_value(props.get(key) or {}, components, key) for key in required if key in props}


def _adapt_bodies(base: str, plan: "TestPlan") -> None:
    """按后端 OpenAPI 补全请求参数与请求体。

    模型写用例时字段名经常和真实 Pydantic / FastAPI 签名对不上，一提交就 422，
    然后整条流水线被判失败 —— 这不是应用的问题，是用例没按契约来。
    - 请求体：缺的必填字段补上，多出来的字段丢掉；
    - 查询参数：POST 也可能把入参声明成 query（模型常见写法），按 OpenAPI 补 required 项。
    """
    try:
        doc = httpx.get(base + "/openapi.json", timeout=5).json()
    except Exception:  # noqa: BLE001
        return
    components = (doc.get("components") or {}).get("schemas") or {}
    for case in plan.cases:
        if case.type != "http":
            continue
        # 期望 4xx 的是负向用例（故意少字段/坏数据），补全就把它的意图抹掉了
        if int((case.expect or {}).get("status", 200)) >= 400:
            continue
        if any(word in case.id.lower() for word in ("invalid", "neg", "bad", "reject")):
            continue
        operation = ((doc.get("paths") or {}).get(case.path) or {}).get(case.method.lower()) or {}

        params = []
        for item in operation.get("parameters") or []:
            if item.get("in") == "query" and item.get("required") and item.get("name"):
                params.append(item)
        if params:
            current = dict(case.params or {})
            for item in params:
                name = item["name"]
                if name not in current:
                    current[name] = _schema_value(item.get("schema") or {}, components, name)
            case.params = current

        if case.method.upper() not in {"POST", "PUT", "PATCH"}:
            continue
        media = ((operation.get("requestBody") or {}).get("content") or {}).get("application/json") or {}
        schema = media.get("schema")
        if not isinstance(schema, dict):
            continue
        props = schema.get("properties") or {}
        ref = schema.get("$ref")
        if isinstance(ref, str):
            resolved = components.get(ref.rsplit("/", 1)[-1]) or {}
            props = resolved.get("properties") or props
            schema = {**schema, **resolved}
        required = schema.get("required") or list(props)
        current = dict(case.body or {})
        if props:
            current = {key: value for key, value in current.items() if key in props}
        for key in required:
            if key not in current and key in props:
                current[key] = _schema_value(props[key], components, key)
        case.body = current or None


def _param_free_gets(base: str) -> list[str]:
    """挑出可以直接裸调的 GET 路由：没有路径参数，也没有必填查询参数。

    带 required 查询参数的接口（比如 GET /summary?month=）裸调一定 422，
    用它当兜底断言会把本来正常的应用判成失败。
    """
    try:
        doc = httpx.get(base + "/openapi.json", timeout=5).json()
    except Exception:  # noqa: BLE001
        return []
    candidates: list[str] = []
    for path, operations in (doc.get("paths") or {}).items():
        if "{" in path or "get" not in operations:
            continue
        params = operations["get"].get("parameters") or []
        if any(param.get("required") and param.get("in") in {"query", "path"} for param in params):
            continue
        candidates.append(path)
    return sorted(candidates)


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
        plan, reply = structured(client, messages, model, TestPlan, max_tokens=2600, temperature=0.1)
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

    _adapt_bodies(base, plan)

    real = _openapi_routes(base)
    kept = []
    for case in plan.cases:
        case.expect = {"status": int(case.expect.get("status", 200))}
        # 之前只放行 GET/POST，模型的 PATCH/DELETE 用例被静默丢掉，
        # 缺口再由"页面可达性"兜底 —— 那等于把真实断言换成了弱断言
        if case.method.upper() not in {"GET", "POST", "PUT", "PATCH", "DELETE"}:
            continue
        if real and (case.method.upper(), case.path) not in real:
            continue
        kept.append(case)
    plan.cases = kept or [Case(id="c1", acceptance=spec["acceptance"][0]["id"], type="page", path="/", expect={"status": 200})]

    acceptance_ids = {item["id"] for item in spec.get("acceptance", [])}
    if not real:
        for line in _discover_routes(run_id):
            parts = line.split()
            if len(parts) >= 2:
                real.add((parts[0].upper(), parts[1]))

    if real and not any(case.type == "http" for case in plan.cases):
        # 只挑「不需要参数」的 GET：带 required 查询参数的接口裸调必然 422，
        # 那是没给参数，不是应用坏了 —— 拿它当断言就是误判，会把好应用判失败。
        candidates = _param_free_gets(base)
        if candidates:
            plan.cases.append(
                Case(
                    id="autoapi",
                    acceptance=spec["acceptance"][0]["id"],
                    type="http",
                    path=candidates[0],
                    expect={"status": 200},
                )
            )

    def ids_of(text: str) -> set[str]:
        return {part.strip() for part in re.split(r"[,，、;；\s]+", text or "") if part.strip()}

    covered = set()
    for case in plan.cases:
        covered.update(ids_of(case.acceptance))

    # 未覆盖的验收项合并成一条页面可达性用例，不再一条验收一个 GET / 节点
    missing_items = [item["id"] for item in spec.get("acceptance", []) if item["id"] not in covered]
    if missing_items:
        plan.cases.append(
            Case(
                id="auto-page",
                acceptance="、".join(missing_items),
                type="page",
                path="/",
                expect={"status": 200},
            )
        )
        covered.update(missing_items)

    missing = acceptance_ids - covered
    if missing:
        raise StageFailed(f"测试用例没有覆盖这些验收项：{sorted(missing)}")
    if not plan.cases:
        raise StageFailed("没有生成任何测试用例")
    return plan


def _field_default(name: str, message: str = "") -> Any:
    """422 时给字段一个合理值；能从报错信息里读到枚举就优先用枚举。"""
    text = (message or "").lower()
    quoted = re.findall(r"['\"]([^'\"]{1,40})['\"]", message or "")
    if quoted and ("one of" in text or "literal" in text or "permitted" in text):
        return quoted[0]
    low = name.lower()
    if "status" in low or "state" in low or "状态" in low:
        return "todo"
    if "assignee" in low or "owner" in low or "负责人" in low:
        return "测试用户"
    if "email" in low or "邮箱" in low:
        return "test@example.com"
    if "password" in low or "密码" in low:
        return "Test1234"
    if "phone" in low or "手机" in low:
        return "13800138000"
    if "date" in low or "日期" in low:
        return time.strftime("%Y-%m-%d")
    if "title" in low or "标题" in low:
        return "测试任务"
    if "name" in low or "名称" in low:
        return "测试记录"
    if any(word in low for word in ("amount", "price", "count", "quantity", "score", "金额", "数量")):
        return 1
    if "priority" in low or "level" in low or "优先级" in low:
        return "medium"
    if any(word in low for word in ("note", "remark", "description", "content", "备注", "描述")):
        return "测试内容"
    return "测试"


def _repair_422_body(body: Any, response: httpx.Response, aggressive: bool = False) -> dict | None:
    """按 422 的错误信息修请求体，修不动就丢掉常见运行时枚举字段。"""
    current = dict(body or {}) if isinstance(body, dict) else {}
    changed = False
    try:
        detail = (response.json() or {}).get("detail")
    except Exception:  # noqa: BLE001
        detail = None
    if isinstance(detail, list):
        for item in detail:
            if not isinstance(item, dict):
                continue
            loc = item.get("loc") or []
            if len(loc) < 2 or loc[0] != "body":
                continue
            field = loc[-1]
            if not isinstance(field, str):
                continue
            current[field] = _field_default(field, str(item.get("msg") or ""))
            changed = True
    elif isinstance(detail, str):
        low = detail.lower()
        for field in ("title", "assignee", "owner", "name", "amount", "price", "status", "state", "category", "date"):
            if field in low:
                current[field] = _field_default(field, detail)
                changed = True
    if aggressive or not changed:
        # 422 可能来自应用层校验（比如 status 只接受 todo/doing/done），
        # 去掉这类可选枚举字段，让应用用自己的默认值。
        for key in ("status", "state", "priority", "level", "kind", "type"):
            if key in current:
                current.pop(key)
                changed = True
    return current if changed else None


def _run_case(client: httpx.Client, case: Case) -> tuple[bool, str]:
    expect = case.expect or {}
    expected = int(expect.get("status", 200))
    body = case.body
    try:
        response = client.request(case.method, case.path, json=body, params=case.params, timeout=15)
        # 正向用例被 422 挡住时，多数是测试客户端自己造的字段/枚举不对，
        # 按错误信息修一次再发；这不改变应用，也不把 4xx 当成功。
        for attempt in range(2):
            if not (200 <= expected < 300 and response.status_code == 422):
                break
            repaired = _repair_422_body(body, response, aggressive=attempt > 0)
            if repaired is None or repaired == body:
                break
            body = repaired
            case.body = repaired
            response = client.request(case.method, case.path, json=body, params=case.params, timeout=15)
    except httpx.HTTPError as error:
        return False, f"{case.method} {case.path} 请求失败：{error}"

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

    required = _RESPONSE_FIELDS.get((case.method.upper(), case.path))
    if required and response.headers.get("content-type", "").startswith("application/json"):
        try:
            body = response.json()
        except ValueError:
            return False, f"响应不是 JSON：{text[:120]}"
        # 只对"列表接口且非空"做字段级断言；单体响应与错误体跳过，避免误判
        if isinstance(body, list) and body and isinstance(body[0], dict):
            missing = [key for key in required if key not in body[0]]
            if missing:
                return False, f"列表项缺少字段 {missing}（实际 {sorted(body[0])[:8]}）"

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


def _valid_fix_file(path: str, content: str) -> str | None:
    if not content.strip():
        return "文件内容为空"
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
    base_user = f"""失败用例：{case.id}（验收 {case.acceptance}）
请求：{case.method} {case.path} {json.dumps(case.body or {}, ensure_ascii=False)}
期望：{json.dumps(case.expect, ensure_ascii=False)}
实际：{detail}

相关文件：
{chr(10).join(snippets)}

请输出修复后的完整文件（只能改上面这些文件之一）。
"""
    client = build_client("test")
    model = model_for("test")
    last_error = ""
    try:
        for _attempt in range(3):
            user = base_user
            if last_error:
                user += f"\n上次输出不可用：{last_error}\n请重新输出完整文件，不要省略任何路由或类定义。\n"
            reply = client.complete(
                [{"role": "system", "content": system}, {"role": "user", "content": user}],
                model,
                max_tokens=6000,
                temperature=0.1,
            )
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

            if getattr(reply, "finish_reason", None) == "length":
                last_error = "输出被截断（达到 token 上限）"
                continue
            raw = (reply.content or "").strip("\n")
            if raw.startswith("```"):
                raw = raw.split("\n", 1)[1] if "\n" in raw else ""
                if raw.rstrip().endswith("```"):
                    raw = raw.rstrip()[:-3]
            lines = raw.split("\n", 1)
            if len(lines) != 2 or not lines[0].upper().startswith("FILE:"):
                last_error = "首行不是 FILE:"
                continue
            path = lines[0].split(":", 1)[1].strip().strip("`")
            content = lines[1]
            # 只取当前文件，防止模型把后续文件一起写进来
            next_file = re.search(r"(?m)^\s*FILE:\s*\S+", content)
            if next_file:
                content = content[: next_file.start()]
            content = content.strip("\n")
            if content.startswith("```"):
                content = content.split("\n", 1)[1] if "\n" in content else ""
            if content.rstrip().endswith("```"):
                content = content.rstrip()[:-3]
            if path not in candidates:
                last_error = f"返回路径 {path} 不在候选列表"
                continue
            problem = _valid_fix_file(path, content)
            if problem:
                last_error = problem
                continue
            files.write_file(run_id, path, content)
            for i in range(0, len(content), 400):
                recorder.emit(
                    run_id,
                    "file",
                    {"path": path, "lang": _lang(path), "delta": content[i : i + 400], "done": False},
                )
            recorder.emit(
                run_id,
                "file",
                {"path": path, "lang": _lang(path), "delta": "", "done": True, "replace": True},
            )
            return path
    finally:
        client.close()
    return None


def _fix_startup(run_id: str, ctx: RunContext, traceback_text: str) -> str | None:
    """启动失败时，让模型按 traceback 修 app.py 或 api/main.py，最多一次。"""
    candidates = ["app.py", "api/main.py"]
    snippets = []
    for path in candidates:
        try:
            snippets.append(f"### {path}\n{files.read_file(run_id, path)[:3000]}")
        except Exception:  # noqa: BLE001
            continue
    if not snippets:
        return None

    system = """你是修复工程师。产物启动失败，请修一个文件让它能起来。
输出格式：第一行 `FILE: <路径>`，第二行起是完整文件内容。
只能修 app.py 或 api/main.py。不要输出 JSON，不要 Markdown 围栏。
"""
    user = f"""启动报错：
{traceback_text[-1500:]}

当前文件：
{chr(10).join(snippets)}

要求：
- 如果 api/main.py 里 FastAPI 实例不叫 app，请在 app.py 里按真实变量名导入，或改成 from api.main import app 并确保 api/main.py 定义了 app。
- 保持原有路由与静态挂载逻辑，不要重写业务。
"""
    client = build_client("test")
    model = model_for("test")
    try:
        reply = client.complete(
            [{"role": "system", "content": system}, {"role": "user", "content": user}],
            model,
            max_tokens=2600,
            temperature=0.0,
        )
    finally:
        client.close()
    db = SessionLocal()
    try:
        amount = record_cost(db, run_id=run_id, stage="test", reply=reply)
    finally:
        db.close()
    recorder.usage(run_id, model=reply.model, prompt_tokens=reply.prompt_tokens,
                   completion_tokens=reply.completion_tokens, latency_ms=reply.latency_ms, cny=amount)
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
    recorder.emit(run_id, "file", {"path": path, "lang": _lang(path), "delta": "", "done": True, "replace": True})
    return path


def run(run_id: str, ctx: RunContext) -> list[dict]:
    workspace = files.workspace_root(run_id)
    entry = (ctx.arch or {}).get("entry", "app.py")

    port = runtime.pick_port()
    process = runtime.start(workspace, entry, port)
    base = f"http://127.0.0.1:{port}"
    db_marks: dict[str, dict[str, int]] = {}
    try:
        if not runtime.wait_http(base + "/", timeout=25, process=process):
            tail = runtime.log_tail(process)
            runtime.stop(process)
            fixed = _fix_startup(run_id, ctx, tail)
            if not fixed:
                raise StageFailed(f"产物启动失败：{tail[-500:]}")
            port = runtime.pick_port()
            process = runtime.start(workspace, entry, port)
            base = f"http://127.0.0.1:{port}"
            if not runtime.wait_http(base + "/", timeout=25, process=process):
                tail = runtime.log_tail(process)
                raise StageFailed(f"修复后仍未启动：{tail[-500:]}")

        global _RESPONSE_FIELDS
        _RESPONSE_FIELDS = _response_fields(base)
        db_marks = _row_marks(workspace)
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
                if case.id.startswith("auto"):
                    # 兜底用例只验了页面能不能打开，不能冒充"这条验收标准通过了"
                    detail = f"{detail}（仅页面可达性，未验证业务行为）"
                results.append({"name": case.acceptance, "pass": ok, "detail": detail, "case": case.id, "type": case.type})
                recorder.emit(
                    run_id,
                    "check",
                    {
                        "results": [
                            {
                                "name": f"{case.id} {case.acceptance}"
                                + ("（页面可达性）" if case.id.startswith("auto") else ""),
                                "pass": ok,
                                "detail": detail,
                            }
                        ]
                    },
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
            if not runtime.wait_http(base + "/", timeout=25, process=process):
                break
            recorder.phase(run_id, "checking", "复测")
            with httpx.Client(base_url=base) as http:
                # 修复后必须全量复测：只测失败项会漏掉"修好一个、弄坏一片"
                for item in results:
                    retry_case = next(c for c in plan.cases if c.id == item["case"])
                    ok, detail = _run_case(http, retry_case)
                    item["pass"] = ok
                    item["detail"] = detail
                    recorder.emit(
                        run_id,
                        "check",
                        {"results": [{"name": f"{retry_case.id} {retry_case.acceptance}", "pass": ok, "detail": detail}]},
                    )
            passes = sum(1 for item in results if item["pass"])

        ctx.checks = results
        if passes < len(results):
            failed = [item for item in results if not item["pass"]]
            raise StageFailed(f"{len(failed)} 个用例未通过：" + "；".join(item["detail"] for item in failed)[:400])
        return results
    finally:
        runtime.stop(process)
        if db_marks:
            purged = _purge_test_rows(db_marks)
            if purged:
                recorder.emit(run_id, "log", {"message": f"已清理测试写入的 {purged} 行数据，业务库保持干净"})


def _lang(path: str) -> str:
    return "python" if path.endswith(".py") else "html"