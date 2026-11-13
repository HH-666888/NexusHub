"""v2 运行接口。

只做真实读写，不返回任何示例数据。
编排器尚未接入时，创建运行会明确返回 503，而不是假装成功。
"""

from __future__ import annotations

import time

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.db.models import Artifact, Run, RunEvent
from app.db.session import SessionLocal
from app.deps import get_current_user, get_db
from app.domain.user import User
from app.shared.sse import HEARTBEAT_FRAME, HEARTBEAT_SECONDS, SSE_HEADERS, format_event
from app.api.pipeline import orchestrator
from app.api.runs.schemas import EventOut, RunOut, run_to_dict

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
        from app.api.pipeline.orchestrator import create_and_start
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

@router.get("/{run_id}/stream")
def stream_run(
    run_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """SSE：与 v1 同样的帧格式，带 seq 与真实落库时间。"""
    _owned(db, run_id, user)

    def frames():
        last_seq = 0
        idle = 0.0
        while True:
            session = SessionLocal()
            try:
                rows = (
                    session.execute(
                        select(RunEvent)
                        .where(RunEvent.run_id == run_id, RunEvent.seq > last_seq)
                        .order_by(RunEvent.seq.asc())
                    )
                    .scalars()
                    .all()
                )
                run = session.get(Run, run_id)
                status = run.status if run is not None else "cancelled"
            finally:
                session.close()

            if rows:
                idle = 0.0
                for row in rows:
                    last_seq = row.seq
                    yield format_event({**row.payload, "seq": row.seq, "at": row.created_at})
            else:
                idle += 0.3
                if idle >= HEARTBEAT_SECONDS:
                    idle = 0.0
                    yield HEARTBEAT_FRAME
                if status in {"done", "failed", "cancelled"}:
                    return
                if status == "paused" and idle == 0.0:
                    # 暂停时保持连接，等回答或恢复
                    pass
            time.sleep(0.3)

    return StreamingResponse(frames(), headers=SSE_HEADERS)


@router.post("/{run_id}/pause")
def pause_run(run_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    _owned(db, run_id, user)
    run = db.get(Run, run_id)
    run.status = "paused"
    db.commit()
    return {"ok": True, "status": "paused"}


@router.post("/{run_id}/resume")
def resume_run(run_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    run = _owned(db, run_id, user)
    run.status = "running"
    db.commit()
    orchestrator.start(run_id, run.prompt)
    return {"ok": True, "status": "running"}


@router.post("/{run_id}/cancel")
def cancel_run(run_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    run = _owned(db, run_id, user)
    run.status = "cancelled"
    db.commit()
    return {"ok": True, "status": "cancelled"}


@router.get("/{run_id}/runtime")
def get_runtime(
    run_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    """返回真实预览地址；没有就返回 null，不编造。"""
    _owned(db, run_id, user)
    from app.db.models import RunRuntime

    row = db.get(RunRuntime, run_id)
    if row is None:
        return {"runtime": None}
    return {
        "runtime": {
            "status": row.status,
            "previewUrl": row.preview_url,
            "hostPort": row.host_port,
            "startedAt": row.started_at,
        }
    }


@router.get("/{run_id}/verdict")
def get_verdict(
    run_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    _owned(db, run_id, user)
    row = db.execute(
        select(RunEvent)
        .where(RunEvent.run_id == run_id, RunEvent.kind == "verdict")
        .order_by(RunEvent.seq.desc())
        .limit(1)
    ).scalar_one_or_none()
    if row is None:
        return {"verdict": None}
    return {"verdict": row.payload}


@router.get("/{run_id}/artifacts")
def list_artifacts(
    run_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    _owned(db, run_id, user)
    rows = db.execute(select(Artifact).where(Artifact.run_id == run_id).order_by(Artifact.name)).scalars().all()
    return {
        "artifacts": [
            {"name": row.name, "kind": row.kind, "bytes": row.bytes, "sha256": row.sha256}
            for row in rows
        ]
    }
