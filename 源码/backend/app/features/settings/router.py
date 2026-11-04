"""设置路由（契约书 §5.5）。

设置按 (user_id, key) 存，值是任意 JSON —— 前端只关心"一份可读写的配置"。
GET 返回合并后的对象，PUT 按 key 覆盖。
"""

from fastapi import APIRouter, Body, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import Setting
from app.deps import get_current_user, get_db
from app.domain.user import User
from app.shared.time import now_ms

router = APIRouter(prefix="/settings", tags=["settings"])


@router.get("")
def read_settings(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    rows = db.execute(select(Setting).where(Setting.user_id == user.id)).scalars()
    return {row.key: row.value for row in rows}


@router.put("")
def write_settings(
    payload: dict = Body(default_factory=dict),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    now = now_ms()
    for key, value in payload.items():
        row = db.get(Setting, {"user_id": user.id, "key": key})
        if row is None:
            db.add(Setting(user_id=user.id, key=key, value=value, updated_at=now))
        else:
            row.value = value
            row.updated_at = now
    db.commit()
    rows = db.execute(select(Setting).where(Setting.user_id == user.id)).scalars()
    return {row.key: row.value for row in rows}