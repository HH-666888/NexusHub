"""接口路由汇总：挂在 `/api` 下，与前端同源。

约定：
- 业务接口只放在 `app/api/`
- 复用 `app.domain` / `app.db` / `app.config` / `app.features.auth`
- 不允许返回任何示例数据（见 docs/10-重构/20-内容真实性红线.md）
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.features.auth.router import router as auth_router
from app.features.settings.router import router as settings_router
from app.deps import get_db
from app.domain.health import HealthStatus
from app.shared.health import build_health
from app.api.assist.router import router as assist_router
from app.api.memory.router import router as memory_router
from app.api.usage.router import router as usage_router
from app.api.rag.router import router as rag_router
from app.api.skills.router import router as skills_router
from app.api.runs.router import router as runs_router
from app.api.gate.router import router as gate_router

router = APIRouter()
# 认证与设置复用同一套处理器，路径统一走 /api
router.include_router(auth_router, tags=["auth"])
router.include_router(settings_router, tags=["settings"])
router.include_router(runs_router, prefix="/runs", tags=["runs"])
router.include_router(gate_router, prefix="/runs", tags=["gate"])
router.include_router(assist_router, prefix="/assist", tags=["assist"])
router.include_router(memory_router, prefix="/memory", tags=["memory"])
router.include_router(usage_router, prefix="/usage", tags=["usage"])
router.include_router(rag_router, prefix="/rag", tags=["rag"])
router.include_router(skills_router, prefix="/skills", tags=["skills"])


@router.get("/health", tags=["health"], response_model=HealthStatus)
def health(db: Session = Depends(get_db)) -> HealthStatus:
    """健康检查：只报告事实，数据库连不上时返回 db=down。"""
    return build_health(db)