"""运行路由。

- GET  /runs                  当前用户的运行列表
- POST /runs                  建运行（落一行 running 记录）
- GET  /runs/{run_id}         运行详情
- GET  /runs/{run_id}/events  事件流（按 seq 升序）
- GET  /runs/{run_id}/artifacts 产物清单（不含正文）
"""

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select

from app.db.models import RunEvent
from app.features.runtime import runner as runtime_runner
from app.features.runtime import service as runtime_service
from app.features.runtime.repo import SqlRuntimeRepo
from app.pipeline import demo
from app.shared.time import now_ms
from sqlalchemy.orm import Session

from app.deps import get_current_user, get_db
from app.domain.user import User
from app.features.runs import service
from app.features.runs.schemas import (
    EventOut,
    RunCreate,
    artifact_to_dict,
    event_to_dict,
    run_to_dict,
)

router = APIRouter(prefix="/runs", tags=["runs"])


def _owned_or_404(db: Session, run_id: str, user: User):
    run = service.get(db, run_id=run_id, user_id=user.id)
    if run is None:
        raise HTTPException(status_code=404, detail="run not found")
    return run


@router.get("")
def list_runs(
    limit: int = Query(50, ge=1, le=100),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[dict]:
    return [run_to_dict(run) for run in service.list_for_user(db, user_id=user.id, limit=limit)]


@router.post("", status_code=201)
def create_run(
    payload: RunCreate,
    fast: bool = Query(False, description="演示节奏：true=每 60ms 一个事件"),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    run = service.create(db, user_id=user.id, prompt=payload.prompt)
    demo.mark_pace(run.id, fast=fast)
    demo.start(run.id)
    return run_to_dict(run)


@router.get("/{run_id}")
def get_run(
    run_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    return run_to_dict(_owned_or_404(db, run_id, user))


@router.get("/{run_id}/events", response_model=list[EventOut])
def list_events(
    run_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[dict]:
    _owned_or_404(db, run_id, user)
    return [event_to_dict(event) for event in service.events(db, run_id=run_id)]


@router.get("/{run_id}/artifacts")
def list_artifacts(
    run_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[dict]:
    _owned_or_404(db, run_id, user)
    return [artifact_to_dict(item) for item in service.artifacts(db, run_id=run_id)]

@router.post("/{run_id}/pause")
def pause_run(
    run_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    _owned_or_404(db, run_id, user)
    service.set_status(db, run_id=run_id, status="paused")
    return {"ok": True, "status": "paused"}


@router.post("/{run_id}/resume")
def resume_run(
    run_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    _owned_or_404(db, run_id, user)
    service.set_status(db, run_id=run_id, status="running")
    demo.start(run_id)
    return {"ok": True, "status": "running"}


@router.post("/{run_id}/cancel")
def cancel_run(
    run_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    _owned_or_404(db, run_id, user)
    service.set_status(db, run_id=run_id, status="cancelled")
    return {"ok": True, "status": "cancelled"}


@router.get("/{run_id}/verdict")
def get_verdict(
    run_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    """优先跑真实的三层验证；Docker 不可用时回退到已存的 verdict 事件。"""
    _owned_or_404(db, run_id, user)

    try:
        from app.features.runtime import service as runtime_service
        from app.features.runtime.repo import SqlRuntimeRepo

        verdict = runtime_service.verify_run(SqlRuntimeRepo(db), run_id=run_id)
        return {"source": "runtime", **verdict.model_dump(by_alias=True)}
    except Exception:  # noqa: BLE001 - 没容器/没 Docker 都回退
        pass

    stmt = (
        select(RunEvent)
        .where(RunEvent.run_id == run_id, RunEvent.kind == "verdict")
        .order_by(RunEvent.seq.desc())
        .limit(1)
    )
    row = db.execute(stmt).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="还没有验收结果")
    payload = dict(row.payload)
    payload["source"] = "stored"
    return payload

@router.post("/{run_id}/runtime")
def start_runtime(
    run_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    """把产物当本机进程跑起来（RUNTIME_RUNNER=process），返回可打开的预览地址。"""
    _owned_or_404(db, run_id, user)
    files_dir = demo.write_workspace(run_id)
    try:
        record = runtime_service.start_runtime(
            SqlRuntimeRepo(db), run_id=run_id, files_dir=files_dir, now=now_ms()
        )
        db.commit()
    except Exception as error:  # noqa: BLE001 - 起不来要把原因告诉前端
        db.rollback()
        raise HTTPException(status_code=503, detail=str(error)) from error
    return {"status": record.status, "previewUrl": record.preview_url}


@router.get("/{run_id}/runtime")
def read_runtime(
    run_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    _owned_or_404(db, run_id, user)
    record = SqlRuntimeRepo(db).find_runtime(run_id)
    if record is None:
        return {"status": "none", "previewUrl": None}
    status = record.status
    if status == "running" and not runtime_runner.is_running(record.container_id):
        status = "exited"
    return {"status": status, "previewUrl": record.preview_url}


@router.post("/{run_id}/runtime/stop")
def stop_runtime(
    run_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    _owned_or_404(db, run_id, user)
    runtime_service.stop_runtime(SqlRuntimeRepo(db), run_id=run_id, now=now_ms())
    db.commit()
    return {"ok": True}