"""游标分页（契约书 §4.8）。

游标是位置而不是偏移：翻页期间新增记录不会造成重复或漏项。
内容为 `base64("${createdAt}:${id}")`，与索引 `(user_id, created_at DESC, id DESC)` 对齐。
"""

import base64
import binascii

from app.shared.errors import bad_request

DEFAULT_LIMIT = 20
MAX_LIMIT = 50


def encode_cursor(created_at: int, item_id: str) -> str:
    raw = f"{created_at}:{item_id}".encode()
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def decode_cursor(cursor: str) -> tuple[int, str]:
    padding = "=" * (-len(cursor) % 4)
    try:
        raw = base64.urlsafe_b64decode(cursor + padding).decode("utf-8")
        created_at_text, item_id = raw.split(":", 1)
        return int(created_at_text), item_id
    except (ValueError, binascii.Error) as exc:
        raise bad_request("分页游标无效", "请从头开始翻页") from exc


def normalize_limit(limit: int | None) -> int:
    if limit is None:
        return DEFAULT_LIMIT
    if limit <= 0:
        return DEFAULT_LIMIT
    return min(limit, MAX_LIMIT)
