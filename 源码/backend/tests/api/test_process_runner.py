"""进程版运行器的完整链路。

这是"没有 Docker 也要证明能跑起来"的那条测试：
建库 → 执行建表脚本 → 起 uvicorn 进程 → 三层验证 → 停进程 → 删库。

它跑在本机真进程上，不是模拟：产物代码真的在监听端口、真的在查数据库。
"""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.features.runtime import runner, service

pytestmark = pytest.mark.integration

TOKEN = "test-internal-token"

APP = """
import os
from fastapi import FastAPI
from fastapi.responses import HTMLResponse
from sqlalchemy import create_engine, text

app = FastAPI()
engine = create_engine(os.environ["DATABASE_URL"])


@app.get("/health")
def health():
    return {"ok": True}


@app.get("/api/items")
def items():
    with engine.connect() as conn:
        rows = conn.execute(text("SELECT id, title FROM items")).all()
    return {"items": [{"id": r[0], "title": r[1]} for r in rows]}


@app.get("/", response_class=HTMLResponse)
def index():
    return '<html><body><script>fetch("/api/items")</script></body></html>'
"""

SCHEMA = (
    "CREATE TABLE IF NOT EXISTS items ("
    "id BIGINT PRIMARY KEY AUTO_INCREMENT, title VARCHAR(64) NOT NULL);"
)
SEED = "INSERT INTO items (title) VALUES ('买牛奶'), ('写周报');"


@pytest.fixture(autouse=True)
def _env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("INTERNAL_TOKEN", TOKEN)
    monkeypatch.setenv("RUNTIME_RUNNER", "process")
    monkeypatch.setenv("RUNTIME_WORKSPACE_DIR", str(tmp_path))
    get_settings.cache_clear()
    service.reset_engine()
    yield
    get_settings.cache_clear()
    service.reset_engine()


def headers() -> dict[str, str]:
    return {"x-internal-token": TOKEN}


def _write_run(tmp_path: Path) -> Path:
    run_dir = tmp_path / "r_proc_0001"
    (run_dir / "db").mkdir(parents=True)
    (run_dir / "api").mkdir(parents=True)
    (run_dir / "db" / "schema.sql").write_text(SCHEMA, encoding="utf-8")
    (run_dir / "db" / "seed.sql").write_text(SEED, encoding="utf-8")
    (run_dir / "api" / "main.py").write_text(APP, encoding="utf-8")
    return run_dir


def test_process_runner_is_selectable(monkeypatch: pytest.MonkeyPatch) -> None:
    assert runner.selected() == "process"
    monkeypatch.setenv("RUNTIME_RUNNER", "docker")
    get_settings.cache_clear()
    assert runner.selected() == "docker"


def test_full_chain_on_process_runner(client: TestClient, tmp_path: Path) -> None:
    run_dir = _write_run(tmp_path)
    run_id = run_dir.name

    started = client.post(
        f"/api/v1/runtime/{run_id}/start",
        json={"filesDir": str(run_dir)},
        headers=headers(),
    )
    assert started.status_code == 201, started.text
    body = started.json()
    assert body["status"] == "running"

    try:
        # 真进程：端口直接能应答
        assert body["previewUrl"].startswith("http://127.0.0.1:")

        verdict = client.post(f"/api/v1/runtime/{run_id}/verify", headers=headers())
        assert verdict.status_code == 200, verdict.text
        report = verdict.json()
        assert report["passed"] == report["total"], report
        layers = {layer["layer"]: layer for layer in report["layers"]}
        assert layers["db"]["passed"] == layers["db"]["total"]
        assert layers["api"]["passed"] == layers["api"]["total"]
        assert layers["ui"]["passed"] == layers["ui"]["total"]

        # 验收结果真的落盘了
        assert (run_dir / "verdict.json").exists()
    finally:
        assert client.post(f"/api/v1/runtime/{run_id}/stop", headers=headers()).status_code == 204
        client.delete(f"/api/v1/runtime/databases/{run_id}", headers=headers())

    # 停了就该真的停：状态查询不再报 running
    status = client.get(f"/api/v1/runtime/{run_id}/status", headers=headers())
    assert status.json()["status"] != "running"


def test_process_runner_reports_flat_failure(client: TestClient, tmp_path: Path) -> None:
    """产物入口写错时，start 要说清"没起来"，不能假装成功。"""
    run_dir = tmp_path / "r_proc_0002"
    (run_dir / "db").mkdir(parents=True)
    (run_dir / "api").mkdir(parents=True)
    (run_dir / "db" / "schema.sql").write_text(SCHEMA, encoding="utf-8")
    (run_dir / "api" / "main.py").write_text("raise RuntimeError('boom')\n", encoding="utf-8")

    response = client.post(
        f"/api/v1/runtime/{run_dir.name}/start",
        json={"filesDir": str(run_dir)},
        headers=headers(),
    )

    assert response.status_code == 504
    assert response.json()["error"]["code"] == "RUNTIME_TIMEOUT"
    client.delete(f"/api/v1/runtime/databases/{run_dir.name}", headers=headers())