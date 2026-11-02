"""POST /runtime/{run_id}/verify：把三层验证接到接口上。

这条不需要 docker 也能测：数据库是真的，预览地址指向测试里的本地 HTTP server，
run_runtimes 里的记录由 repo 直接写进去（模拟"已经起好了"）。
"""

import json
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text

from app.config import get_settings
from app.db.session import SessionLocal
from app.features.runtime import service
from app.features.runtime.repo import SqlRuntimeRepo

pytestmark = pytest.mark.integration

TOKEN = "test-internal-token"

PAGE = "<html><body><h1>待办</h1><script>fetch('/api/items')</script></body></html>"


class _Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            self._send(200, json.dumps({"ok": True}), "application/json")
        elif self.path == "/openapi.json":
            self._send(200, json.dumps({"paths": {"/api/items": {"get": {}}}}), "application/json")
        elif self.path == "/api/items":
            self._send(200, json.dumps({"items": []}), "application/json")
        elif self.path == "/":
            self._send(200, PAGE, "text/html; charset=utf-8")
        else:
            self._send(404, "not found", "text/plain")

    def _send(self, status: int, body: str, content_type: str) -> None:
        data = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *_args: object) -> None:
        pass


@pytest.fixture(scope="module")
def preview_url() -> Iterator[str]:
    server = HTTPServer(("127.0.0.1", 0), _Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()


@pytest.fixture(autouse=True)
def _env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Iterator[None]:
    monkeypatch.setenv("INTERNAL_TOKEN", TOKEN)
    monkeypatch.setenv("RUNTIME_WORKSPACE_DIR", str(tmp_path))
    get_settings.cache_clear()
    service.reset_engine()
    yield
    get_settings.cache_clear()
    service.reset_engine()


def headers() -> dict[str, str]:
    return {"x-internal-token": TOKEN}


def test_verify_writes_verdict_json(client: TestClient, preview_url: str, tmp_path: Path) -> None:
    run_id = "r_verify_0001"
    # 1) 真建库，并塞一张有数据的表
    info = client.post(
        "/api/v1/runtime/databases", json={"runId": run_id}, headers=headers()
    ).json()
    product = create_engine(info["dbUrl"].replace("host.docker.internal", "127.0.0.1"))
    with product.begin() as conn:
        conn.execute(text("CREATE TABLE items (id INT PRIMARY KEY, title VARCHAR(64))"))
        conn.execute(text("INSERT INTO items VALUES (1, '买牛奶')"))
    product.dispose()

    # 2) 假装容器已经在跑：直接写一条 running 记录
    with SessionLocal() as session:
        SqlRuntimeRepo(session).upsert_runtime(
            run_id=run_id,
            container_id="fake-container",
            host_port=59999,
            preview_url=preview_url,
            status="running",
            now=1_793_600_000_000,
        )
        session.commit()

    # 3) 验证
    response = client.post(f"/api/v1/runtime/{run_id}/verify", headers=headers())

    assert response.status_code == 200, response.text
    body = response.json()
    assert [layer["layer"] for layer in body["layers"]] == ["db", "api", "ui"]
    assert body["passed"] == body["total"]

    verdict_file = tmp_path / run_id / "verdict.json"
    assert verdict_file.exists()
    saved = json.loads(verdict_file.read_text(encoding="utf-8"))
    assert saved["layers"][0]["layer"] == "db"

    # 收尾：删库，别把测试库留在实例里
    client.delete(f"/api/v1/runtime/databases/{run_id}", headers=headers())


def test_verify_rejects_run_without_container(client: TestClient) -> None:
    response = client.post("/api/v1/runtime/r_verify_0002/verify", headers=headers())

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "RUNTIME_UNAVAILABLE"


def test_verify_requires_token(client: TestClient) -> None:
    assert client.post("/api/v1/runtime/r_verify_0003/verify").status_code == 401
