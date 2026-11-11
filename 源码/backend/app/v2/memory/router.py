"""AI 记忆页：按天展示 AI 自己记下的内容。"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import MemoryEntry
from app.deps import get_current_user, get_db
from app.domain.user import User
from app.v2.assist import memory_service

router = APIRouter()


@router.get("")
def list_memory(
    days: int = 30,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    limit = max(1, min(days, 180))
    rows = (
        db.execute(
            select(MemoryEntry)
            .where(MemoryEntry.user_id == user.id)
            .order_by(MemoryEntry.pinned.desc(), MemoryEntry.created_at.desc())
            .limit(500)
        )
        .scalars()
        .all()
    )
    groups: dict[str, list[dict]] = {}
    for row in rows[: limit * 20]:
        groups.setdefault(row.day, []).append(
            {
                "id": row.id,
                "title": row.title,
                "body": row.body,
                "reason": row.reason,
                "sourceType": row.source_type,
                "sourceId": row.source_id,
                "confidence": row.confidence,
                "pinned": bool(row.pinned),
                "createdAt": row.created_at,
            }
        )
    ordered = [{"day": day, "entries": groups[day]} for day in sorted(groups, reverse=True)]
    return {"stats": memory_service.stats(db, user.id), "groups": ordered, "days": limit}


@router.get("/stats")
def memory_stats(user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    return memory_service.stats(db, user.id)


@router.patch("/{entry_id}")
def update_memory(
    entry_id: int,
    payload: dict,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    row = db.get(MemoryEntry, entry_id)
    if row is None or row.user_id != user.id:
        raise HTTPException(status_code=404, detail="memory not found")
    if "pinned" in payload:
        row.pinned = 1 if payload["pinned"] else 0
    db.commit()
    return {"ok": True, "pinned": bool(row.pinned)}


@router.delete("/{entry_id}")
def delete_memory(
    entry_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    row = db.get(MemoryEntry, entry_id)
    if row is None or row.user_id != user.id:
        raise HTTPException(status_code=404, detail="memory not found")
    db.delete(row)
    db.commit()
    return {"ok": True}


@router.delete("")
def clear_memory(user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    memory_service.clear(db, user.id)
    return {"ok": True}