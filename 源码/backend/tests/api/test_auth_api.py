"""认证接口的集成测试（契约书 §5.1、§4.1）。

走真实的 FastAPI 路由 + 真实的 MySQL repo：单测覆盖业务规则，这里覆盖
"规则 → HTTP → 数据库" 这一整条链路，包括 cookie 属性与事务边界。
"""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db.engine import engine
from app.db.models import UserSession
from app.shared.ids import hash_token

pytestmark = pytest.mark.integration

REGISTER = "/api/auth/register"
LOGIN = "/api/auth/login"
LOGOUT = "/api/auth/logout"
ME = "/api/auth/me"


def register(client: TestClient, *, username: str = "alice", password: str = "abc123"):
    return client.post(
        REGISTER, json={"username": username, "password": password, "confirmPassword": password}
    )


def test_register_returns_201_and_logs_in(client: TestClient) -> None:
    response = register(client, username="Alice")

    assert response.status_code == 201
    body = response.json()
    # 用户名归一化：入库是小写
    assert body["user"]["username"] == "alice"
    assert body["user"]["displayName"] == "alice"
    assert "createdAt" in body["user"]

    # 注册即登录：直接拿 cookie 访问 /me
    me = client.get(ME)
    assert me.status_code == 200
    assert me.json()["user"]["username"] == "alice"


def test_cookie_is_http_only_and_same_site(client: TestClient) -> None:
    response = register(client)

    set_cookie = response.headers["set-cookie"].lower()
    assert "nexus_session=" in set_cookie
    assert "httponly" in set_cookie
    assert "samesite=lax" in set_cookie
    assert "path=/" in set_cookie


def test_session_id_in_db_is_hash_of_cookie_token(client: TestClient) -> None:
    register(client)
    token = client.cookies.get("nexus_session")
    assert token

    with engine.connect() as conn:
        ids = [row[0] for row in conn.execute(select(UserSession.id))]

    # 库里绝不该出现明文 token
    assert token not in ids
    assert hash_token(token) in ids


def test_duplicate_username_returns_409_conflict(client: TestClient) -> None:
    register(client)

    response = register(client, username="ALICE")  # 大小写不同也算重名

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "CONFLICT"


def test_weak_password_returns_400(client: TestClient) -> None:
    response = register(client, password="abcdef")

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "BAD_REQUEST"


def test_confirm_mismatch_returns_400(client: TestClient) -> None:
    response = client.post(
        REGISTER, json={"username": "bob", "password": "abc123", "confirmPassword": "abc124"}
    )

    assert response.status_code == 400


def test_login_with_wrong_password_returns_401(client: TestClient) -> None:
    register(client)
    client.cookies.clear()

    response = client.post(LOGIN, json={"username": "alice", "password": "wrong123"})

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "UNAUTHORIZED"


def test_me_without_cookie_returns_401(client: TestClient) -> None:
    client.cookies.clear()

    response = client.get(ME)

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "UNAUTHORIZED"


def test_logout_clears_session_and_cookie(client: TestClient) -> None:
    register(client)
    token = client.cookies.get("nexus_session")

    out = client.post(LOGOUT)
    assert out.status_code == 204

    # 服务端会话已删；客户端 cookie 也被清掉
    with engine.connect() as conn:
        assert conn.execute(select(UserSession.id)).first() is None
    assert token

    assert client.get(ME).status_code == 401


def test_login_creates_a_second_session_without_killing_the_first(client: TestClient) -> None:
    register(client)
    first = client.cookies.get("nexus_session")

    second_client = TestClient(client.app)
    second = second_client.post(LOGIN, json={"username": "alice", "password": "abc123"})
    assert second.status_code == 200

    # 两个会话各自有效（多设备登录是正常需求，不该互相踢）
    assert client.cookies.get("nexus_session") == first
    assert second_client.get(ME).status_code == 200
    assert client.get(ME).status_code == 200
