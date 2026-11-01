"""健康检查（契约书 §5.5）。

两条断言：形状固定；数据库连不上时仍然是 200 + `db: "down"`。
后者是关键 —— 探针判断的是"进程能不能答"，不是"数据库通不通"。
"""

from fastapi.testclient import TestClient

from app import __version__
from app.main import create_app


def test_health_shape() -> None:
    client = TestClient(create_app())
    response = client.get("/api/v1/health")

    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"ok", "version", "db"}
    assert body["version"] == __version__
    assert body["db"] in {"ok", "down"}
    # ok 必须与 db 一致，不允许出现"说 ok 但其实连不上"的自相矛盾
    assert body["ok"] is (body["db"] == "ok")
