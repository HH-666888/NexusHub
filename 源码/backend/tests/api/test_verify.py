"""三层验证的行为。

用真实的 HTTP server（后台线程）与真实的 sqlite 库来跑 —— 不依赖 docker，
所以这几条在任何机器上都能执行；它们是"验证器本身对不对"的证明。
"""

import json
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest
from sqlalchemy import create_engine, text

from app.features.runtime.verify import (
    check_page,
    verify_all,
    verify_api,
    verify_database,
    verify_ui,
)

pytestmark = pytest.mark.integration

PAGE = """<html><body><h1>待办</h1>
<script>fetch('/api/items').then(r => r.json())</script></body></html>"""


class _Handler(BaseHTTPRequestHandler):
    """一个最小的产物服务：/health、/openapi.json、/api/items、/"""

    def do_GET(self) -> None:  # noqa: N802 —— 覆盖基类的命名
        if self.path == "/health":
            self._json({"ok": True})
        elif self.path == "/openapi.json":
            self._json({"paths": {"/api/items": {"get": {}}, "/api/items/{id}": {"get": {}}}})
        elif self.path == "/api/items":
            self._json({"items": [{"id": 1}]})
        elif self.path == "/":
            self._body(200, PAGE, "text/html; charset=utf-8")
        else:
            self._body(404, "not found", "text/plain")

    def _json(self, payload: dict) -> None:
        self._body(200, json.dumps(payload), "application/json")

    def _body(self, status: int, body: str, content_type: str) -> None:
        data = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *_args: object) -> None:
        """安静点：测试输出里不需要访问日志。"""


@pytest.fixture(scope="module")
def base_url() -> Iterator[str]:
    server = HTTPServer(("127.0.0.1", 0), _Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()


@pytest.fixture
def sqlite_url(tmp_path) -> str:
    url = f"sqlite:///{tmp_path / 'run.db'}"
    engine = create_engine(url)
    with engine.begin() as conn:
        conn.execute(text("CREATE TABLE todos (id INTEGER PRIMARY KEY, title TEXT)"))
        conn.execute(text("INSERT INTO todos (title) VALUES ('买牛奶')"))
    engine.dispose()
    return url


def test_api_layer_passes_for_healthy_service(base_url: str) -> None:
    layer = verify_api(base_url)

    assert layer.layer == "api"
    assert layer.passed == layer.total, [c.model_dump() for c in layer.checks]
    # 带路径参数的端点不该被打（没有真实 id 可给）
    names = [c.name for c in layer.checks]
    assert "GET /api/items" in names
    assert "GET /api/items/{id}" not in names


def test_api_layer_reports_dead_service() -> None:
    layer = verify_api("http://127.0.0.1:9")

    assert layer.passed < layer.total
    assert layer.checks[0].name == "GET /health"
    assert layer.checks[0].pass_ is False


def test_ui_layer_passes_for_page_calling_api(base_url: str) -> None:
    layer = verify_ui(base_url)

    assert layer.passed == layer.total, [c.model_dump() for c in layer.checks]
    assert {c.name for c in layer.checks} == {
        "页面能打开",
        "是 HTML",
        "调用了自己的接口",
        "没有引外部资源",
    }


def test_page_checker_flags_external_links() -> None:
    html = (
        '<html><head><script src="https://cdn.example.com/x.js"></script></head>'
        "<body><script>fetch('/api/items')</script></body></html>"
    )
    checks = {c.name: c for c in check_page(200, "text/html", html)}

    assert checks["没有引外部资源"].pass_ is False


def test_page_checker_flags_page_not_calling_api() -> None:
    checks = {c.name: c for c in check_page(200, "text/html", "<html><body>hi</body></html>")}

    assert checks["调用了自己的接口"].pass_ is False


def test_page_checker_flags_non_html_response() -> None:
    checks = {c.name: c for c in check_page(200, "application/json", "{}")}

    assert checks["是 HTML"].pass_ is False


def test_database_layer_passes_with_table_and_rows(sqlite_url: str) -> None:
    layer = verify_database(sqlite_url)

    names = {c.name for c in layer.checks}
    assert "表已创建" in names
    assert "表 todos 可查询" in names
    assert layer.passed == layer.total, [c.model_dump() for c in layer.checks]


def test_database_layer_flags_empty_database(tmp_path) -> None:
    url = f"sqlite:///{tmp_path / 'empty.db'}"
    layer = verify_database(url)

    assert layer.checks[0].name == "表已创建"
    assert layer.checks[0].pass_ is False


def test_database_layer_flags_unreachable(tmp_path) -> None:
    layer = verify_database("mysql+pymysql://u:p@127.0.0.1:9/nope")

    assert layer.passed == 0
    assert layer.checks[0].pass_ is False


def test_verify_all_merges_three_layers(base_url: str, sqlite_url: str) -> None:
    verdict = verify_all(preview_url=base_url, db_url=sqlite_url)

    assert [layer.layer for layer in verdict.layers] == ["db", "api", "ui"]
    assert verdict.total == sum(layer.total for layer in verdict.layers)
    assert verdict.passed == sum(layer.passed for layer in verdict.layers)
    assert verdict.passed == verdict.total
