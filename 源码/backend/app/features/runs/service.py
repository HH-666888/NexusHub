"""运行业务：建、查。

不碰 SQL（repo 负责），不碰 HTTP（router 负责）。
当前是最小可用版：只负责落一行 running 的运行记录；
真正的六道工序由 pipeline 驱动，这里不重复实现。
"""

from __future__ import annotations

from sqlalchemy.orm import Session

from app.features.runs import repo
from app.shared.ids import new_run_id
from app.shared.time import now_ms


def create(db: Session, *, user_id: int, prompt: str):
    """建一条运行记录，状态 running、停在第 1 道。"""
    run = repo.create_run(
        db,
        run_id=new_run_id(),
        user_id=user_id,
        prompt=prompt.strip(),
        now=now_ms(),
    )
    db.commit()
    return run


def list_for_user(db: Session, *, user_id: int, limit: int = 50):
    return repo.list_runs(db, user_id=user_id, limit=limit)


def get(db: Session, *, run_id: str, user_id: int):
    return repo.get_run(db, run_id=run_id, user_id=user_id)


def events(db: Session, *, run_id: str):
    return repo.list_events(db, run_id=run_id)


def artifacts(db: Session, *, run_id: str):
    return repo.list_artifacts(db, run_id=run_id)

def set_status(db: Session, *, run_id: str, status: str) -> None:
    run = db.get(__import__("app.db.models", fromlist=["Run"]).Run, run_id)
    if run is None:
        return
    run.status = status
    db.commit()