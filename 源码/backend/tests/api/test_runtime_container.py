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
def test_start_and_stop_real_container(client: TestClient) -> None:
    """真的起一次容器：/health 200，然后停掉。"""
    assert docker.docker_available()
    workspace = Path(get_settings().runtime_workspace_dir).resolve()
    run_id = "r_container_0001"
    api_dir = workspace / run_id / "api"
    api_dir.mkdir(parents=True, exist_ok=True)
    (api_dir / "main.py").write_text(
        "from fastapi import FastAPI\napp = FastAPI()\n\n@app.get('/health')\ndef health():\n"
        "    return {'ok': True}\n",
        encoding="utf-8",
    )

    started = client.post(
        "/api/v1/runtime/" + run_id + "/start",
        json={"filesDir": str(workspace / run_id)},
        headers=headers(),
    )
    assert started.status_code == 201, started.text
    body = started.json()
    assert body["status"] == "running"

    status = client.get(f"/api/v1/runtime/{run_id}/status", headers=headers())
    assert status.json()["status"] == "running"

    stop = client.post(f"/api/v1/runtime/{run_id}/stop", headers=headers())
    assert stop.status_code == 204
    drop = client.delete(f"/api/v1/runtime/databases/{run_id}", headers=headers())
    assert drop.status_code == 204
