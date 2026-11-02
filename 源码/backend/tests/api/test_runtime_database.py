"""运行时：建库与回收（契约书 §5.9）。

跑在真 MySQL 上：只靠单测证明不了"库真的建出来了、真的删掉了"。
用本地 .env 里的 MYSQL_PROVISIONER_URL（供给账号）与 MYSQL_PRODUCT_URL（产物账号）。
"""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.exc import OperationalError, ProgrammingError

from app.config import get_settings
from app.features.runtime import service
from app.features.runtime.service import database_name

pytestmark = pytest.mark.integration

TOKEN = "test-internal-token"


@pytest.fixture(autouse=True)
def _internal_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("INTERNAL_TOKEN", TOKEN)
    get_settings.cache_clear()
    service.reset_engine()
    yield
    get_settings.cache_clear()
    service.reset_engine()


def headers() -> dict[str, str]:
    return {"x-internal-token": TOKEN}


def database_exists(name: str) -> bool:
    """用供给账号查 information_schema —— 它没有读业务表的权限，但能看到库名。"""
    engine = service.provisioner_engine()
    with engine.connect() as conn:
        row = conn.execute(
            text("SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name = :n"),
            {"n": name},
        ).scalar_one()
    return bool(row)


def test_create_database_returns_usable_url(client: TestClient) -> None:
    run_id = "r_dbtest_0001"

    response = client.post("/api/v1/runtime/databases", json={"runId": run_id}, headers=headers())

    assert response.status_code == 201
    body = response.json()
    assert body["dbName"] == database_name(run_id)
    assert body["dbUrl"].endswith(f"/{body['dbName']}?charset=utf8mb4")
    assert body["dbUrl"].startswith("mysql+pymysql://nexus_product:")
    assert database_exists(body["dbName"])

    client.delete(f"/api/v1/runtime/databases/{run_id}", headers=headers())
    assert not database_exists(body["dbName"])


def test_create_is_idempotent(client: TestClient) -> None:
    run_id = "r_dbtest_0002"

    first = client.post("/api/v1/runtime/databases", json={"runId": run_id}, headers=headers())
    second = client.post("/api/v1/runtime/databases", json={"runId": run_id}, headers=headers())

    assert first.status_code == 201
    assert second.status_code == 201
    assert first.json() == second.json()

    client.delete(f"/api/v1/runtime/databases/{run_id}", headers=headers())


def test_delete_is_idempotent(client: TestClient) -> None:
    run_id = "r_dbtest_0003"
    client.post("/api/v1/runtime/databases", json={"runId": run_id}, headers=headers())
    url = f"/api/v1/runtime/databases/{run_id}"

    assert client.delete(url, headers=headers()).status_code == 204
    # 再删一次不该报错
    assert client.delete(url, headers=headers()).status_code == 204


def test_product_account_cannot_read_main_database(client: TestClient) -> None:
    """核心安全断言：产物账号在 nexus_run_* 上有权限，读 nexus 主库被拒。"""
    run_id = "r_dbtest_0004"
    info = client.post(
        "/api/v1/runtime/databases", json={"runId": run_id}, headers=headers()
    ).json()

    product = create_engine(info["dbUrl"].replace("host.docker.internal", "127.0.0.1"))
    try:
        with product.connect() as conn:
            # 自己的库能用
            conn.execute(text("CREATE TABLE t (id INT PRIMARY KEY)"))
            conn.execute(text("INSERT INTO t VALUES (1)"))
            conn.commit()
            assert conn.execute(text("SELECT COUNT(*) FROM t")).scalar_one() == 1
            # 主库读不到
            with pytest.raises((OperationalError, ProgrammingError)):
                conn.execute(text("SELECT COUNT(*) FROM nexus.users"))
    finally:
        product.dispose()
        client.delete(f"/api/v1/runtime/databases/{run_id}", headers=headers())


def test_rejects_bad_run_id(client: TestClient) -> None:
    response = client.post(
        "/api/v1/runtime/databases", json={"runId": "bad id with space"}, headers=headers()
    )

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "BAD_REQUEST"


def test_requires_internal_token(client: TestClient) -> None:
    # 不带 token
    assert client.post("/api/v1/runtime/databases", json={"runId": "r_x"}).status_code == 401
    # 带错 token
    wrong = {"x-internal-token": "nope"}
    assert (
        client.post("/api/v1/runtime/databases", json={"runId": "r_x"}, headers=wrong).status_code
        == 401
    )
