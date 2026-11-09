"""向用户提问（门禁）。

任何阶段都可以调用。问题数量不设上限；每个问题必须有默认值。
调用即暂停，等到 gate.answered 或超时后用默认值继续。
"""

from __future__ import annotations

import time
from typing import Any

from sqlalchemy import select

from app.db.models import RunEvent
from app.db.session import SessionLocal
from app.v2.pipeline import recorder

POLL_SECONDS = 0.5
DEFAULT_TIMEOUT = 600


def ask_user(
    run_id: str,
    *,
    stage: str,
    questions: list[dict[str, Any]],
    timeout: int = DEFAULT_TIMEOUT,
) -> list[dict[str, Any]]:
    if not questions:
        return []

    round_no = _round_of(run_id)
    seq = recorder.emit(
        run_id,
        "gate",
        {"stage": stage, "round": round_no, "questions": questions},
    )
    recorder.set_status(run_id, "paused")

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        answers = _answers_after(run_id, seq)
        if answers is not None:
            recorder.set_status(run_id, "running")
            return answers
        if recorder.status_of(run_id) == "cancelled":
            recorder.set_status(run_id, "cancelled")
            return _defaults(questions)
        time.sleep(POLL_SECONDS)

    # 超时：按默认继续，并如实记录 auto
    answers = _defaults(questions)
    recorder.emit(
        run_id,
        "gate.answered",
        {"round": round_no, "answers": answers, "auto": True},
    )
    recorder.set_status(run_id, "running")
    return answers


def _round_of(run_id: str) -> int:
    db = SessionLocal()
    try:
        count = db.execute(
            select(RunEvent.id).where(RunEvent.run_id == run_id, RunEvent.kind == "gate")
        ).all()
        return len(count) + 1
    finally:
        db.close()


def _answers_after(run_id: str, gate_seq: int) -> list[dict[str, Any]] | None:
    db = SessionLocal()
    try:
        row = db.execute(
            select(RunEvent)
            .where(
                RunEvent.run_id == run_id,
                RunEvent.kind == "gate.answered",
                RunEvent.seq > gate_seq,
            )
            .order_by(RunEvent.seq.asc())
            .limit(1)
        ).scalar_one_or_none()
        if row is None:
            return None
        return list(row.payload.get("answers") or [])
    finally:
        db.close()


def _defaults(questions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {"id": q.get("id", ""), "value": q.get("default", ""), "auto": True}
        for q in questions
    ]