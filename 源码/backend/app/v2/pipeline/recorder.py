"""事件写入。

所有阶段都通过这里写 run_events，保证 seq 严格递增、payload 形状统一。
"""

from __future__ import annotations

import threading
from typing import Any

from sqlalchemy import func, select

from app.db.models import Run, RunEvent
from app.db.session import SessionLocal
from app.shared.time import now_ms


# 单进程内并发写事件时，seq 必须串行分配，否则会撞主键
_EMIT_LOCK = threading.Lock()


def _next_seq(db, run_id: str) -> int:
    current = db.execute(
        select(func.max(RunEvent.seq)).where(RunEvent.run_id == run_id)
    ).scalar()
    return int(current or 0) + 1


def emit(run_id: str, kind: str, payload: dict[str, Any]) -> int:
    """写一条事件，返回 seq。payload 里必须自带 kind（与 SSE 帧一致）。"""
    with _EMIT_LOCK:
        db = SessionLocal()
        try:
            seq = _next_seq(db, run_id)
            body = {"kind": kind, **payload}
            db.add(RunEvent(run_id=run_id, seq=seq, kind=kind, payload=body, created_at=now_ms()))
            db.commit()
            return seq
        finally:
            db.close()


def phase(run_id: str, value: str, label: str) -> None:
    emit(run_id, "phase", {"phase": value, "label": label})


def reasoning(run_id: str, delta: str) -> None:
    emit(run_id, "reasoning", {"delta": delta[:2000]})


def text(run_id: str, delta: str) -> None:
    emit(run_id, "text", {"delta": delta[:2000]})


def error(run_id: str, message: str, hint: str | None = None) -> None:
    emit(run_id, "error", {"message": message, "hint": hint})


def cost(run_id: str, stage: str, delta_cny: float, total_cny: float) -> None:
    emit(run_id, "cost", {"stage": stage, "deltaCny": round(delta_cny, 6), "totalCny": round(total_cny, 6)})


def usage(run_id: str, *, model: str, prompt_tokens: int, completion_tokens: int, latency_ms: int, cny: float) -> None:
    emit(
        run_id,
        "usage",
        {
            "model": model,
            "usage": {"promptTokens": prompt_tokens, "completionTokens": completion_tokens},
            "costCny": cny,
            "latencyMs": latency_ms,
        },
    )


def task(
    run_id: str,
    action: str,
    *,
    task_id: str,
    stage: str,
    title: str,
    kind: str,
    note: str = "",
    file: str = "",
    reason: str = "",
    attempts: int = 1,
    ms: int | None = None,
    result: dict | None = None,
) -> None:
    state = {"created": "pending", "started": "running", "done": "done", "failed": "failed"}[action]
    body: dict[str, Any] = {
        "id": task_id,
        "stage": stage,
        "title": title,
        "kind": kind,
        "state": state,
        "note": note,
        "file": file,
        "attempts": attempts,
    }
    if reason:
        body["reason"] = reason
    if ms is not None:
        body["ms"] = ms
    if result is not None:
        body["result"] = result
    emit(run_id, "task", {"action": action, "task": body})


def set_stage(run_id: str, stage: str) -> None:
    db = SessionLocal()
    try:
        run = db.get(Run, run_id)
        if run is not None:
            run.stage = stage
            run.updated_at = now_ms()
            db.commit()
    finally:
        db.close()


def set_status(run_id: str, status: str) -> None:
    db = SessionLocal()
    try:
        run = db.get(Run, run_id)
        if run is not None:
            run.status = status
            run.updated_at = now_ms()
            db.commit()
    finally:
        db.close()


def status_of(run_id: str) -> str:
    db = SessionLocal()
    try:
        run = db.get(Run, run_id)
        return run.status if run is not None else "cancelled"
    finally:
        db.close()


def total_cost(run_id: str) -> float:
    db = SessionLocal()
    try:
        run = db.get(Run, run_id)
        return float(run.total_cost_cny or 0) if run is not None else 0.0
    finally:
        db.close()