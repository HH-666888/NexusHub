"""v2 门禁接口。

提问不设数量上限（配置项默认 0 = 不限）；
本阶段（骨架）只提供查询与回答入口，真正的暂停/恢复在阶段 D 接入编排器。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.deps import get_current_user, get_db
from app.db.models import Run, RunEvent
from app.domain.user import User

router = APIRouter()

V2_PREFIX = "r2-"


def _owned(db: Session, run_id: str, user: User) -> Run:
    run = db.get(Run, run_id)
    if run is None or run.user_id != user.id or not run.id.startswith(V2_PREFIX):
        raise HTTPException(status_code=404, detail="run not found")
    return run


@router.get("/{run_id}/gate")
def read_gate(
    run_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    """返回最近一次尚未回答的门禁；没有就是 null，不编造。"""
    _owned(db, run_id, user)
    rows = db.execute(
        select(RunEvent)
        .where(RunEvent.run_id == run_id, RunEvent.kind.in_(["gate", "gate.answered"]))
        .order_by(RunEvent.seq.desc())
        .limit(2)
    ).scalars().all()
    if not rows:
        return {"gate": None}
    latest = rows[0]
    if latest.kind == "gate.answered":
        return {"gate": None}
    return {"gate": latest.payload}


@router.post("/{run_id}/answers")
def answer_gate(
    run_id: str,
    payload: dict,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    """写入门禁回答。编排器就绪后由它消费；现在只做真实落库。"""
    _owned(db, run_id, user)
    answers = payload.get("answers")
    if not isinstance(answers, list) or not answers:
        raise HTTPException(status_code=400, detail="answers 不能为空")

    last = db.execute(
        select(RunEvent.seq).where(RunEvent.run_id == run_id).order_by(RunEvent.seq.desc()).limit(1)
    ).scalar() or 0
    body = {
        "kind": "gate.answered",
        "round": int(payload.get("round") or 1),
        "answers": answers,
        "auto": bool(payload.get("auto")),
    }
    from app.shared.time import now_ms

    db.add(RunEvent(run_id=run_id, seq=last + 1, kind="gate.answered", payload=body, created_at=now_ms()))
    db.commit()
    return {"ok": True}