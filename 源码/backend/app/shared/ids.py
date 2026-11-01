"""标识符生成。

运行 id 是 26 位小写十六进制（13 字节随机）。26 位刚好装进 `runs.id VARCHAR(26)`，
也足够短，界面上截前 8 位显示不会重复。
"""

import hashlib
import secrets

RUN_ID_BYTES = 13  # → 26 个十六进制字符
SESSION_TOKEN_BYTES = 32  # → 64 个十六进制字符的 token


def new_run_id() -> str:
    return secrets.token_hex(RUN_ID_BYTES)


def new_session_token() -> str:
    """给浏览器的原始 token。只出现在 cookie 里，不落库。"""
    return secrets.token_hex(SESSION_TOKEN_BYTES)


def hash_token(token: str) -> str:
    """落库的是它的 sha256（契约 §3.2）：库被读走也拿不到可用会话。"""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()
