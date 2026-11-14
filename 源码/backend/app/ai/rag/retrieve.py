"""混合检索：本地向量余弦 + 字符 n-gram 词面匹配。"""

from __future__ import annotations

import re
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.ai.rag.embed import cosine, unpack, vector
from app.ai.rag.store import ensure_index
from app.db.models import RagChunk, RagDocument


def _bi_grams(text: str) -> set[str]:
    cleaned = re.sub(r"\s+", "", (text or "").lower())
    return {cleaned[i : i + 2] for i in range(max(0, len(cleaned) - 1))}


def retrieve(db: Session, query: str, top_k: int = 4) -> list[dict]:
    query = (query or "").strip()
    if not query:
        return []
    ensure_index(db)
    rows = db.execute(
        select(RagChunk, RagDocument).join(RagDocument, RagDocument.id == RagChunk.document_id)
    ).all()
    if not rows:
        return []

    qvec = vector(query)
    qgrams = _bi_grams(query)
    hits: list[dict] = []
    for chunk, doc in rows:
        similarity = cosine(qvec, unpack(chunk.embedding))
        chunk_grams = _bi_grams(chunk.text + " " + (chunk.heading or ""))
        lexical = len(qgrams & chunk_grams) / max(1, len(qgrams))
        score = 0.65 * similarity + 0.35 * lexical
        if score <= 0.01:
            continue
        heading = chunk.heading or "正文"
        hits.append(
            {
                "source": f"{doc.path.removesuffix('.md')} §{heading}",
                "snippet": re.sub(r"\s+", " ", chunk.text)[:280],
                "score": round(score, 4),
            }
        )

    hits.sort(key=lambda item: item["score"], reverse=True)
    return hits[:top_k]


def prompt_block(hits: list[dict]) -> str:
    if not hits:
        return ""
    lines = ["参考依据（只作判断参考，不要照抄）："]
    for index, hit in enumerate(hits, 1):
        lines.append(f"{index}. {hit['source']}：{hit['snippet'][:220]}")
    return "\n".join(lines)
