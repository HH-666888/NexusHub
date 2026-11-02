"""会话 cookie（契约书 §4.1）。

cookie 里只有不透明 token；用户信息一律走 `/auth/me`。
`secure` 由配置决定：本地 http 打开 Secure 的话，浏览器根本不会回传 cookie，
表现是"登录成功但立刻又是未登录"，很难查。
"""

from fastapi import Response

from app.domain.user import SESSION_TTL_MS

SESSION_COOKIE = "nexus_session"
SESSION_MAX_AGE_SECONDS = SESSION_TTL_MS // 1000


def set_session_cookie(response: Response, token: str, *, secure: bool) -> None:
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=SESSION_MAX_AGE_SECONDS,
        path="/",
        httponly=True,
        samesite="lax",
        secure=secure,
    )


def clear_session_cookie(response: Response, *, secure: bool) -> None:
    response.delete_cookie(
        SESSION_COOKIE,
        path="/",
        httponly=True,
        samesite="lax",
        secure=secure,
    )
