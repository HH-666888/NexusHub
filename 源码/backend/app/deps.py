"""请求级依赖。

这里只放"怎么拿到东西"，不放业务。业务判断在 features/*/service.py。
"""

from collections.abc import Iterator

from fastapi import Depends, Request
from sqlalchemy.orm import Session

from app.db.session import SessionLocal
from app.domain.user import User
from app.features.auth import service as auth_service
from app.features.auth.repo import SqlAuthStore
from app.shared.cookies import SESSION_COOKIE
from app.shared.time import now_ms


def get_db() -> Iterator[Session]:
    """一个请求一个会话；异常时回滚，最后一定关闭。

    不做全局会话：SQLAlchemy 的 Session 不是线程安全的，也不能跨请求复用。
    """
    db = SessionLocal()
    try:
        yield db
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def get_auth_store(db: Session = Depends(get_db)) -> SqlAuthStore:
    return SqlAuthStore(db)


def get_current_user(
    request: Request,
    store: SqlAuthStore = Depends(get_auth_store),
) -> User:
    """从 cookie 取 token 并校验。失败直接 401（错误信封由全局处理器包装）。"""
    return auth_service.authenticate(
        store,
        token=request.cookies.get(SESSION_COOKIE),
        now=now_ms(),
    )
