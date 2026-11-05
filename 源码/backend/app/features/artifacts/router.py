"""产物路由（契约书 §5.4）。

- GET    /runs/{run_id}/artifact            直接进 iframe
- GET    /runs/{run_id}/artifact/download   带 Content-Disposition
- DELETE /runs/{run_id}/artifacts           清空重跑

产物正文存在 `artifacts.content`（LONGTEXT），不放进事件里。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response
from fastapi.responses import HTMLResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import Artifact, Run
from app.deps import get_current_user, get_db
from app.domain.user import User

router = APIRouter(prefix="/runs", tags=["artifacts"])


def _owned(db: Session, run_id: str, user: User) -> Run:
    run = db.get(Run, run_id)
    if run is None or run.user_id != user.id:
        raise HTTPException(status_code=404, detail="run not found")
    return run


def _latest_html(db: Session, run_id: str) -> Artifact:
    stmt = (
        select(Artifact)
        .where(Artifact.run_id == run_id, Artifact.kind == "html")
        .order_by(Artifact.created_at.desc())
        .limit(1)
    )
    row = db.execute(stmt).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="还没有可预览的产物")
    return row


@router.get("/{run_id}/artifact")
def get_artifact(
    run_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Response:
    _owned(db, run_id, user)
    artifact = _latest_html(db, run_id)
    return HTMLResponse(
        content=artifact.content,
        headers={
            # 产物是模型写的，允许内联样式与脚本，但不许外连
            "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:",
            "Cache-Control": "no-store",
        },
    )


@router.get("/{run_id}/artifact/download")
def download_artifact(
    run_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Response:
    _owned(db, run_id, user)
    artifact = _latest_html(db, run_id)
    filename = f"nexus-{run_id[:8]}.html"
    return Response(
        content=artifact.content,
        media_type="text/html; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.delete("/{run_id}/artifacts")
def clear_artifacts(
    run_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    """清空产物，让下一次生成从头跑。"""
    _owned(db, run_id, user)
    for row in db.execute(select(Artifact).where(Artifact.run_id == run_id)).scalars():
        db.delete(row)
    db.commit()
    return {"ok": True}