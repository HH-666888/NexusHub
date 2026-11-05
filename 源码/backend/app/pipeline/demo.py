"""演示用事件发生器。

真正的六道工序还没接模型，但接口、事件、前端消费都必须是真格式：
- 每一步都落 `task` 事件（created / started / done），树才会一个个长出来
- 生成内容按 prompt 选模板（记账 / 待办 / 番茄钟），不再千篇一律
- 同时更新 runs 的 stage / status / cost，结束落 artifacts 与工作区文件

以后接真模型时，让 orchestrator 发同样的事件即可，本文件整个删掉。
"""

from __future__ import annotations

import threading
import time
from typing import Any

from sqlalchemy import select

from app.db.models import Artifact, Run, RunEvent
from app.db.session import SessionLocal
from app.domain.arch import ArchModule, ArchSpec
from app.domain.check import CheckResult, CheckSummary
from app.domain.module_build import BuildBatchSummary, ModuleBuildSummary
from app.domain.run import StageId
from app.domain.spec import AcceptanceCriterion, AppSpec, SpecGate
from app.pipeline import events as ev
from app.shared.time import now_ms

_PACE: dict[str, float] = {}
_DEFAULT_PACE = 0.28
_FAST_PACE = 0.05

_RUNNING: dict[str, threading.Thread] = {}
_LOCK = threading.Lock()


# ─────────────────────── 模板：输入决定内容 ───────────────────────

_FINANCE = {
    "name": "记账本",
    "goal": "一个能记一笔、能看合计的记账本",
    "scenarios": ["记一笔支出", "看本月列表", "看本月合计", "删除一笔"],
    "acceptance": [
        "能填金额和备注并保存",
        "列表按日期倒序显示",
        "底部显示本月合计",
        "刷新后数据还在",
        "空明细时显示提示文案",
    ],
    "modules": [
        ("db", "数据库", "一张 entries 表"),
        ("api", "后端接口", "增 / 查 / 汇总"),
        ("web", "前端页面", "表单 + 列表 + 合计"),
    ],
    "files": {
        "db/schema.sql": """-- 记账本：一笔一条
CREATE TABLE IF NOT EXISTS entries (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  amount REAL NOT NULL,
  note   TEXT DEFAULT '',
  day    TEXT NOT NULL
);

CREATE INDEX idx_entries_day ON entries (day);
""",
        "api/main.py": """import sqlite3

from fastapi import FastAPI

app = FastAPI()
DB = "app.db"


@app.post("/api/entries")
def add(amount: float, note: str = "", day: str = ""):
    with sqlite3.connect(DB) as conn:
        conn.execute("INSERT INTO entries (amount, note, day) VALUES (?, ?, ?)", (amount, note, day))
    return {"ok": True}


@app.get("/api/entries")
def items():
    with sqlite3.connect(DB) as conn:
        rows = conn.execute("SELECT id, amount, note, day FROM entries ORDER BY day DESC").fetchall()
    return {"items": [{"id": r[0], "amount": r[1], "note": r[2], "day": r[3]} for r in rows]}


@app.get("/api/summary")
def summary():
    with sqlite3.connect(DB) as conn:
        total = conn.execute("SELECT COALESCE(SUM(amount), 0) FROM entries").fetchone()[0]
    return {"total": total}
""",
        "web/index.html": """<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>记账本</title>
  <style>
    body { max-width: 420px; margin: 40px auto; font-family: sans-serif; }
    .row { display: flex; gap: 8px; }
    input { flex: 1; padding: 8px; }
    li { display: flex; justify-content: space-between; padding: 6px 0; }
    .total { margin-top: 12px; font-weight: 700; }
  </style>
</head>
<body>
  <h2>记账本</h2>
  <div class="row">
    <input id="amount" placeholder="金额" />
    <input id="note" placeholder="备注" />
    <button id="add">记一笔</button>
  </div>
  <ul id="list"></ul>
  <p class="total">本月合计：<span id="total">0.00</span></p>
  <script>
    async function load() {
      const data = await (await fetch("/api/entries")).json();
      list.innerHTML = data.items.map(function (item) {
        return "<li><span>" + item.note + "</span><span>¥" + Number(item.amount).toFixed(2) + "</span></li>";
      }).join("");
      const sum = await (await fetch("/api/summary")).json();
      total.textContent = Number(sum.total).toFixed(2);
    }
    add.onclick = async function () {
      const day = new Date().toISOString().slice(0, 10);
      await fetch("/api/entries?amount=" + amount.value +
        "&note=" + encodeURIComponent(note.value) + "&day=" + day, { method: "POST" });
      load();
    };
    load();
  </script>
</body>
</html>
""",
    },
    "checks": ["页面能打开", "能记一笔", "合计数字正确"],
    "failure": {
        "case": "合计数字正确",
        "reason": "SUM 在 SQLite 里返回字符串，前端拼成 0.0050.00 这样的数字",
        "file": "api/main.py",
        "find": 'return {"total": total}',
        "replace": 'return {"total": float(total or 0)}',
    },
}

_TODO = {
    "name": "待办清单",
    "goal": "一个能加、能勾、能删的待办清单",
    "scenarios": ["加一条待办", "勾选完成", "删除", "刷新后还在"],
    "acceptance": [
        "能输入标题并添加",
        "能勾选完成状态",
        "完成的条目样式变淡",
        "能删除条目",
        "刷新后列表还在",
    ],
    "modules": [
        ("db", "数据库", "一张 todos 表"),
        ("api", "后端接口", "增 / 改 / 删 / 查"),
        ("web", "前端页面", "输入框 + 列表"),
    ],
    "files": {
        "db/schema.sql": """-- 待办清单
CREATE TABLE IF NOT EXISTS todos (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  title   TEXT NOT NULL,
  done    INTEGER NOT NULL DEFAULT 0,
  created TEXT NOT NULL
);

CREATE INDEX idx_todos_created ON todos (created);
""",
        "api/main.py": """import sqlite3

from fastapi import FastAPI

app = FastAPI()
DB = "app.db"


@app.post("/api/todos")
def add(title: str):
    with sqlite3.connect(DB) as conn:
        conn.execute("INSERT INTO todos (title, created) VALUES (?, datetime('now'))", (title,))
    return {"ok": True}


@app.post("/api/todos/{todo_id}/toggle")
def toggle(todo_id: int):
    with sqlite3.connect(DB) as conn:
        conn.execute("UPDATE todos SET done = 1 - done WHERE id = ?", (todo_id,))
    return {"ok": True}


@app.delete("/api/todos/{todo_id}")
def remove(todo_id: int):
    with sqlite3.connect(DB) as conn:
        conn.execute("DELETE FROM todos WHERE id = ?", (todo_id,))
    return {"ok": True}


@app.get("/api/todos")
def items():
    with sqlite3.connect(DB) as conn:
        rows = conn.execute("SELECT id, title, done FROM todos ORDER BY id DESC").fetchall()
    return {"items": [{"id": r[0], "title": r[1], "done": bool(r[2])} for r in rows]}
""",
        "web/index.html": """<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>待办清单</title>
  <style>
    body { max-width: 420px; margin: 40px auto; font-family: sans-serif; }
    .row { display: flex; gap: 8px; }
    input { flex: 1; padding: 8px; }
    li { display: flex; gap: 8px; align-items: center; padding: 6px 0; }
    li.done span { color: #9ca3af; text-decoration: line-through; }
    li span { flex: 1; }
  </style>
</head>
<body>
  <h2>待办清单</h2>
  <div class="row"><input id="title" placeholder="要做的事" /><button id="add">添加</button></div>
  <ul id="list"></ul>
  <script>
    async function load() {
      const data = await (await fetch("/api/todos")).json();
      list.innerHTML = data.items.map(function (todo) {
        return '<li class="' + (todo.done ? "done" : "") + '">' +
          '<input type="checkbox" ' + (todo.done ? "checked" : "") + ' data-id="' + todo.id + '" class="toggle">' +
          "<span>" + todo.title + "</span>" +
          '<button data-del="' + todo.id + '">删</button></li>';
      }).join("");
    }
    list.onclick = async function (event) {
      const id = event.target.dataset.id || event.target.dataset.del;
      if (!id) return;
      if (event.target.dataset.del) {
        await fetch("/api/todos/" + id, { method: "DELETE" });
      } else {
        await fetch("/api/todos/" + id + "/toggle", { method: "POST" });
      }
      load();
    };
    add.onclick = async function () {
      await fetch("/api/todos?title=" + encodeURIComponent(title.value), { method: "POST" });
      title.value = "";
      load();
    };
    load();
  </script>
</body>
</html>
""",
    },
    "checks": ["页面能打开", "能加一条", "能勾选完成"],
    "failure": {
        "case": "能勾选完成",
        "reason": "done 字段在 SQLite 里是整数，1 - done 遇到 NULL 会算成 NULL，勾选没反应",
        "file": "api/main.py",
        "find": "UPDATE todos SET done = 1 - done WHERE id = ?",
        "replace": "UPDATE todos SET done = CASE COALESCE(done, 0) WHEN 1 THEN 0 ELSE 1 END WHERE id = ?",
    },
}

_POMODORO = {
    "name": "番茄钟",
    "goal": "一个能开始、暂停、重置的番茄钟",
    "scenarios": ["开始计时", "暂停", "重置", "刷新后仍在"],
    "acceptance": [
        "点开始后圆盘开始变化",
        "暂停后计时停住",
        "重置回到 25:00",
        "刷新后剩余时间还在",
        "结束时有提示",
    ],
    "modules": [
        ("db", "数据库", "一张 sessions 表"),
        ("api", "后端接口", "开始 / 结束 / 查询"),
        ("web", "前端页面", "圆盘 + 按钮"),
    ],
    "files": {
        "db/schema.sql": """-- 番茄钟：一个会话一张表
CREATE TABLE IF NOT EXISTS sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  INTEGER NOT NULL,
  planned_sec INTEGER NOT NULL DEFAULT 1500,
  ended_at    INTEGER
);

CREATE INDEX idx_sessions_started ON sessions (started_at);
""",
        "api/main.py": """import sqlite3
import time

from fastapi import FastAPI

app = FastAPI()
DB = "app.db"


@app.post("/api/sessions")
def start():
    with sqlite3.connect(DB) as conn:
        conn.execute("INSERT INTO sessions (started_at) VALUES (?)", (int(time.time()),))
    return {"ok": True}


@app.post("/api/sessions/{sid}/end")
def end(sid: int):
    with sqlite3.connect(DB) as conn:
        conn.execute("UPDATE sessions SET ended_at = ? WHERE id = ?", (int(time.time()), sid))
    return {"ok": True}


@app.get("/api/sessions")
def items():
    with sqlite3.connect(DB) as conn:
        rows = conn.execute("SELECT id, started_at, planned_sec FROM sessions").fetchall()
    return {"items": [{"id": r[0], "started": r[1], "planned": r[2]} for r in rows]}
""",
        "web/index.html": """<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>番茄钟</title>
  <style>
    body { display: flex; flex-direction: column; align-items: center; justify-content: center;
           gap: 24px; height: 100vh; margin: 0; font-family: sans-serif; background: #fafafa; }
    .dial { --p: 0%; width: 220px; height: 220px; border-radius: 50%;
            border: 6px solid #f3f4f6; background: conic-gradient(#ef4444 var(--p), #f3f4f6 0);
            box-shadow: inset 0 0 0 14px #fff; }
    .row { display: flex; gap: 12px; }
    button { padding: 10px 22px; border: 0; border-radius: 999px; background: #ef4444; color: #fff; }
    button#reset { background: #e5e7eb; color: #374151; }
  </style>
</head>
<body>
  <div class="dial" id="dial"></div>
  <div class="row"><button id="start">开始</button><button id="reset">重置</button></div>
  <script>
    let left = 1500, timer = null;
    function paint() { dial.style.setProperty("--p", (1 - left / 1500) * 100 + "%"); }
    start.onclick = function () {
      fetch("/api/sessions", { method: "POST" });
      timer = setInterval(function () { left -= 1; paint(); }, 1000);
    };
    reset.onclick = function () { clearInterval(timer); left = 1500; paint(); };
  </script>
</body>
</html>
""",
    },
    "checks": ["页面能打开", "能开始计时", "刷新后会话还在"],
    "failure": {
        "case": "刷新后会话还在",
        "reason": "重新进入页面时 planned_sec 取到 NULL，计时器从 0 开始",
        "file": "api/main.py",
        "find": "SELECT id, started_at, planned_sec FROM sessions",
        "replace": "SELECT id, started_at, COALESCE(planned_sec, 1500) FROM sessions",
    },
}


def _template_for(prompt: str) -> dict[str, Any]:
    text = prompt or ""
    if any(word in text for word in ("记账", "账本", "收入", "支出", "账单")):
        return _FINANCE
    if any(word in text for word in ("待办", "清单", "todo", "任务", "勾选")):
        return _TODO
    return _POMODORO


# ─────────────────────── 生命周期 ───────────────────────


def mark_pace(run_id: str, *, fast: bool) -> None:
    _PACE[run_id] = _FAST_PACE if fast else _DEFAULT_PACE


def start(run_id: str) -> bool:
    with _LOCK:
        thread = _RUNNING.get(run_id)
        if thread is not None and thread.is_alive():
            return False
        thread = threading.Thread(target=_run, args=(run_id,), daemon=True, name=f"demo-{run_id}")
        _RUNNING[run_id] = thread
    thread.start()
    return True


def _run(run_id: str) -> None:
    try:
        _script(run_id, _PACE.get(run_id, _DEFAULT_PACE))
    except Exception as error:  # noqa: BLE001
        _safe_write(run_id, "error", {"kind": "error", "message": str(error)})
        _set_status(run_id, "failed")
    finally:
        with _LOCK:
            _RUNNING.pop(run_id, None)


# ─────────────────────── 内部动作 ───────────────────────


def _alive(run_id: str) -> str:
    db = SessionLocal()
    try:
        run = db.get(Run, run_id)
        return run.status if run else "cancelled"
    finally:
        db.close()


def _wait_while_paused(run_id: str) -> bool:
    while True:
        status = _alive(run_id)
        if status == "cancelled":
            return False
        if status != "paused":
            return True
        time.sleep(0.2)


def _write(run_id: str, kind: str, payload: dict[str, Any]) -> None:
    db = SessionLocal()
    try:
        last = db.execute(
            select(RunEvent.seq).where(RunEvent.run_id == run_id).order_by(RunEvent.seq.desc()).limit(1)
        ).scalar()
        seq = (last or 0) + 1
        db.add(RunEvent(run_id=run_id, seq=seq, kind=kind, payload=payload, created_at=now_ms()))
        db.commit()
    finally:
        db.close()


def _safe_write(run_id: str, kind: str, payload: dict[str, Any]) -> None:
    try:
        _write(run_id, kind, payload)
    except Exception:  # noqa: BLE001
        pass


def _set_stage(run_id: str, stage: str) -> None:
    db = SessionLocal()
    try:
        run = db.get(Run, run_id)
        if run:
            run.stage = stage
            run.updated_at = now_ms()
            db.commit()
    finally:
        db.close()


def _set_status(run_id: str, status: str) -> None:
    db = SessionLocal()
    try:
        run = db.get(Run, run_id)
        if run:
            run.status = status
            run.updated_at = now_ms()
            db.commit()
    finally:
        db.close()


def _budget_of(run_id: str) -> float | None:
    from app.db.models import Setting

    db = SessionLocal()
    try:
        run = db.get(Run, run_id)
        if run is None:
            return None
        row = db.execute(
            select(Setting).where(Setting.user_id == run.user_id, Setting.key == "budgetPerRun")
        ).scalar_one_or_none()
        if row is None:
            return None
        try:
            value = float(row.value)
        except (TypeError, ValueError):
            return None
        return value if value > 0 else None
    finally:
        db.close()


def _add_cost(run_id: str, amount: float) -> float:
    db = SessionLocal()
    try:
        run = db.get(Run, run_id)
        if run is None:
            return 0.0
        run.total_cost_cny = float(run.total_cost_cny or 0) + amount
        run.updated_at = now_ms()
        db.commit()
        return float(run.total_cost_cny)
    finally:
        db.close()


def _save_artifact(run_id: str, name: str, kind: str, content: str) -> dict[str, Any]:
    import hashlib

    data = content.encode("utf-8")
    digest = hashlib.sha256(data).hexdigest()
    db = SessionLocal()
    try:
        existing = db.execute(
            select(Artifact).where(Artifact.run_id == run_id, Artifact.name == name)
        ).scalar_one_or_none()
        if existing is not None:
            existing.content = content
            existing.bytes = len(data)
            existing.sha256 = digest
        else:
            db.add(
                Artifact(
                    run_id=run_id,
                    kind=kind,
                    name=name,
                    content=content,
                    bytes=len(data),
                    sha256=digest,
                    created_at=now_ms(),
                )
            )
        db.commit()
    finally:
        db.close()
    return {"name": name, "kind": kind, "bytes": len(data), "sha256": digest}


def _emit(run_id: str, event: Any) -> None:
    if isinstance(event, dict):
        _write(run_id, event["kind"], event)
        return
    _write(run_id, event.kind, event.model_dump(by_alias=True, exclude_none=True))


def _task(
    run_id: str,
    *,
    task_id: str,
    stage: str,
    title: str,
    kind: str,
    action: str,
    note: str = "",
    file: str = "",
    reason: str = "",
) -> None:
    state = {"created": "pending", "started": "running", "done": "done", "failed": "failed"}[action]
    task = {
        "id": task_id,
        "stage": stage,
        "title": title,
        "kind": kind,
        "state": state,
        "note": note,
        "file": file,
        "attempts": 1,
    }
    if reason:
        task["reason"] = reason
    _safe_write(run_id, "task", {"kind": "task", "action": action, "task": task})


def write_workspace(run_id: str, template: dict[str, Any] | None = None) -> str:
    """把产物文件写到运行时工作区，供预览进程直接跑。"""
    from pathlib import Path

    from app.config import get_settings

    files = (template or _POMODORO)["files"]
    root = Path(get_settings().runtime_workspace_dir).resolve() / run_id
    for path, content in files.items():
        target = root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
    return str(root)


# ─────────────────────── 剧本 ───────────────────────


def _script(run_id: str, pace: float) -> None:
    db = SessionLocal()
    try:
        run = db.get(Run, run_id)
        prompt = run.prompt if run else "一个番茄钟"
    finally:
        db.close()

    template = _template_for(prompt)
    budget = _budget_of(run_id)

    def over_budget(total: float) -> bool:
        return budget is not None and total >= budget

    if not _wait_while_paused(run_id):
        return

    # ── 01 需求分析 ──
    _set_stage(run_id, StageId.PLAN)
    _emit(run_id, ev.phase("spec", "需求分析"))
    _task(run_id, task_id="t-plan-1", stage="plan", title="澄清需求边界", kind="clarify", action="created")
    _task(run_id, task_id="t-plan-2", stage="plan", title="写验收标准", kind="spec", action="created")
    time.sleep(pace)

    _task(run_id, task_id="t-plan-1", stage="plan", title="澄清需求边界", kind="clarify", action="started")
    _emit(run_id, ev.reasoning(f"先确认「{prompt[:18]}」要做什么、不做什么。"))
    time.sleep(pace)
    _task(run_id, task_id="t-plan-1", stage="plan", title="澄清需求边界", kind="clarify", action="done", note="边界已定")

    spec = AppSpec(
        prompt=prompt,
        goal=template["goal"],
        audience="需要它的人",
        scenarios=template["scenarios"],
        acceptance=[
            AcceptanceCriterion(id=f"a{index + 1}", text=text)
            for index, text in enumerate(template["acceptance"])
        ],
        questions=[],
        model="demo",
        generated_at=now_ms(),
    )
    _task(run_id, task_id="t-plan-2", stage="plan", title="写验收标准", kind="spec", action="started")
    time.sleep(pace)
    _task(run_id, task_id="t-plan-2", stage="plan", title="写验收标准", kind="spec", action="done",
          note=f"{len(template['acceptance'])} 条")
    _emit(run_id, ev.spec_event(spec, SpecGate.DECLARED))

    total = _add_cost(run_id, 0.02)
    _safe_write(run_id, "cost", {"kind": "cost", "stage": "plan", "deltaCny": 0.02, "totalCny": round(total, 4)})
    if over_budget(total):
        _safe_write(run_id, "error", {"kind": "error", "message": "预算到顶，已停在需求分析", "hint": "去设置里调高单次预算"})
        _set_status(run_id, "paused")
        return

    # ── 02 架构设计 ──
    _set_stage(run_id, StageId.DESIGN)
    _emit(run_id, ev.phase("arch", "架构设计"))
    _task(run_id, task_id="t-design-1", stage="design", title="划模块边界", kind="design", action="created")
    _task(run_id, task_id="t-design-2", stage="design", title="定数据流", kind="design", action="created")
    time.sleep(pace)

    _task(run_id, task_id="t-design-1", stage="design", title="划模块边界", kind="design", action="started")
    time.sleep(pace)
    arch = ArchSpec(
        modules=[ArchModule(id=m[0], name=m[1], responsibility=m[2]) for m in template["modules"]],
        packages=[],
        spec=spec,
        model="demo",
        generated_at=now_ms(),
    )
    _task(run_id, task_id="t-design-1", stage="design", title="划模块边界", kind="design", action="done",
          note=f"{len(template['modules'])} 个模块")
    _emit(run_id, ev.arch_event(arch, {"results": [], "passed": 1, "total": 1}))

    _task(run_id, task_id="t-design-2", stage="design", title="定数据流", kind="design", action="started")
    time.sleep(pace)
    _task(run_id, task_id="t-design-2", stage="design", title="定数据流", kind="design", action="done",
          note="页面 → 接口 → 表")

    total = _add_cost(run_id, 0.03)
    _safe_write(run_id, "cost", {"kind": "cost", "stage": "design", "deltaCny": 0.03, "totalCny": round(total, 4)})
    if over_budget(total):
        _safe_write(run_id, "error", {"kind": "error", "message": "预算到顶，已停在架构设计", "hint": "去设置里调高单次预算"})
        _set_status(run_id, "paused")
        return

    # ── 03 并行开发 ──
    _set_stage(run_id, StageId.BUILD)
    _emit(run_id, ev.phase("building", "并行开发"))
    for module_id, module_name, summary in template["modules"]:
        _task(
            run_id,
            task_id=f"t-build-{module_id}",
            stage="build",
            title=f"写{module_name}",
            kind="code",
            action="created",
            file=_file_of(template, module_id),
        )
    time.sleep(pace)

    batch = BuildBatchSummary(
        modules=[
            ModuleBuildSummary(
                module_id=module_id,
                name=module_name,
                summary=summary,
                cost_cny=0.02,
                file=_file_of(template, module_id),
                state="live",
                progress=0,
            )
            for module_id, module_name, summary in template["modules"]
        ],
        failed=[],
        concurrency=len(template["modules"]),
        total_cost_cny=0.06,
        peak_in_flight=len(template["modules"]),
    )
    _emit(run_id, ev.modules(batch))

    chunks = {path: _split(content) for path, content in template["files"].items()}
    line_counts = {path: 0 for path in template["files"]}
    started: set[str] = set()
    longest = max(len(value) for value in chunks.values())

    for step in range(longest):
        if not _wait_while_paused(run_id):
            return
        for path, parts in chunks.items():
            if step >= len(parts):
                continue
            module_id = _module_of(path)
            if path not in started:
                started.add(path)
                _task(run_id, task_id=f"t-build-{module_id}", stage="build",
                      title=f"写{_module_name(template, path)}", kind="code", action="started", file=path)
            piece = parts[step]
            line_counts[path] += piece.count("\n")
            _emit(
                run_id,
                {
                    "kind": "file",
                    "path": path,
                    "lang": _lang_of(path),
                    "delta": piece,
                    "done": step == len(parts) - 1,
                    "lines": line_counts[path],
                },
            )
        time.sleep(pace)

    for path, content in template["files"].items():
        _emit(run_id, {"kind": "file", "path": path, "lang": _lang_of(path), "delta": "", "done": True,
                       "lines": content.count("\n")})
        _task(run_id, task_id=f"t-build-{_module_of(path)}", stage="build",
              title=f"写{_module_name(template, path)}", kind="code", action="done",
              file=path, note=f"{content.count(chr(10))} 行")

    total = _add_cost(run_id, 0.09)
    _safe_write(run_id, "cost", {"kind": "cost", "stage": "build", "deltaCny": 0.09, "totalCny": round(total, 4)})

    # ── 04 集成装配 ──
    if not _wait_while_paused(run_id):
        return
    _set_stage(run_id, StageId.ASSEMBLE)
    _emit(run_id, ev.phase("saving", "集成装配"))
    _task(run_id, task_id="t-assemble-1", stage="assemble", title="接线与配置", kind="wire", action="created")
    time.sleep(pace)
    _task(run_id, task_id="t-assemble-1", stage="assemble", title="接线与配置", kind="wire", action="started")
    _emit(run_id, ev.text("入口、路由、配置一次接好；依赖对齐，没有悬空引用。"))
    time.sleep(pace)
    _task(run_id, task_id="t-assemble-1", stage="assemble", title="接线与配置", kind="wire", action="done",
          note="入口已通")

    # ── 05 自动测试 ──
    if not _wait_while_paused(run_id):
        return
    _set_stage(run_id, StageId.TEST)
    _emit(run_id, ev.phase("checking", "自动测试"))

    files = dict(template["files"])          # 修复会改动这里，最终产物用改后的
    failure = template.get("failure") or {}
    results = []

    for index, name in enumerate(template["checks"]):
        task_id = f"t-test-{index + 1}"
        _task(run_id, task_id=task_id, stage="test", title=name, kind="test", action="created")
        time.sleep(pace)
        _task(run_id, task_id=task_id, stage="test", title=name, kind="test", action="started")
        time.sleep(pace)

        # 最后一条用例先失败一次，然后回环修复、复测通过
        if failure and name == failure["case"]:
            _task(run_id, task_id=task_id, stage="test", title=name, kind="test",
                  action="failed", reason=failure["reason"])
            _emit(run_id, ev.check(results, CheckSummary(
                passed=len(results), total=len(template["checks"]), failed=1)))
            _emit(run_id, ev.reasoning("先别往下走：" + failure["reason"]))

            if not _wait_while_paused(run_id):
                return

            # 回到第 3 道修代码
            _set_stage(run_id, StageId.BUILD)
            _emit(run_id, ev.phase("building", "回环修复"))
            fix_id = "t-fix-1"
            fix_title = "修复：" + failure["case"]
            _task(run_id, task_id=fix_id, stage="build", title=fix_title, kind="fix",
                  action="created", file=failure["file"], note="按失败原因定位")
            time.sleep(pace)
            _task(run_id, task_id=fix_id, stage="build", title=fix_title, kind="fix",
                  action="started", file=failure["file"])

            patched = files[failure["file"]].replace(failure["find"], failure["replace"], 1)
            files[failure["file"]] = patched
            _emit(run_id, {
                "kind": "file",
                "path": failure["file"],
                "lang": _lang_of(failure["file"]),
                "delta": patched,
                "replace": True,
                "done": True,
                "lines": patched.count(chr(10)),
            })
            time.sleep(pace)
            _task(run_id, task_id=fix_id, stage="build", title=fix_title, kind="fix",
                  action="done", file=failure["file"], note="改完")

            total = _add_cost(run_id, 0.02)
            _safe_write(run_id, "cost", {"kind": "cost", "stage": "build",
                                         "deltaCny": 0.02, "totalCny": round(total, 4)})

            # 回到第 5 道复测
            if not _wait_while_paused(run_id):
                return
            _set_stage(run_id, StageId.TEST)
            _emit(run_id, ev.phase("checking", "复测"))
            retest_id = f"t-test-retest-{index + 1}"
            retest_title = "复测：" + name
            _task(run_id, task_id=retest_id, stage="test", title=retest_title, kind="test", action="created")
            time.sleep(pace)
            _task(run_id, task_id=retest_id, stage="test", title=retest_title, kind="test", action="started")
            time.sleep(pace)
            _task(run_id, task_id=retest_id, stage="test", title=retest_title, kind="test",
                  action="done", note="通过")
            results.append(CheckResult(name=name, pass_=True, detail="修复后通过"))
            continue

        _task(run_id, task_id=task_id, stage="test", title=name, kind="test", action="done", note="通过")
        results.append(CheckResult(name=name, pass_=True, detail="通过"))

    _emit(run_id, ev.check(results, CheckSummary(passed=len(results), total=len(results), failed=0)))

    # ── 06 验收交付 ──
    if not _wait_while_paused(run_id):
        return
    _set_stage(run_id, StageId.DELIVER)
    _emit(run_id, ev.phase("deliver", "验收交付"))
    _task(run_id, task_id="t-deliver-1", stage="deliver", title="打包产物", kind="deliver", action="created")
    time.sleep(pace)

    layers = [
        {"layer": "db", "passed": 1, "total": 1, "checks": [{"name": "表已建好", "pass": True}]},
        {"layer": "api", "passed": 1, "total": 1, "checks": [{"name": "接口可访问", "pass": True}]},
        {"layer": "ui", "passed": 1, "total": 1, "checks": [{"name": "页面能加载", "pass": True}]},
    ]
    _emit(run_id, {"kind": "verdict", "layers": layers, "passed": 3, "total": 3})

    html = files["web/index.html"]
    saved = _save_artifact(run_id, "index.html", "html", html)
    _save_artifact(run_id, "spec.json", "json", spec.model_dump_json(by_alias=True, indent=2))
    try:
        write_workspace(run_id, {"files": files})
    except Exception:  # noqa: BLE001
        pass
    _emit(run_id, {"kind": "artifact", "artifact": {"name": saved["name"], "kind": saved["kind"], "bytes": saved["bytes"]}})

    _task(run_id, task_id="t-deliver-1", stage="deliver", title="打包产物", kind="deliver", action="done",
          note="可预览")

    _set_status(run_id, "done")
    _emit(run_id, ev.phase("done", "完成"))


# ─────────────────────── 小工具 ───────────────────────


def _file_of(template: dict[str, Any], module_id: str) -> str:
    prefix = {"db": "db/", "api": "api/", "web": "web/"}.get(module_id, "")
    for path in template["files"]:
        if path.startswith(prefix):
            return path
    return ""


def _module_of(path: str) -> str:
    if path.startswith("db/"):
        return "db"
    if path.startswith("api/"):
        return "api"
    return "web"


def _module_name(template: dict[str, Any], path: str) -> str:
    module_id = _module_of(path)
    for mid, name, _ in template["modules"]:
        if mid == module_id:
            return name
    return module_id


def _lang_of(path: str) -> str:
    if path.endswith(".sql"):
        return "sql"
    if path.endswith(".py"):
        return "python"
    return "html"


def _split(text: str, size: int = 80) -> list[str]:
    parts: list[str] = []
    start = 0
    while start < len(text):
        end = min(len(text), start + size)
        newline = text.rfind("\n", start, end)
        if newline > start + 20:
            end = newline + 1
        parts.append(text[start:end])
        start = end
    return parts