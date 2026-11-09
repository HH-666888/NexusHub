"""验收交付：起预览、落产物、汇总三层验收。

预览进程常驻，供前端 iframe 打开；进程信息写 run_runtimes。
"""

from __future__ import annotations

import hashlib
import json
import time

from sqlalchemy import select

from app.db.models import Artifact, RunRuntime
from app.db.session import SessionLocal
from app.shared.time import now_ms
from app.v2.pipeline import recorder
from app.v2.pipeline.context import RunContext
from app.v2.pipeline.errors import StageFailed
from app.v2.runtime import process as runtime
from app.v2.tools import files

_PREVIEWS: dict[str, object] = {}


def _task_id(run_id: str) -> str:
    return "task-deliver-" + hashlib.sha1(f"{run_id}:deliver".encode()).hexdigest()[:6]


def _put_artifact(run_id: str, name: str, content: str, kind: str) -> None:
    db = SessionLocal()
    try:
        existing = db.execute(
            select(Artifact).where(Artifact.run_id == run_id, Artifact.name == name)
        ).scalar_one_or_none()
        digest = hashlib.sha256(content.encode("utf-8")).hexdigest()
        if existing is None:
            db.add(
                Artifact(
                    run_id=run_id,
                    kind=kind,
                    name=name,
                    content=content,
                    bytes=len(content.encode("utf-8")),
                    sha256=digest,
                    created_at=now_ms(),
                )
            )
        else:
            existing.content = content
            existing.bytes = len(content.encode("utf-8"))
            existing.sha256 = digest
            existing.created_at = now_ms()
        db.commit()
    finally:
        db.close()


def _layers(run_id: str, ctx: RunContext) -> list[dict]:
    checks = ctx.checks or []
    db_checks = []
    schema = None
    try:
        schema = files.read_file(run_id, "db/schema.sql")
    except Exception:  # noqa: BLE001
        schema = None
    if schema:
        import sqlite3

        try:
            with sqlite3.connect(":memory:") as conn:
                conn.executescript(schema)
                tables = [
                    row[0]
                    for row in conn.execute(
                        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
                    )
                ]
            db_checks.append({"name": "表结构可执行", "pass": bool(tables), "detail": ", ".join(tables)})
        except sqlite3.Error as error:
            db_checks.append({"name": "表结构可执行", "pass": False, "detail": str(error)})
    else:
        db_checks.append({"name": "表结构存在", "pass": False, "detail": "没有 db/schema.sql"})

    api_checks = [
        {"name": item["name"], "pass": item["pass"], "detail": item["detail"]}
        for item in checks
        if item.get("type") == "http"
    ]
    ui_checks = [
        {"name": item["name"], "pass": item["pass"], "detail": item["detail"]}
        for item in checks
        if item.get("type") == "page"
    ]
    if not api_checks:
        api_checks = [{"name": "接口用例", "pass": False, "detail": "没有生成 http 用例"}]
    if not ui_checks:
        ui_checks = [{"name": "页面用例", "pass": False, "detail": "没有生成 page 用例"}]

    return [
        {"layer": "db", "passed": sum(1 for c in db_checks if c["pass"]), "total": len(db_checks), "checks": db_checks},
        {"layer": "api", "passed": sum(1 for c in api_checks if c["pass"]), "total": len(api_checks), "checks": api_checks},
        {"layer": "ui", "passed": sum(1 for c in ui_checks if c["pass"]), "total": len(ui_checks), "checks": ui_checks},
    ]


def run(run_id: str, ctx: RunContext) -> str:
    if not ctx.arch:
        raise StageFailed("缺少架构，无法交付")
    entry = ctx.arch.get("entry") or "app.py"
    workspace = files.workspace_root(run_id)

    task_id = _task_id(run_id)
    recorder.task(run_id, "created", task_id=task_id, stage="deliver", title="起预览与打包", kind="deliver")
    recorder.task(run_id, "started", task_id=task_id, stage="deliver", title="起预览与打包", kind="deliver")

    port = runtime.pick_port()
    process = runtime.start(workspace, entry, port)
    if not runtime.wait_http(f"http://127.0.0.1:{port}/", timeout=25):
        tail = runtime.log_tail(process)
        runtime.stop(process)
        raise StageFailed(f"预览启动失败：{tail[-500:]}")
    _PREVIEWS[run_id] = process

    preview_url = f"http://127.0.0.1:{port}/"
    db = SessionLocal()
    try:
        row = db.get(RunRuntime, run_id)
        if row is None:
            db.add(
                RunRuntime(
                    run_id=run_id,
                    container_id=f"process-{process.pid}",
                    host_port=port,
                    preview_url=preview_url,
                    status="running",
                    started_at=now_ms(),
                )
            )
        else:
            row.container_id = f"process-{process.pid}"
            row.host_port = port
            row.preview_url = preview_url
            row.status = "running"
            row.started_at = now_ms()
            row.stopped_at = None
        db.commit()
    finally:
        db.close()

    html = ""
    for candidate in ("web/index.html", "index.html"):
        try:
            html = files.read_file(run_id, candidate)
            break
        except Exception:  # noqa: BLE001
            continue
    if not html:
        html = f"<html><body><h1>产物已生成</h1><p>预览地址：{preview_url}</p></body></html>"

    _put_artifact(run_id, "index.html", html, "html")
    _put_artifact(run_id, "spec.json", json.dumps(ctx.spec, ensure_ascii=False, indent=2), "json")
    _put_artifact(run_id, "arch.json", json.dumps(ctx.arch, ensure_ascii=False, indent=2), "json")
    skip_suffix = (".db", ".pyc", ".log", ".sqlite", ".sqlite3")
    manifest = []
    total_files = 0
    for path in files.list_files(run_id):
        if path.startswith("_") or "__pycache__" in path or path.endswith(skip_suffix):
            continue
        target = files.workspace_root(run_id) / path
        try:
            size = target.stat().st_size
        except OSError:
            continue
        manifest.append({"path": path, "bytes": size})
        total_files += size
    _put_artifact(run_id, "manifest.json", json.dumps({"files": manifest}, ensure_ascii=False, indent=2), "json")

    layers = _layers(run_id, ctx)
    passed = sum(layer["passed"] for layer in layers)
    total = sum(layer["total"] for layer in layers)
    recorder.emit(run_id, "verdict", {"layers": layers, "passed": passed, "total": total})
    if passed < total:
        recorder.task(
            run_id,
            "failed",
            task_id=task_id,
            stage="deliver",
            title="起预览与打包",
            kind="deliver",
            reason=f"验收未通过：{passed}/{total}",
        )
        raise StageFailed(f"验收未通过：{passed}/{total}")

    for name in ("index.html", "spec.json", "arch.json", "manifest.json"):
        db = SessionLocal()
        try:
            artifact = db.execute(
                select(Artifact).where(Artifact.run_id == run_id, Artifact.name == name)
            ).scalar_one_or_none()
            if artifact is not None:
                recorder.emit(
                    run_id,
                    "artifact",
                    {
                        "artifact": {
                            "id": artifact.id,
                            "name": artifact.name,
                            "kind": artifact.kind,
                            "bytes": artifact.bytes,
                            "sha256": artifact.sha256,
                        }
                    },
                )
        finally:
            db.close()

    recorder.task(
        run_id,
        "done",
        task_id=task_id,
        stage="deliver",
        title="起预览与打包",
        kind="deliver",
        note=f"{passed}/{total} 通过",
        ms=int((time.monotonic() - time.time()) * 1000),
        result={"files": ["index.html", "spec.json", "arch.json", "manifest.json"], "checks": total},
    )
    ctx.files["preview"] = preview_url
    return preview_url


def stop_preview(run_id: str) -> None:
    process = _PREVIEWS.pop(run_id, None)
    if process is not None:
        runtime.stop(process)