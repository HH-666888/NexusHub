"""认证路由（契约书 §5.1）。

- POST /auth/register
- POST /auth/login
- POST /auth/logout
- GET  /auth/me

路由只做三件事：解析请求、调 service、决定 cookie 与状态码。
事务提交放在这里：service 不知道事务边界，repo 也只 flush。
"""

from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy.orm import Session

from app.config import get_settings
from app.deps import get_auth_store, get_current_user, get_db
from app.domain.user import User
from app.features.auth import service
from app.features.auth.schemas import LoginRequest, RegisterRequest, UserResponse
from app.shared.cookies import SESSION_COOKIE, clear_session_cookie, set_session_cookie
from app.shared.time import now_ms

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/register", status_code=201, response_model=UserResponse)
def register(
    payload: RegisterRequest,
    response: Response,
    db: Session = Depends(get_db),
) -> UserResponse:
    """注册即登录：直接下发会话 cookie，省掉一次多余的登录请求。"""
    store = get_auth_store(db)
    user, token = service.register(
        store,
        username=payload.username,
        password=payload.password,
        confirm_password=payload.confirm_password,
        now=now_ms(),
    )
    # 用户与会话在同一个事务里：要么都成功，要么都不留痕
    db.commit()
    set_session_cookie(response, token, secure=get_settings().cookie_secure)
    return UserResponse(user=user)


@router.post("/login", response_model=UserResponse)
def login(
    payload: LoginRequest,
    response: Response,
    db: Session = Depends(get_db),
) -> UserResponse:
    store = get_auth_store(db)
    user, token = service.login(
        store, username=payload.username, password=payload.password, now=now_ms()
    )
    db.commit()
    set_session_cookie(response, token, secure=get_settings().cookie_secure)
    return UserResponse(user=user)


@router.post("/logout", status_code=204)
def logout(request: Request, db: Session = Depends(get_db)) -> Response:
    """登出：删服务端会话 + 清 cookie。没登录也返回 204（幂等）。"""
    store = get_auth_store(db)
    service.logout(store, token=request.cookies.get(SESSION_COOKIE))
    db.commit()

    response = Response(status_code=204)
    clear_session_cookie(response, secure=get_settings().cookie_secure)
    return response


@router.get("/me", response_model=UserResponse)
def me(user: User = Depends(get_current_user)) -> UserResponse:
    return UserResponse(user=user)
