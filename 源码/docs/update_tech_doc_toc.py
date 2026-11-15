# -*- coding: utf-8 -*-
"""从导出的 PDF 书签读取页码，回填 DOCX 目录。"""

from __future__ import annotations

import re
from pathlib import Path

from docx import Document

DOCS = Path(__file__).parent
DOCX = DOCS / "NexusHub-技术文档.docx"
PDF = DOCS / "NexusHub-技术文档.pdf"


def _normalize(text: str) -> str:
    return re.sub(r"\s+", "", (text or "").replace("\ufeff", ""))


def _objects(data: bytes):
    objects = {}
    for match in re.finditer(rb"(\d+)\s+0\s+obj\s*(.*?)\s*endobj", data, re.S):
        objects[int(match.group(1))] = match.group(2)
    return objects


def _page_order(objects) -> list[int]:
    # Prefer the page tree, fall back to page object numeric order.
    roots = []
    for num, body in objects.items():
        if re.search(rb"/Type\s*/Pages\b", body):
            kids = re.search(rb"/Kids\s*\[(.*?)\]", body, re.S)
            if kids:
                refs = [int(x) for x in re.findall(rb"(\d+)\s+0\s+R", kids.group(1))]
                if refs:
                    roots.append(refs)

    def expand(refs):
        out = []
        for ref in refs:
            body = objects.get(ref, b"")
            if re.search(rb"/Type\s*/Pages\b", body):
                kids = re.search(rb"/Kids\s*\[(.*?)\]", body, re.S)
                if kids:
                    out.extend(expand([int(x) for x in re.findall(rb"(\d+)\s+0\s+R", kids.group(1))]))
            elif re.search(rb"/Type\s*/Page\b", body):
                out.append(ref)
        return out

    for candidate in sorted(roots, key=len, reverse=True):
        pages = expand(candidate)
        if pages:
            return pages
    return sorted(
        num for num, body in objects.items() if re.search(rb"/Type\s*/Page\b", body)
    )


def _decode_title(hex_text: bytes) -> str:
    raw = bytes.fromhex(hex_text.decode("ascii"))
    return raw.decode("utf-16-be", errors="replace")


def outline_pages(pdf: Path) -> dict[str, int]:
    data = pdf.read_bytes()
    objects = _objects(data)
    order = _page_order(objects)
    index = {obj: i + 1 for i, obj in enumerate(order)}

    # Collect outline items in document order from the raw PDF.
    entries = []
    for match in re.finditer(
        rb"/Title\s*<([0-9A-Fa-f]+)>\s*(?:/Dest\s*\[\s*(\d+)\s+0\s+R|/A\s*<<[^>]*?/D\s*\[\s*(\d+)\s+0\s+R)",
        data,
        re.S,
    ):
        title = _decode_title(match.group(1))
        page_obj = int(match.group(2) or match.group(3))
        entries.append((title, index.get(page_obj)))
    return {_normalize(title): page for title, page in entries if page}


def update() -> None:
    pages = outline_pages(PDF)
    doc = Document(DOCX)
    changed = 0
    missing = []
    for para in doc.paragraphs:
        if not para.runs or not para.runs[-1].text.strip().isdigit():
            continue
        title = re.sub(r"\d+$", "", para.text).strip()
        page = pages.get(_normalize(title))
        if page is None:
            missing.append(title)
            continue
        # The page number is the last run, created separately in the TOC builder.
        if para.runs:
            para.runs[-1].text = "\t" + str(page)
            changed += 1
    doc.save(DOCX)
    print(f"updated={changed} missing={len(missing)}")
    for title in missing:
        print("MISSING", title)


if __name__ == "__main__":
    update()