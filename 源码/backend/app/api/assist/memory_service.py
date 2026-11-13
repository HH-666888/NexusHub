"""AI 记忆：读取、注入片段、从阶段推进里自主沉淀。"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db.models import AssistFile, AssistFinding, AssistProject, MemoryEntry
from app.shared.time import now_ms
from app.api.ai.factory import build_client, model_for

BEIJING = timezone(timedelta(hours=8))
CONFIDENCE = {"single", "repeat", "confirmed"}


def today() -> str:
    return datetime.now(BEIJING).strftime("%Y-%m-%d")


def recent(db: Session, user_id: int, limit: int = 5) -> list[MemoryEntry]:
    return (
        db.execute(
            select(MemoryEntry)
            .where(MemoryEntry.user_id == user_id)
            .order_by(MemoryEntry.pinned.desc(), MemoryEntry.created_at.desc())
            .limit(limit)
        )
        .scalars()
        .all()
    )


def prompt_block(db: Session, user_id: int) -> tuple[str, list[dict]]:
    """返回注入提示词的文本与可展示的引用列表。没有记忆时返回空。"""
    entries = recent(db, user_id)
    if not entries:
        return "", []
    lines = ["关于这位用户的历史记忆（只作默认值参考，不得放宽验收标准）："]
    citations = []
    for entry in entries:
        lines.append(f"- {entry.body}")
        citations.append({"id": entry.id, "title": entry.title, "body": entry.body})
    return "\n".join(lines), citations


def count_today(db: Session, user_id: int) -> int:
    return int(
        db.execute(
            select(func.count(MemoryEntry.id)).where(
                MemoryEntry.user_id == user_id, MemoryEntry.day == today()
            )
        ).scalar()
        or 0
    )


def record_from_stage(db: Session, project: AssistProject, stage: str) -> None:
    """阶段推进时，让 AI 自主判断要不要记一条。失败静默，不影响主流程。"""
    limit = int(get_settings().memory_daily_limit or 3)
    if limit <= 0 or count_today(db, project.user_id) >= limit:
        return

    files = db.execute(select(AssistFile).where(AssistFile.project_id == project.id)).scalars().all()
    findings = db.execute(
        select(AssistFinding)
        .where(AssistFinding.project_id == project.id, AssistFinding.status == "open")
        .limit(8)
    ).scalars().all()
    context = {
        "project": project.title,
        "goal": (project.goal or "")[:300],
        "stage": stage,
        "files": [item.path for item in files][:12],
        "findings": [f"{item.rule}: {item.message}" for item in findings][:8],
    }

    system = """你在维护一份长期记忆。根据这次开发阶段的信息，判断有没有值得长期记住的、
关于这位用户的事实（偏好、决策、习惯、反复出现的问题）。

规则：
- 最多输出 1 条；没有值得记的就返回 null。
- 不要记敏感信息（密钥、密码、完整代码）。
- 只输出 JSON：{"remember": true/false, "title": "≤20字", "body": "≤80字", "reason": "为什么记", "confidence": "single/repeat/confirmed"}
"""
    try:
        client = build_client("plan")
        try:
            reply = client.complete(
                [
                    {"role": "system", "content": system},
                    {"role": "user", "content": json.dumps(context, ensure_ascii=False)},
                ],
                model_for("plan"),
                max_tokens=300,
                temperature=0.2,
                json_mode=True,
            )
        finally:
            client.close()
        data = json.loads(reply.content)
    except Exception:  # noqa: BLE001
        return

    if not data.get("remember"):
        return
    title = str(data.get("title") or "").strip()[:120]
    body = str(data.get("body") or "").strip()[:500]
    if not title or not body:
        return
    confidence = str(data.get("confidence") or "single")
    if confidence not in CONFIDENCE:
        confidence = "single"
    db.add(
        MemoryEntry(
            user_id=project.user_id,
            day=today(),
            title=title,
            body=body,
            reason=str(data.get("reason") or "")[:255],
            source_type="assist",
            source_id=project.id,
            confidence=confidence,
            pinned=0,
            created_at=now_ms(),
        )
    )
    db.commit()


def stats(db: Session, user_id: int) -> dict:
    total = int(db.execute(select(func.count(MemoryEntry.id)).where(MemoryEntry.user_id == user_id)).scalar() or 0)
    today_count = count_today(db, user_id)
    week_ago = (datetime.now(BEIJING) - timedelta(days=7)).strftime("%Y-%m-%d")
    week = int(
        db.execute(
            select(func.count(MemoryEntry.id)).where(
                MemoryEntry.user_id == user_id, MemoryEntry.day >= week_ago
            )
        ).scalar()
        or 0
    )
    last = db.execute(
        select(MemoryEntry.created_at)
        .where(MemoryEntry.user_id == user_id)
        .order_by(MemoryEntry.created_at.desc())
        .limit(1)
    ).scalar()
    return {
        "total": total,
        "today": today_count,
        "dailyLimit": int(get_settings().memory_daily_limit or 3),
        "week": week,
        "lastAt": last,
    }


def clear(db: Session, user_id: int) -> None:
    db.execute(delete(MemoryEntry).where(MemoryEntry.user_id == user_id))
    db.commit()