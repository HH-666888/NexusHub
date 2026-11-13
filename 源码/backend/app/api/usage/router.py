"""今日用量汇总：工作流记账 + 辅助开发记账。"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db.models import Run, UsageRecord
from app.deps import get_current_user, get_db
from app.domain.user import User

router = APIRouter()
BEIJING = timezone(timedelta(hours=8))


@router.get("/today")
def today_usage(user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    start = int(datetime.now(BEIJING).replace(hour=0, minute=0, second=0, microsecond=0).timestamp() * 1000)

    workflow = db.execute(
        select(func.coalesce(func.sum(Run.total_cost_cny), 0)).where(
            Run.user_id == user.id, Run.created_at >= start
        )
    ).scalar()
    assist = db.execute(
        select(func.coalesce(func.sum(UsageRecord.cost_cny), 0)).where(
            UsageRecord.user_id == user.id, UsageRecord.created_at >= start
        )
    ).scalar()

    workflow_cny = round(float(workflow or 0), 6)
    assist_cny = round(float(assist or 0), 6)
    return {
        "workflowCny": workflow_cny,
        "assistCny": assist_cny,
        "totalCny": round(workflow_cny + assist_cny, 6),
        "estimated": True,
    }
