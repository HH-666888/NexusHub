"""Skill 只读接口。"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from app.api.skills import software
from app.deps import get_current_user
from app.domain.user import User

router = APIRouter()


@router.get("")
def list_skills(user: User = Depends(get_current_user)) -> dict:
    return {"skills": software.list_skills()}


@router.get("/{stage}")
def stage_skill(stage: str, user: User = Depends(get_current_user)) -> dict:
    if stage not in software.STAGE_FILES:
        raise HTTPException(status_code=404, detail="没有这个工序的 Skill")
    return {
        "stage": stage,
        "skill": software.info(),
        "block": software.block(stage),
    }