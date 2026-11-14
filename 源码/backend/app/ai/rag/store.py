"""语料入库：按 sha256 只重建变过的文档。"""

from __future__ import annotations

import hashlib
from pathlib import Path

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.ai.rag.chunk import chunk_markdown
from app.ai.rag.embed import DIM, MODEL, pack
from app.config import get_settings
from app.db.models import RagChunk, RagDocument
from app.shared.time import now_ms


def playbook_root() -> Path:
    base = Path(__file__).resolve().parents[3]
    return base / get_settings().playbook_dir


def sync(db: Session, root: Path | None = None) -> dict:
    root = root or playbook_root()
    root.mkdir(parents=True, exist_ok=True)
    files = [path for path in sorted(root.glob("*.md")) if path.name.lower() != "readme.md"]
    existing = {item.path: item for item in db.execute(select(RagDocument)).scalars().all()}
    kept: set[str] = set()
    added_chunks = 0

    for path in files:
        relative = path.name
        raw = path.read_text(encoding="utf-8")
        digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()
        kept.add(relative)
        doc = existing.get(relative)
        if doc is not None and doc.sha256 == digest:
            continue
        title = next((line[2:].strip() for line in raw.splitlines() if line.startswith("# ")), relative)
        if doc is None:
            doc = RagDocument(path=relative, title=title, sha256=digest, bytes=len(raw.encode("utf-8")), updated_at=now_ms())
            db.add(doc)
            db.flush()
        else:
            doc.title = title
            doc.sha256 = digest
            doc.bytes = len(raw.encode("utf-8"))
            doc.updated_at = now_ms()
            db.execute(delete(RagChunk).where(RagChunk.document_id == doc.id))

        for index, piece in enumerate(chunk_markdown(raw)):
            db.add(
                RagChunk(
                    document_id=doc.id,
                    chunk_index=index,
                    heading=piece["heading"],
                    text=piece["text"],
                    embedding=pack(piece["heading"] + "\n" + piece["text"]),
                    dim=DIM,
                    model=MODEL,
                )
            )
            added_chunks += 1

    for relative, doc in existing.items():
        if relative not in kept:
            db.delete(doc)

    db.commit()
    total_chunks = db.execute(select(RagChunk)).scalars().all()
    return {"documents": len(files), "chunks": len(total_chunks), "rebuiltChunks": added_chunks}


def ensure_index(db: Session) -> None:
    count = db.execute(select(RagChunk.id).limit(1)).first()
    if count is None:
        sync(db)
