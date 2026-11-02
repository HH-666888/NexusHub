"""运行时：容器接口（契约书 §5.9）。

本机没有 docker 时，happy path 无法验证 —— 那几条标了 skipif，等装好 docker 再跑。
不依赖 docker 的部分（入参校验、幂等、缺口令、无 docker 时的错误码）现在就跑。
"""

import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.features.runtime import docker, service

pytestmark = pytest.mark.integration

TOKEN = "test-internal-token"
HAS_DOCKER = shutil.which("docker") is not None


@pytest.fixture(autouse=True)
def _env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("INTERNAL_TOKEN", TOKEN)
    # 这条文件测的是容器路径：显式钉住 docker，避免本地 .env 里的 process 把结论改掉
    monkeypatch.setenv("RUNTIME_RUNNER", "docker")
    get_settings.cache_clear()
    service.reset_engine()
    yield
    get_settings.cache_clear()
    service.reset_engine()


def headers() -> dict[str, str]:
    return {"x-internal-token": TOKEN}


def test_start_rejects_files_dir_outside_workspace(client: TestClient) -> None:
    """安全边界：filesDir 必须落在工作区里，否则容器就能挂载宿主任意目录。"""
    response = client.post(
        "/api/v1/runtime/r_files_0001/start",
        json={"filesDir": "C:/Windows/System32"},
        headers=headers(),
    )

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "BAD_REQUEST"


def test_start_rejects_missing_dir(client: TestClient) -> None:
    workspace = Path(get_settings().runtime_workspace_dir).resolve()
    response = client.post(
        "/api/v1/runtime/r_files_0002/start",
        json={"filesDir": str(workspace / "no_such_run")},
        headers=headers(),
    )

    assert response.status_code == 400


@pytest.mark.skipif(HAS_DOCKER, reason="本机装了 docker，这条错误路径不成立")
def test_start_without_docker_returns_503(client: TestClient) -> None:
    workspace = Path(get_settings().runtime_workspace_dir).resolve()
    run_dir = workspace / "r_files_0003"
    run_dir.mkdir(parents=True, exist_ok=True)

    response = client.post(
        "/api/v1/runtime/r_files_0003/start",
        json={"filesDir": str(run_dir)},
        headers=headers(),
    )

    assert response.status_code == 503
    assert response.json()["error"]["code"] == "RUNTIME_UNAVAILABLE"


def test_status_of_unknown_run_is_none(client: TestClient) -> None:
    response = client.get("/api/v1/runtime/r_never_started/status", headers=headers())

    assert response.status_code == 200
    assert response.json()["status"] == "none"


def test_stop_of_unknown_run_is_204(client: TestClient) -> None:
    """没起过也返回 204：取消操作不该因为"本来就没有"而报错。"""
    response = client.post("/api/v1/runtime/r_never_started/stop", headers=headers())

    assert response.status_code == 204


def test_container_endpoints_require_token(client: TestClient) -> None:
    assert client.get("/api/v1/runtime/r_x/status").status_code == 401
    assert client.post("/api/v1/runtime/r_x/stop").status_code == 401


@pytest.mark.skipif(not HAS_DOCKER, reason="需要 docker")
def test_full_chain_with_real_container(client: TestClient) -> None:
    """没有模型也要能证明的完整链路：建库 → 建表 → 起容器 → 三层验证 → 回收。

    这是全项目唯一需要 docker 的测试；本机没装时自动跳过，
    装好之后它就是"环境能不能跑全栈"的那一个判据。
    """
    assert docker.docker_available()
    workspace = Path(get_settings().runtime_workspace_dir).resolve()
    run_id = "r_chain_0001"
    run_dir = workspace / run_id
    (run_dir / "db").mkdir(parents=True, exist_ok=True)
    (run_dir / "api").mkdir(parents=True, exist_ok=True)
    (run_dir / "web").mkdir(parents=True, exist_ok=True)

    (run_dir / "db" / "schema.sql").write_text(
        "CREATE TABLE IF NOT EXISTS items ("
        "id BIGINT PRIMARY KEY AUTO_INCREMENT, title VARCHAR(64));",
        encoding="utf-8",
    )
    (run_dir / "db" / "seed.sql").write_text(
        "INSERT INTO items (title) VALUES ('买牛奶');", encoding="utf-8"
    )
    # 产物后端：/health + /api/items + 根路径给一段调接口的 HTML
    (run_dir / "api" / "main.py").write_text(
        "\n".join(
            [
                "import os",
                "from fastapi import FastAPI",
                "from fastapi.responses import HTMLResponse",
                "from sqlalchemy import create_engine, text",
                "",
                "app = FastAPI()",
                "engine = create_engine(os.environ['DATABASE_URL'])",
                "",
                "@app.get('/health')",
                "def health():",
                "    return {'ok': True}",
                "",
                "@app.get('/api/items')",
                "def items():",
                "    with engine.connect() as conn:",
                "        rows = conn.execute(text('SELECT id, title FROM items')).all()",
                "    return {'items': [{'id': r[0], 'title': r[1]} for r in rows]}",
                "",
                "@app.get('/', response_class=HTMLResponse)",
                "def index():",
                "    return '<html><body><script>fetch(\"/api/items\")</script></body></html>'",
                "",
            ]
        ),
        encoding="utf-8",
    )

    started = client.post(
        f"/api/v1/runtime/{run_id}/start",
        json={"filesDir": str(run_dir)},
        headers=headers(),
    )
    assert started.status_code == 201, started.text
    try:
        verdict = client.post(f"/api/v1/runtime/{run_id}/verify", headers=headers())
        assert verdict.status_code == 200, verdict.text
        body = verdict.json()
        assert body["passed"] == body["total"], body
        layers = {layer["layer"]: layer for layer in body["layers"]}
        assert layers["db"]["passed"] == layers["db"]["total"]
        assert layers["api"]["passed"] == layers["api"]["total"]
        assert layers["ui"]["passed"] == layers["ui"]["total"]
    finally:
        client.post(f"/api/v1/runtime/{run_id}/stop", headers=headers())
        client.delete(f"/api/v1/runtime/databases/{run_id}", headers=headers())
