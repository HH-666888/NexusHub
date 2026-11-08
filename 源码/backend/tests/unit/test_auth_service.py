"""认证业务的单测。

不连数据库：用一个内存 fake 实现 AuthStore。这样业务规则（用户名归一化、
密码规则、会话过期、账号枚举防护）能被快速、确定地覆盖；
真正碰 SQL 的部分留给 repo 的集成测试。
"""

import pytest

from app.domain.user import SESSION_TTL_MS, UserAccount
from app.features.auth import service
from app.features.auth.service import SessionRecord
from app.shared.errors import AppError
from app.shared.ids import hash_token
from app.shared.passwords import verify_password

NOW = 1_793_520_000_000


class FakeStore:
    def __init__(self) -> None:
        self.users: dict[str, UserAccount] = {}
        self.sessions: dict[str, SessionRecord] = {}
        self.next_id = 1

    def find_user_by_username(self, username: str) -> UserAccount | None:
        return self.users.get(username)

    def find_user_by_id(self, user_id: int) -> UserAccount | None:
        return next((u for u in self.users.values() if u.id == user_id), None)

    def insert_user(
        self, *, username: str, display_name: str, password_hash: str, now: int
    ) -> UserAccount:
        account = UserAccount(
            id=self.next_id,
            username=username,
            display_name=display_name,
            password_hash=password_hash,
            created_at=now,
        )
        self.users[username] = account
        self.next_id += 1
        return account

    def insert_session(self, session: SessionRecord) -> None:
        self.sessions[session.id] = session

    def find_session(self, session_id: str) -> SessionRecord | None:
        return self.sessions.get(session_id)

    def delete_session(self, session_id: str) -> None:
        self.sessions.pop(session_id, None)

    def delete_expired_sessions(self, now: int) -> int:
        expired = [k for k, s in self.sessions.items() if s.expires_at <= now]
        for key in expired:
            del self.sessions[key]
        return len(expired)


@pytest.fixture
def store() -> FakeStore:
    return FakeStore()


def register(store: FakeStore, username: str = "demo", password: str = "abc123"):
    return service.register(
        store, username=username, password=password, confirm_password=password, now=NOW
    )


# ---------------------------------------------------------------- 注册


def test_register_stores_hash_and_returns_public_user(store: FakeStore) -> None:
    user, token = register(store)

    assert user.username == "demo"
    # 昵称默认等于用户名
    assert user.display_name == "demo"
    account = store.users["demo"]
    assert account.password_hash != "abc123"
    assert verify_password("abc123", account.password_hash)
    assert token


def test_register_normalises_username(store: FakeStore) -> None:
    user, _ = register(store, username="  DemoUser  ")

    # 去空格 + 转小写，否则 DemoUser 与 demouser 会是两个账号
    assert user.username == "demouser"


def test_register_rejects_duplicate_username(store: FakeStore) -> None:
    register(store)

    with pytest.raises(AppError) as excinfo:
        register(store, username="DEMO")

    assert excinfo.value.code == "CONFLICT"
    assert excinfo.value.status == 409


# 规则只有长度：>=6 且 <=128，不限制字符类型
@pytest.mark.parametrize("password", ["abc12", "a" * 129])
def test_register_rejects_weak_password(store: FakeStore, password: str) -> None:
    with pytest.raises(AppError) as excinfo:
        register(store, password=password)

    assert excinfo.value.code == "BAD_REQUEST"


def test_register_rejects_confirm_mismatch(store: FakeStore) -> None:
    with pytest.raises(AppError) as excinfo:
        service.register(
            store, username="demo", password="abc123", confirm_password="abc124", now=NOW
        )

    assert "密码不一致" in excinfo.value.message


# 规则只有长度：4~20，不限制字符类型（空格、符号都允许）
@pytest.mark.parametrize("username", ["a", "a" * 21, ""])
def test_register_rejects_bad_username(store: FakeStore, username: str) -> None:
    with pytest.raises(AppError) as excinfo:
        register(store, username=username)

    assert excinfo.value.code == "BAD_REQUEST"


# ---------------------------------------------------------------- 登录


def test_login_returns_new_session_and_stores_hash(store: FakeStore) -> None:
    register(store)

    user, token = service.login(store, username="DEMO", password="abc123", now=NOW)

    assert user.username == "demo"
    # 库里存的是哈希，不是明文 token
    assert token not in store.sessions
    assert hash_token(token) in store.sessions
    assert store.sessions[hash_token(token)].expires_at == NOW + SESSION_TTL_MS


def test_login_with_wrong_password_is_unauthorized(store: FakeStore) -> None:
    register(store)

    with pytest.raises(AppError) as excinfo:
        service.login(store, username="demo", password="abc999", now=NOW)

    assert excinfo.value.code == "UNAUTHORIZED"
    assert excinfo.value.status == 401


def test_unknown_user_gives_the_same_message_as_wrong_password(store: FakeStore) -> None:
    register(store)

    with pytest.raises(AppError) as wrong_password:
        service.login(store, username="demo", password="abc999", now=NOW)
    with pytest.raises(AppError) as no_such_user:
        service.login(store, username="ghost", password="abc123", now=NOW)

    # 两条消息必须一模一样，否则能被拿来枚举账号
    assert wrong_password.value.message == no_such_user.value.message


def test_login_cleans_expired_sessions(store: FakeStore) -> None:
    register(store)
    store.sessions["stale"] = SessionRecord(
        id="stale", user_id=1, expires_at=NOW - 1, created_at=NOW - 1000
    )

    service.login(store, username="demo", password="abc123", now=NOW)

    assert "stale" not in store.sessions


# ---------------------------------------------------------------- 会话


def test_authenticate_accepts_fresh_token(store: FakeStore) -> None:
    _, token = register(store)

    user = service.authenticate(store, token=token, now=NOW + 1000)

    assert user.id == 1
    assert user.username == "demo"


def test_authenticate_rejects_expired_session(store: FakeStore) -> None:
    _, token = register(store)

    with pytest.raises(AppError) as excinfo:
        service.authenticate(store, token=token, now=NOW + SESSION_TTL_MS + 1)

    assert excinfo.value.code == "UNAUTHORIZED"


def test_authenticate_rejects_missing_or_unknown_token(store: FakeStore) -> None:
    for token in (None, "", "not-a-real-token"):
        with pytest.raises(AppError) as excinfo:
            service.authenticate(store, token=token, now=NOW)
        assert excinfo.value.code == "UNAUTHORIZED"


def test_authenticate_drops_session_of_deleted_user(store: FakeStore) -> None:
    _, token = register(store)
    del store.users["demo"]

    with pytest.raises(AppError):
        service.authenticate(store, token=token, now=NOW)

    # 脏会话要被清掉，否则每来一次请求就多查一次库
    assert hash_token(token) not in store.sessions


def test_logout_is_idempotent(store: FakeStore) -> None:
    _, token = register(store)

    service.logout(store, token=token)
    assert store.sessions == {}

    # 没有 token、或再登出一次都不该抛错
    service.logout(store, token=None)
    service.logout(store, token=token)
