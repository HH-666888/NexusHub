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
    data = {row.key: row.value for row in rows}
    # Key 只告诉前端"配没配"，绝不回显
    if "apiKey" in data:
        data.pop("apiKey")
        data["apiKeySet"] = True
    return data


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
    data = {row.key: row.value for row in rows}
    if "apiKey" in data:
        data.pop("apiKey")
        data["apiKeySet"] = True
    return data

@router.post("/test")
def test_connection(
    payload: dict = Body(default_factory=dict),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    """真的去探一下提供商，不通就说清楚，不假装成功。"""
    import urllib.request

    provider = str(payload.get("provider") or "deepseek")
    key = str(payload.get("apiKey") or "").strip()

    if not key:
        row = db.get(Setting, {"user_id": user.id, "key": "apiKey"})
        key = str((row.value if row else "") or "").strip()
    if not key:
        return {"ok": False, "message": "还没有填 API Key"}

    base = {
        "deepseek": "https://api.deepseek.com",
        "openai": "https://api.openai.com",
        "local": "http://127.0.0.1:11434",
    }.get(provider, "https://api.deepseek.com")

    try:
        request = urllib.request.Request(base, method="GET")
        with urllib.request.urlopen(request, timeout=4) as response:  # noqa: S310 - 固定域名
            return {"ok": True, "message": f"{provider} 可达（HTTP {response.status}）"}
    except Exception as error:  # noqa: BLE001 - 网络错误原样告诉用户
        return {"ok": False, "message": f"连不上 {base}：{error.__class__.__name__}"}