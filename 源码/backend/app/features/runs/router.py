"""运行路由。

- GET  /runs                  当前用户的运行列表
- POST /runs                  建运行（落一行 running 记录）
- GET  /runs/{run_id}         运行详情
- GET  /runs/{run_id}/events  事件流（按 seq 升序）
- GET  /runs/{run_id}/artifacts 产物清单（不含正文）
"""

from fastapi import APIRouter, Depends, HTTPException, Query
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
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    run = service.create(db, user_id=user.id, prompt=payload.prompt)
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