"""演示用事件发生器。

为什么需要它：真正的六道工序（调模型写代码）还没接，但**接口和前端必须是真的**。
这个模块按契约里的事件格式，一步一步往 `run_events` 写事件、同步更新 `runs` 的
阶段/状态/成本，最后落 artifacts。

以后接入真实 pipeline，只需要让 orchestrator 产出同样的事件，本文件整个删掉即可，
前端一行都不用改。
"""

from __future__ import annotations

import threading
import time
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import Artifact, Run, RunEvent
from app.db.session import SessionLocal
from app.domain.arch import ArchModule, ArchSpec
from app.domain.check import CheckResult, CheckSummary
from app.domain.module_build import BuildBatchSummary, ModuleBuildSummary
from app.domain.run import StageId
from app.domain.spec import AcceptanceCriterion, AppSpec, SpecGate
from app.pipeline import events as ev
from app.shared.time import now_ms

# 每个 run 的节奏：普通 0.32s/事件，?fast=1 时 0.06s
_PACE: dict[str, float] = {}
_DEFAULT_PACE = 0.32
_FAST_PACE = 0.06

# 线程表：防止同一个 run 被启动两次
_RUNNING: dict[str, threading.Thread] = {}
_LOCK = threading.Lock()


DEMO_FILES: list[dict[str, Any]] = [
    {
        "path": "db/schema.sql",
        "lang": "sql",
        "module": ("db", "数据库", "一张表存一次计时"),
        "content": """-- 番茄钟：一个会话一张表就够了
CREATE TABLE IF NOT EXISTS sessions (
  id          BIGINT PRIMARY KEY AUTO_INCREMENT,
  started_at  BIGINT NOT NULL,
  planned_sec INT NOT NULL DEFAULT 1500,
  ended_at    BIGINT NULL,
  created_at  BIGINT NOT NULL
);

CREATE INDEX idx_sessions_started ON sessions (started_at);
""",
    },
    {
        "path": "api/main.py",
        "lang": "python",
        "module": ("api", "后端接口", "四条路由：开始/结束/查询/健康"),
        "content": """from fastapi import FastAPI
from sqlalchemy import create_engine, text

app = FastAPI()
engine = create_engine("mysql+pymysql://app:app@127.0.0.1:3306/timer")


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/api/sessions")
def start_session():
    with engine.begin() as conn:
        conn.execute(text("INSERT INTO sessions (started_at, planned_sec, created_at) "
                          "VALUES (:s, 1500, :c)"), {"s": 0, "c": 0})
    return {"ok": True}


@app.get("/api/sessions")
def list_sessions():
    with engine.connect() as conn:
        rows = conn.execute(text("SELECT id, started_at, planned_sec FROM sessions")).mappings()
        return {"items": [dict(row) for row in rows]}
""",
    },
    {
        "path": "web/index.html",
        "lang": "html",
        "module": ("web", "前端页面", "一个圆盘、两个按钮"),
        "content": """<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>番茄钟</title>
  <style>
    body { display: grid; place-items: center; height: 100vh; font-family: sans-serif; }
    .dial { width: 220px; height: 220px; border-radius: 50%;
            background: conic-gradient(#ef4444 var(--p), #f3f4f6 0); }
  </style>
</head>
<body>
  <div class="dial" id="dial"></div>
  <div class="row">
    <button id="start">开始</button>
    <button id="reset">重置</button>
  </div>
  <script>
    let left = 1500, timer = null;
    function paint() {
      dial.style.setProperty("--p", (1 - left / 1500) * 100 + "%");
    }
    start.onclick = () => {
      timer = setInterval(() => { left -= 1; paint(); }, 1000);
    };
    reset.onclick = () => { clearInterval(timer); left = 1500; paint(); };
  </script>
</body>
</html>
""",
    },
]


def _pace_for(run_id: str) -> float:
    return _PACE.get(run_id, _DEFAULT_PACE)


def mark_pace(run_id: str, *, fast: bool) -> None:
    _PACE[run_id] = _FAST_PACE if fast else _DEFAULT_PACE


def start(run_id: str) -> bool:
    """启动一个 run 的演示流水线；已经在跑就返回 False。"""
    with _LOCK:
        thread = _RUNNING.get(run_id)
        if thread is not None and thread.is_alive():
            return False
        thread = threading.Thread(target=_run, args=(run_id,), daemon=True, name=f"demo-{run_id}")
        _RUNNING[run_id] = thread
    thread.start()
    return True


def _run(run_id: str) -> None:
    pace = _pace_for(run_id)
    try:
        _script(run_id, pace)
    except Exception as error:  # noqa: BLE001 - 演示线程不能让进程挂掉
        _safe_write(run_id, "error", {"kind": "error", "message": str(error)})
        _set_status(run_id, "failed")
    finally:
        with _LOCK:
            _RUNNING.pop(run_id, None)


# ───────────────────────── 内部动作 ─────────────────────────


def _alive(run_id: str) -> str:
    """返回当前状态；线程每一步都看它，暂停就等，取消就退。"""
    db = SessionLocal()
    try:
        run = db.get(Run, run_id)
        return run.status if run else "cancelled"
    finally:
        db.close()


def _wait_while_paused(run_id: str) -> bool:
    """暂停时原地等；返回 False 表示被取消了。"""
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
    """Pydantic 事件或普通 dict 都能发。"""
    if isinstance(event, dict):
        payload = event
        kind = payload["kind"]
    else:
        payload = event.model_dump(by_alias=True, exclude_none=True)
        kind = event.kind
    _write(run_id, kind, payload)


# ───────────────────────── 剧本 ─────────────────────────


def _script(run_id: str, pace: float) -> None:
    db = SessionLocal()
    try:
        run = db.get(Run, run_id)
        prompt = run.prompt if run else "一个番茄钟"
    finally:
        db.close()

    if not _wait_while_paused(run_id):
        return

    # 01 需求分析
    _set_stage(run_id, StageId.PLAN)
    _emit(run_id, ev.phase("spec", "需求分析"))
    time.sleep(pace)
    _emit(run_id, ev.reasoning("先把这句话拆成能验收的条目，再决定做什么、不做什么。"))
    time.sleep(pace)

    spec = AppSpec(
        prompt=prompt,
        goal="一个能开始、暂停、重置的番茄钟",
        audience="需要专注的人",
        scenarios=["开始计时", "暂停", "重置", "刷新后仍在"],
        acceptance=[
            AcceptanceCriterion(id="a1", text="点开始后圆盘开始变化"),
            AcceptanceCriterion(id="a2", text="暂停后计时停住"),
            AcceptanceCriterion(id="a3", text="重置回到 25:00"),
            AcceptanceCriterion(id="a4", text="刷新后剩余时间还在"),
            AcceptanceCriterion(id="a5", text="结束时有提示"),
        ],
        questions=[],
        model="demo",
        generated_at=now_ms(),
    )
    _emit(run_id, ev.spec_event(spec, SpecGate.DECLARED))
    time.sleep(pace)
    total = _add_cost(run_id, 0.02)
    _safe_write(run_id, "cost", {"kind": "cost", "stage": "plan", "deltaCny": 0.02, "totalCny": round(total, 4)})
    time.sleep(pace)

    # 02 架构设计
    _set_stage(run_id, StageId.DESIGN)
    _emit(run_id, ev.phase("arch", "架构设计"))
    time.sleep(pace)
    arch = ArchSpec(
        modules=[
            ArchModule(id="db", name="数据库", responsibility="存会话"),
            ArchModule(id="api", name="后端接口", responsibility="开始/结束/查询"),
            ArchModule(id="web", name="前端页面", responsibility="圆盘与按钮"),
            ArchModule(id="test", name="自测", responsibility="跑一遍主流程"),
        ],
        packages=[],
        spec=spec,
        model="demo",
        generated_at=now_ms(),
    )
    _emit(
        run_id,
        ev.arch_event(
            arch,
            __import__("app.domain.check", fromlist=["StageCheck"]).StageCheck(
                results=[],
                passed=1,
                total=1,
            ),
        ),
    )
    time.sleep(pace)
    total = _add_cost(run_id, 0.03)
    _safe_write(run_id, "cost", {"kind": "cost", "stage": "design", "deltaCny": 0.03, "totalCny": round(total, 4)})

    # 03 并行开发
    _set_stage(run_id, StageId.BUILD)
    _emit(run_id, ev.phase("building", "并行开发"))
    time.sleep(pace)

    modules = [
        ModuleBuildSummary(
            module_id=m["module"][0],
            name=m["module"][1],
            summary=m["module"][2],
            cost_cny=0.02,
            file=m["path"],
            state="live",
            progress=12,
        )
        for m in DEMO_FILES
    ]
    batch = BuildBatchSummary(
        modules=modules,
        failed=[],
        concurrency=3,
        total_cost_cny=0.06,
        peak_in_flight=3,
    )
    _emit(run_id, ev.modules(batch))
    time.sleep(pace)

    # 三路交错流式写代码
    chunks = {m["path"]: _split(m["content"]) for m in DEMO_FILES}
    lang = {m["path"]: m["lang"] for m in DEMO_FILES}
    written = {m["path"]: [] for m in DEMO_FILES}
    line_counts = {m["path"]: 0 for m in DEMO_FILES}
    longest = max(len(v) for v in chunks.values())

    for step in range(longest):
        if not _wait_while_paused(run_id):
            return
        for path, parts in chunks.items():
            if step >= len(parts):
                continue
            piece = parts[step]
            written[path].append(piece)
            line_counts[path] += piece.count("\n")
            _emit(
                run_id,
                {
                    "kind": "file",
                    "path": path,
                    "lang": lang[path],
                    "delta": piece,
                    "done": step == len(parts) - 1,
                    "lines": line_counts[path],
                },
            )
        time.sleep(pace)

    for path in written:
        _emit(
            run_id,
            {
                "kind": "file",
                "path": path,
                "lang": lang[path],
                "delta": "",
                "done": True,
                "lines": line_counts[path],
            },
        )

    total = _add_cost(run_id, 0.09)
    _safe_write(run_id, "cost", {"kind": "cost", "stage": "build", "deltaCny": 0.09, "totalCny": round(total, 4)})

    # 04 集成装配
    if not _wait_while_paused(run_id):
        return
    _set_stage(run_id, StageId.ASSEMBLE)
    _emit(run_id, ev.phase("saving", "集成装配"))
    time.sleep(pace)
    _emit(run_id, ev.text("入口、路由、配置一次接好；依赖对齐，没有悬空引用。"))
    time.sleep(pace)

    # 05 自动测试
    if not _wait_while_paused(run_id):
        return
    _set_stage(run_id, StageId.TEST)
    _emit(run_id, ev.phase("checking", "自动测试"))
    time.sleep(pace)
    results = [
        CheckResult(name="页面能打开", pass_=True, detail="200"),
        CheckResult(name="接口返回 200", pass_=True, detail="GET /api/sessions"),
        CheckResult(name="刷新后数据还在", pass_=True, detail="会话表有记录"),
    ]
    _emit(
        run_id,
        ev.check(
            results,
            CheckSummary(passed=3, total=3, failed=0),
        ),
    )
    time.sleep(pace)

    # 06 验收交付
    if not _wait_while_paused(run_id):
        return
    _set_stage(run_id, StageId.DELIVER)
    _emit(run_id, ev.phase("done", "验收交付"))
    time.sleep(pace)

    layers = [
        {"layer": "db", "passed": 3, "total": 3, "checks": [{"name": "表 sessions 存在", "pass": True}]},
        {"layer": "api", "passed": 3, "total": 3, "checks": [{"name": "GET /api/sessions", "pass": True}]},
        {"layer": "ui", "passed": 2, "total": 2, "checks": [{"name": "页面能加载", "pass": True}]},
    ]
    _emit(run_id, {"kind": "verdict", "layers": layers, "passed": 8, "total": 8})
    time.sleep(pace)

    # 产物落库
    html = next(m["content"] for m in DEMO_FILES if m["path"] == "web/index.html")
    saved = _save_artifact(run_id, "index.html", "html", html)
    _save_artifact(run_id, "spec.json", "json", spec.model_dump_json(by_alias=True, indent=2))
    _emit(
        run_id,
        {
            "kind": "artifact",
            "artifact": {"name": saved["name"], "kind": saved["kind"], "bytes": saved["bytes"]},
        },
    )

    _set_status(run_id, "done")
    _emit(run_id, ev.phase("done", "完成"))


def _split(text: str, size: int = 90) -> list[str]:
    """按固定长度切片，模拟模型吐字。切点尽量落在换行后。"""
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