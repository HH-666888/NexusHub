"""错误信封（契约书 §4.2）。

重点不是"有没有报错"，而是**报错的形状统一**：前端只按 error.code 分支。
框架自己抛的 404 也必须走同一个信封，不能一半是 {"detail": …}。
"""

from fastapi.testclient import TestClient

from app.main import create_app


def test_unknown_route_uses_envelope() -> None:
    client = TestClient(create_app())
    response = client.get("/api/definitely-not-a-route")

    assert response.status_code == 404
    body = response.json()
    assert "detail" not in body
    assert body["error"]["code"] == "NOT_FOUND"
    assert body["error"]["message"]


def test_method_not_allowed_uses_envelope() -> None:
    client = TestClient(create_app())
    response = client.post("/api/health")

    assert response.status_code == 405
    assert response.json()["error"]["code"] == "METHOD_NOT_ALLOWED"
