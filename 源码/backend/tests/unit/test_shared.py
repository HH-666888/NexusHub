"""共享内核的单测：这些是契约里的字面规定，写错就是两端对不上。"""

import base64
import json

import pytest

from app.shared import ids, pagination, sse
from app.shared.errors import AppError, not_found


def test_run_id_is_26_hex_chars() -> None:
    run_id = ids.new_run_id()
    assert len(run_id) == 26
    assert all(c in "0123456789abcdef" for c in run_id)


def test_session_token_hash_is_sha256_hex() -> None:
    token = ids.new_session_token()
    digest = ids.hash_token(token)

    assert len(digest) == 64
    assert digest == ids.hash_token(token)  # 同 token 必然同哈希
    assert digest != token


def test_cursor_roundtrip_and_ordering() -> None:
    cursor = pagination.encode_cursor(1793520000000, "9f2c7a41b3e54d0f9a1c2b3d4e")

    # 不含填充符，避免 URL 里出现 %3D
    assert "=" not in cursor
    assert base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4))

    created_at, item_id = pagination.decode_cursor(cursor)
    assert created_at == 1793520000000
    assert item_id == "9f2c7a41b3e54d0f9a1c2b3d4e"


def test_broken_cursor_raises_400() -> None:
    with pytest.raises(AppError) as excinfo:
        pagination.decode_cursor("这不是游标")
    assert excinfo.value.code == "BAD_REQUEST"
    assert excinfo.value.status == 400


@pytest.mark.parametrize(
    ("raw", "expected"),
    [(None, 20), (0, 20), (-5, 20), (10, 10), (500, 50)],
)
def test_limit_is_clamped(raw: int | None, expected: int) -> None:
    assert pagination.normalize_limit(raw) == expected


def test_sse_frame_is_single_data_line_with_compact_json() -> None:
    frame = sse.format_event({"kind": "text", "delta": "你好"})

    assert frame.startswith("data: ")
    assert frame.endswith("\n\n")
    assert frame.count("\n\n") == 1
    payload = json.loads(frame[len("data: ") : -2])
    assert payload == {"kind": "text", "delta": "你好"}
    # 中文不转义，人眼可读
    assert "你好" in frame


def test_error_body_shape() -> None:
    body = not_found().to_body()

    assert body == {"error": {"code": "NOT_FOUND", "message": "找不到该构建"}}


def test_error_hint_is_optional() -> None:
    without_hint = AppError("CONFLICT", "状态不允许").to_body()
    with_hint = AppError("CONFLICT", "状态不允许", hint="先提交回答").to_body()

    assert "hint" not in without_hint["error"]
    assert with_hint["error"]["hint"] == "先提交回答"
