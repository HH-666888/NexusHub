"""编排器：创建运行、跑六道工序、收口。

真实执行；任何一步失败都如实记录，不伪造成功。
"""

from __future__ import annotations

import threading
import traceback
import uuid

from sqlalchemy.orm import Session

from app.config import get_settings
from app.db.models import Run, Setting
from app.db.session import SessionLocal
from app.api.ai.factory import set_user_api_key
from app.shared.time import now_ms
from app.api.pipeline import recorder
from app.api.pipeline.context import RunContext
from app.api.pipeline.errors import BudgetExceeded
from app.api.pipeline.stages import STAGES, StageNotReady

_RUNNING: dict[str, threading.Thread] = {}
_LOCK = threading.Lock()
# 被删除的运行：线程可能还在某道工序里，到下个工序边界必须立刻退出，
# 否则会继续写事件、甚至再起一个预览进程，留下孤儿端口和孤儿产物。
_DELETED: set[str] = set()


def cancel(run_id: str) -> None:
    """标记一次运行已删除，流水线线程在下一个工序边界自行退出。"""
    with _LOCK:
        _DELETED.add(run_id)
    recorder.mark_deleted(run_id)


def is_deleted(run_id: str) -> bool:
    with _LOCK:
        return run_id in _DELETED


def create_and_start(db: Session, *, user_id: int, prompt: str) -> Run:
    run_id = "r-" + uuid.uuid4().hex[:20]
    stamp = now_ms()
    run = Run(
        id=run_id,
        user_id=user_id,
        prompt=prompt,
        stage="plan",
        status="running",
        workflow_version="1.0",
        total_cost_cny=0,
        created_at=stamp,
        updated_at=stamp,
    )
    db.add(run)
    db.commit()
    db.refresh(run)

    _start_thread(run_id, prompt)
    return run


def start(run_id: str, prompt: str) -> bool:
    with _LOCK:
        thread = _RUNNING.get(run_id)
        if thread is not None and thread.is_alive():
            return False
    _start_thread(run_id, prompt)
    return True


def _start_thread(run_id: str, prompt: str) -> None:
    thread = threading.Thread(target=_guard, args=(run_id, prompt), daemon=True, name=f"run-{run_id}")
    with _LOCK:
        _RUNNING[run_id] = thread
    thread.start()


def _guard(run_id: str, prompt: str) -> None:
    try:
        _loop(run_id, prompt)
    except Exception as error:  # noqa: BLE001
        recorder.error(run_id, f"编排器异常：{error}")
        recorder.set_status(run_id, "failed")
    finally:
        with _LOCK:
            _RUNNING.pop(run_id, None)
            _DELETED.discard(run_id)
        recorder.forget(run_id)


def _load_user_api_key(run_id: str) -> None:
    db = SessionLocal()
    try:
        run = db.get(Run, run_id)
        if run is None:
            return
        row = db.get(Setting, {"user_id": run.user_id, "key": "apiKey"})
        if row is not None and isinstance(row.value, str):
            set_user_api_key(row.value)
    finally:
        db.close()


def _loop(run_id: str, prompt: str) -> None:
    _load_user_api_key(run_id)
    settings = get_settings()
    ctx = RunContext(run_id=run_id, prompt=prompt)

    for stage in STAGES:
        if is_deleted(run_id):
            return
        if recorder.status_of(run_id) in {"cancelled", "paused"}:
            if recorder.status_of(run_id) == "cancelled":
                return
            # 暂停：等恢复；被取消则退出
            if not _wait_resume(run_id):
                return

        if recorder.total_cost(run_id) >= settings.run_cost_limit_cny:
            recorder.error(run_id, "预算到顶，运行已暂停", "去设置里调高单次预算")
            recorder.set_status(run_id, "paused")
            return

        recorder.set_stage(run_id, stage.id)
        recorder.phase(run_id, stage.phase, stage.label)

        try:
            stage.handler(run_id, ctx)
        except BudgetExceeded:
            recorder.error(run_id, "预算到顶，运行已暂停", "去设置里调高单次预算")
            recorder.set_status(run_id, "paused")
            return
        except StageNotReady as error:
            recorder.error(run_id, str(error))
            recorder.set_status(run_id, "failed")
            return
        except Exception as error:  # noqa: BLE001
            detail = ""
            if error.__class__.__name__ not in {"StageFailed", "StageNotReady"}:
                detail = "\n" + traceback.format_exc(limit=3)[-500:]
            recorder.error(run_id, f"{stage.label}失败：{error}{detail}")
            recorder.set_status(run_id, "failed")
            return

        if recorder.status_of(run_id) == "cancelled":
            return

        if is_deleted(run_id):
            return

    if is_deleted(run_id):
        return
    recorder.phase(run_id, "done", "完成")
    recorder.set_status(run_id, "done")


def _wait_resume(run_id: str) -> bool:
    import time

    while True:
        status = recorder.status_of(run_id)
        if status == "cancelled":
            return False
        if status != "paused":
            return True
        time.sleep(0.3)