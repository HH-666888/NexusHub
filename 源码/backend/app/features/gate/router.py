"""门禁路由（契约书 §5.3）。

- GET  /runs/{run_id}/gate
- POST /runs/{run_id}/answers
- POST /runs/{run_id}/acknowledge

路径挂在 /runs 下，所以 prefix 与 runs 相同、tags 不同。
问题存放在 `spec` 事件的 `spec.questions` 里；回答落一行 `answers.json` 产物，
不新造事件类型。演示流水线暂时不问问题，接口先备好。
"""

from __future__ import annotations

import json

from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import Artifact, Run, RunEvent
from app.deps import get_current_user, get_db
from app.domain.user import User
from app.shared.time import now_ms

router = APIRouter(prefix="/runs", tags=["gate"])


def _owned(db: Session, run_id: str, user: User) -> Run:
    run = db.get(Run, run_id)
    if run is None or run.user_id != user.id:
        raise HTTPException(status_code=404, detail="run not found")
    return run


def _questions(db: Session, run_id: str) -> list[str]:
    stmt = (
        select(RunEvent)
        .where(RunEvent.run_id == run_id, RunEvent.kind == "spec")
        .order_by(RunEvent.seq.desc())
        .limit(1)
    )
    row = db.execute(stmt).scalar_one_or_none()
    if row is None:
        return []
    spec = (row.payload or {}).get("spec") or {}
    return list(spec.get("questions") or [])


@router.get("/{run_id}/gate")
def read_gate(
    run_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    run = _owned(db, run_id, user)
    questions = _questions(db, run_id)
    return {
        "questions": [{"question": q, "answer": ""} for q in questions],
        "status": run.status,
    }


@router.post("/{run_id}/answers")
def submit_answers(
    run_id: str,
    payload: dict = Body(default_factory=dict),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    run = _owned(db, run_id, user)
    answers = payload.get("answers") or []
    answered = sum(1 for item in answers if str(item.get("answer", "")).strip())
    blank = len(answers) - answered

    content = json.dumps({"answers": answers}, ensure_ascii=False, indent=2)
    existing = db.execute(
        select(Artifact).where(Artifact.run_id == run_id, Artifact.name == "answers.json")
    ).scalar_one_or_none()
    if existing is None:
        db.add(
            Artifact(
                run_id=run_id,
                kind="json",
                name="answers.json",
                content=content,
                bytes=len(content.encode("utf-8")),
                sha256="",
                created_at=now_ms(),
            )
        )
    else:
        existing.content = content

    # 有回答就继续跑
    if run.status == "paused":
        run.status = "running"
        run.updated_at = now_ms()
    db.commit()

    return {"ok": True, "answered": answered, "blank": blank}


@router.post("/{run_id}/acknowledge")
def acknowledge(
    run_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    run = _owned(db, run_id, user)
    if run.status == "paused":
        run.status = "running"
        run.updated_at = now_ms()
        db.commit()
    return {"ok": True, "status": run.status}