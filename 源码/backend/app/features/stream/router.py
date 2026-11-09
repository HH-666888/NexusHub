"""SSE 路由（契约书 §6）。

- GET /runs/{run_id}/stream

实现方式：**轮询数据库**。每 300ms 查一次 `run_events` 里 seq 之后的新行，
有新事件就推，没有就攒着，15 秒发一次心跳。好处是刷新/重连/多进程都不会丢事件，
坏处是首帧最多慢 300ms —— 演示够用。

暂停时不关连接：run 状态是 paused 就继续轮询，恢复后自然接上。
"""

from __future__ import annotations

import time
from collections.abc import Iterator

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import select

from app.db.models import Run, RunEvent
from app.db.session import SessionLocal
from app.deps import get_current_user
from app.domain.user import User
from app.shared.sse import HEARTBEAT_FRAME, HEARTBEAT_SECONDS, SSE_HEADERS, format_event

router = APIRouter(prefix="/runs", tags=["stream"])

POLL_SECONDS = 0.3
TERMINAL = {"done", "failed", "cancelled"}


@router.get("/{run_id}/stream")
def stream(run_id: str, request: Request, user: User = Depends(get_current_user)):
    db = SessionLocal()
    try:
        run = db.get(Run, run_id)
        if run is None or run.user_id != user.id:
            raise HTTPException(status_code=404, detail="run not found")
    finally:
        db.close()

    def frames() -> Iterator[str]:
        last_seq = 0
        idle = 0.0

        # 注意：这里不能调 request.is_disconnected()（它是 async）。
        # 客户端断开时 Starlette 会 close 生成器，GeneratorExit 自然让循环退出。
        while True:
            db = SessionLocal()
            try:
                rows = (
                    db.execute(
                        select(RunEvent)
                        .where(RunEvent.run_id == run_id, RunEvent.seq > last_seq)
                        .order_by(RunEvent.seq.asc())
                    )
                    .scalars()
                    .all()
                )
                run = db.get(Run, run_id)
                status = run.status if run else "cancelled"
            finally:
                db.close()

            if rows:
                idle = 0.0
                for row in rows:
                    last_seq = row.seq
                    # 带上序号与落库时间：前端用 seq 去重，用 at 还原真实节奏
                    yield format_event({**row.payload, "seq": row.seq, "at": row.created_at})
            else:
                idle += POLL_SECONDS
                if idle >= HEARTBEAT_SECONDS:
                    idle = 0.0
                    yield HEARTBEAT_FRAME

            # 结束且没有新事件：收尾断开
            if not rows and status in TERMINAL:
                break

            time.sleep(POLL_SECONDS)

    return StreamingResponse(frames(), headers=SSE_HEADERS)