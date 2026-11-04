"""运行的数据访问。

对外返回 domain 模型；ORM 对象不许离开这一层。
目前只覆盖原型需要的最小集合：建运行、列表、详情、事件、产物。
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import Artifact, Run, RunEvent


def create_run(
    db: Session,
    *,
    run_id: str,
    user_id: int,
    prompt: str,
    now: int,
) -> Run:
    run = Run(
        id=run_id,
        user_id=user_id,
        prompt=prompt,
        stage="spec",
        status="running",
        workflow_version="v1",
        total_cost_cny=0,
        created_at=now,
        updated_at=now,
    )
    db.add(run)
    db.flush()
    return run


def list_runs(db: Session, *, user_id: int, limit: int = 50) -> list[Run]:
    stmt = (
        select(Run)
        .where(Run.user_id == user_id)
        .order_by(Run.created_at.desc(), Run.id.desc())
        .limit(max(1, min(limit, 100)))
    )
    return list(db.execute(stmt).scalars())


def get_run(db: Session, *, run_id: str, user_id: int) -> Run | None:
    stmt = select(Run).where(Run.id == run_id, Run.user_id == user_id)
    return db.execute(stmt).scalar_one_or_none()


def list_events(db: Session, *, run_id: str) -> list[RunEvent]:
    stmt = select(RunEvent).where(RunEvent.run_id == run_id).order_by(RunEvent.seq.asc())
    return list(db.execute(stmt).scalars())


def list_artifacts(db: Session, *, run_id: str) -> list[Artifact]:
    stmt = (
        select(Artifact)
        .where(Artifact.run_id == run_id)
        .order_by(Artifact.created_at.asc(), Artifact.name.asc())
    )
    return list(db.execute(stmt).scalars())


def get_artifact(db: Session, *, run_id: str, name: str) -> Artifact | None:
    stmt = select(Artifact).where(Artifact.run_id == run_id, Artifact.name == name)
    return db.execute(stmt).scalar_one_or_none()