"""认证业务：注册、登录、登出、会话校验。

三层分工：router 解析请求，这里做业务，repo 碰数据库。本文件不 import SQLAlchemy、
也不 import FastAPI —— 所以它能在没有数据库的情况下被单测覆盖（见 tests/unit）。

密码用 argon2id；登录失败计数交给限流层，不在业务里自己数。
"""

from dataclasses import dataclass
from typing import Protocol

from app.domain.user import (
    SESSION_TTL_MS,
    FieldCheck,
    User,
    UserAccount,
    check_password_strength,
    check_username,
    normalize_username,
)
from app.shared.errors import bad_request, conflict, unauthorized
from app.shared.ids import hash_token, new_session_token
from app.shared.passwords import burn_password_time, hash_password, verify_password


@dataclass(frozen=True, slots=True)
class SessionRecord:
    """会话行。`id` 是 token 的 sha256，**不是 token 本身**（数据库契约 §3.2）。"""

    id: str
    user_id: int
    expires_at: int
    created_at: int


class AuthStore(Protocol):
    """认证需要的数据操作。实现见 features/auth/repo.py。"""

    def find_user_by_username(self, username: str) -> UserAccount | None: ...

    def find_user_by_id(self, user_id: int) -> UserAccount | None: ...

    def insert_user(
        self, *, username: str, display_name: str, password_hash: str, now: int
    ) -> UserAccount: ...

    def insert_session(self, session: SessionRecord) -> None: ...

    def find_session(self, session_id: str) -> SessionRecord | None: ...

    def delete_session(self, session_id: str) -> None: ...

    def delete_expired_sessions(self, now: int) -> int: ...


def register(
    store: AuthStore,
    *,
    username: str,
    password: str,
    confirm_password: str,
    now: int,
) -> tuple[User, str]:
    """注册并直接登录。返回（用户, 原始 token）。

    返回原始 token 是刻意的：库里只存它的哈希，明文只在这一刻存在，
    由 router 写进 cookie。
    """
    name = _validated(check_username(username))
    _validated(check_password_strength(password))
    if password != confirm_password:
        raise bad_request("两次输入的密码不一致")

    if store.find_user_by_username(name) is not None:
        raise conflict("这个用户名已经被用了")

    account = store.insert_user(
        username=name,
        # 昵称默认等于用户名：注册只问三样，少一个字段少一次填错
        display_name=name,
        password_hash=hash_password(password),
        now=now,
    )

    token = _open_session(store, account, now)
    return _public(account), token


def login(store: AuthStore, *, username: str, password: str, now: int) -> tuple[User, str]:
    """登录。账号不存在与密码错误给同一条消息，避免被拿来枚举账号。"""
    account = store.find_user_by_username(normalize_username(username))

    if account is None:
        # 账号不存在也走一遍哈希校验，让耗时接近"密码错"
        burn_password_time()
        raise unauthorized("用户名或密码不对")

    if not verify_password(password, account.password_hash):
        raise unauthorized("用户名或密码不对")

    # 顺手清理过期会话：登录是低频动作，放这里最省事
    store.delete_expired_sessions(now)

    token = _open_session(store, account, now)
    return _public(account), token


def authenticate(store: AuthStore, *, token: str | None, now: int) -> User:
    """校验 cookie 里的 token。缺失、过期、查不到、用户已删，一律 401。"""
    if not token:
        raise unauthorized()

    session = store.find_session(hash_token(token))
    if session is None or session.expires_at <= now:
        raise unauthorized("登录已过期，请重新登录")

    account = store.find_user_by_id(session.user_id)
    if account is None:
        # 用户被删了但会话还在：当作未登录，并把这条脏会话清掉
        store.delete_session(session.id)
        raise unauthorized("登录已过期，请重新登录")

    return _public(account)


def logout(store: AuthStore, *, token: str | None) -> None:
    """登出。没有 token 也成功 —— 幂等，别让人卡在"登不出去"。"""
    if not token:
        return
    store.delete_session(hash_token(token))


def _open_session(store: AuthStore, account: UserAccount, now: int) -> str:
    token = new_session_token()
    store.insert_session(
        SessionRecord(
            id=hash_token(token),
            user_id=account.id,
            expires_at=now + SESSION_TTL_MS,
            created_at=now,
        )
    )
    return token


def _validated(check: FieldCheck) -> str:
    if not check.ok or check.value is None:
        raise bad_request(check.reason or "字段不合法")
    return check.value


def _public(account: UserAccount) -> User:
    return User(
        id=account.id,
        username=account.username,
        display_name=account.display_name,
        created_at=account.created_at,
    )
