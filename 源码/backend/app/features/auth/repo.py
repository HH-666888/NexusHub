"""认证的数据访问：唯一写 users / sessions 的地方（目录契约的 D5）。

SQLAlchemy 对象不出这一层：对外返回 app.domain 里的模型。
"""

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.db.models import User as DbUser
from app.db.models import UserSession as DbSession
from app.domain.user import UserAccount
from app.features.auth.service import SessionRecord


class SqlAuthStore:
    """`AuthStore` 协议的实现。事务提交留给调用方 —— 注册要"用户 + 会话"一起成功。"""

    def __init__(self, db: Session) -> None:
        self._db = db

    def find_user_by_username(self, username: str) -> UserAccount | None:
        row = self._db.scalar(select(DbUser).where(DbUser.username == username))
        return _to_account(row) if row is not None else None

    def find_user_by_id(self, user_id: int) -> UserAccount | None:
        row = self._db.get(DbUser, user_id)
        return _to_account(row) if row is not None else None

    def insert_user(
        self, *, username: str, display_name: str, password_hash: str, now: int
    ) -> UserAccount:
        row = DbUser(
            username=username,
            display_name=display_name,
            password_hash=password_hash,
            created_at=now,
            updated_at=now,
        )
        self._db.add(row)
        # flush 才能拿到自增 id
        self._db.flush()
        return _to_account(row)

    def insert_session(self, session: SessionRecord) -> None:
        self._db.add(
            DbSession(
                id=session.id,
                user_id=session.user_id,
                expires_at=session.expires_at,
                created_at=session.created_at,
            )
        )
        self._db.flush()

    def find_session(self, session_id: str) -> SessionRecord | None:
        row = self._db.get(DbSession, session_id)
        if row is None:
            return None
        return SessionRecord(
            id=row.id,
            user_id=row.user_id,
            expires_at=row.expires_at,
            created_at=row.created_at,
        )

    def delete_session(self, session_id: str) -> None:
        self._db.execute(delete(DbSession).where(DbSession.id == session_id))

    def delete_expired_sessions(self, now: int) -> int:
        result = self._db.execute(delete(DbSession).where(DbSession.expires_at <= now))
        return result.rowcount or 0


def _to_account(row: DbUser) -> UserAccount:
    return UserAccount(
        id=row.id,
        username=row.username,
        display_name=row.display_name,
        password_hash=row.password_hash,
        created_at=row.created_at,
    )
