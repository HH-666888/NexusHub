"""请求级依赖。

这里只放"怎么拿到东西"，不放业务。业务判断在 features/*/service.py。
"""

from collections.abc import Iterator

from sqlalchemy.orm import Session

from app.db.session import SessionLocal


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
