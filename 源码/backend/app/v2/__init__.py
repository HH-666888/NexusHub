"""v2 路由汇总。

v2 与 v1 并存：旧站 `/`、旧接口 `/api/v1` 一行不动；
新站 `/v2`、新接口 `/api/v2` 从 0 写。

约定：
- 新代码只放在 `app/v2/` 下
- 复用 `app.domain` / `app.db` / `app.config` / `app.features.auth`
- 不允许返回任何示例数据（见 docs/10-重构/20-内容真实性红线.md）
"""

from __future__ import annotations

from fastapi import APIRouter

from app.features.auth.router import router as auth_router
from app.features.settings.router import router as settings_router
from app.v2.runs.router import router as runs_router
from app.v2.gate.router import router as gate_router

router = APIRouter()
# v2 复用同一套处理器，但路径全部走 /api/v2，不再依赖 /api/v1
router.include_router(auth_router, tags=["v2-auth"])
router.include_router(settings_router, tags=["v2-settings"])
router.include_router(runs_router, prefix="/runs", tags=["v2-runs"])
router.include_router(gate_router, prefix="/runs", tags=["v2-gate"])


@router.get("/health", tags=["v2"])
def health() -> dict:
    """v2 自己的健康检查：只报告事实，不做假数据。"""
    return {"ok": True, "version": "2.0.0", "pipeline": "real"}