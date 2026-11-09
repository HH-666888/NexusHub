"""v2 运行接口。

只做真实读写，不返回任何示例数据。
编排器尚未接入时，创建运行会明确返回 503，而不是假装成功。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.db.models import Artifact, Run, RunEvent
from app.deps import get_current_user, get_db
from app.domain.user import User
from app.v2.runs.schemas import EventOut, RunOut, run_to_dict

router = APIRouter()

V2_PREFIX = "r2-"


def _owned(db: Session, run_id: str, user: User) -> Run:
    run = db.get(Run, run_id)
    if run is None or run.user_id != user.id or not run.id.startswith(V2_PREFIX):
        raise HTTPException(status_code=404, detail="run not found")
    return run


@router.get("", response_model=list[RunOut])
def list_runs(
    limit: int = 50,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[dict]:
    rows = db.execute(
        select(Run)
        .where(Run.user_id == user.id, Run.id.like(V2_PREFIX + "%"))
        .order_by(Run.created_at.desc())
        .limit(max(1, min(limit, 100)))
    ).scalars()
    return [run_to_dict(run) for run in rows]


@router.post("", status_code=201)
def create_run(
    payload: dict,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    """创建运行并交给编排器。

    编排器（阶段 C）没就绪时返回 503——不制造一个“永远不动”的假运行。
    """
    try:
        from app.v2.pipeline.orchestrator import create_and_start
    except ImportError as error:  # pragma: no cover - 骨架期
        raise HTTPException(status_code=503, detail="编排器尚未就绪（阶段 C）") from error

    prompt = str(payload.get("prompt") or "").strip()
    if not prompt:
        raise HTTPException(status_code=400, detail="prompt 不能为空")
    run = create_and_start(db, user_id=user.id, prompt=prompt)
    return run_to_dict(run)


@router.get("/{run_id}", response_model=RunOut)
def get_run(
    run_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    return run_to_dict(_owned(db, run_id, user))


@router.get("/{run_id}/events", response_model=list[EventOut])
def list_events(
    run_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[dict]:
    _owned(db, run_id, user)
    rows = db.execute(
        select(RunEvent).where(RunEvent.run_id == run_id).order_by(RunEvent.seq.asc())
    ).scalars()
    return [
        {"seq": row.seq, "kind": row.kind, "payload": row.payload, "createdAt": row.created_at}
        for row in rows
    ]


@router.delete("/{run_id}")
def delete_run(
    run_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    _owned(db, run_id, user)
    db.execute(delete(RunEvent).where(RunEvent.run_id == run_id))
    db.execute(delete(Artifact).where(Artifact.run_id == run_id))
    db.execute(delete(Run).where(Run.id == run_id))
    db.commit()
    return {"ok": True, "id": run_id}