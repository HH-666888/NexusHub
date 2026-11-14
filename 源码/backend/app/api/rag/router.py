"""RAG 索引与检索接口。"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.ai.rag import retrieve as retrieve_module
from app.ai.rag import store
from app.db.session import SessionLocal
from app.deps import get_current_user, get_db
from app.domain.user import User

router = APIRouter()


@router.post("/reindex")
def reindex(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    return store.sync(db)


@router.get("/search")
def search(
    q: str = Query("", max_length=300),
    top_k: int = Query(4, ge=1, le=10),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    hits = retrieve_module.retrieve(db, q, top_k)
    return {"query": q, "hits": hits}