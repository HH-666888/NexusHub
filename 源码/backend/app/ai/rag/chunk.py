"""按 Markdown 标题切片：512 字 / 重叠 64，保留章节名。"""

from __future__ import annotations

import re


def chunk_markdown(text: str, size: int = 512, overlap: int = 64) -> list[dict]:
    text = (text or "").replace("\r\n", "\n").strip()
    if not text:
        return []

    title = ""
    match = re.search(r"(?m)^#\s+(.+)$", text)
    if match:
        title = match.group(1).strip()

    parts = re.split(r"(?m)^##\s+", text)
    sections: list[tuple[str, str]] = []
    for index, part in enumerate(parts):
        if index == 0:
            body = re.sub(r"(?m)^#\s+.+$", "", part).strip()
            sections.append((title or "正文", body))
            continue
        lines = part.split("\n", 1)
        heading = lines[0].strip()
        body = lines[1].strip() if len(lines) > 1 else ""
        sections.append((heading or "正文", body))

    result: list[dict] = []
    for heading, body in sections:
        body = body.strip()
        if not body:
            continue
        start = 0
        while start < len(body):
            end = min(len(body), start + size)
            piece = body[start:end].strip()
            if piece:
                result.append({"heading": heading, "text": piece})
            if end >= len(body):
                break
            start = max(end - overlap, start + 1)
    return result
