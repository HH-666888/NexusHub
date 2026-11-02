"""容器执行：只调 docker CLI，不做抽象。

为什么直接 subprocess 而不是 SDK：全项目只有一种容器、一个镜像，
用 SDK 换来的只是多一个依赖。参数拼装是这里唯一需要小心的地方，
所以它被单独抽成 build_run_args 以便单测（见 tests/unit/test_docker.py）。
"""

import json
import shutil
import subprocess
import time
from dataclasses import dataclass
from http.client import HTTPConnection

# 产物容器用的基础镜像（backend/docker/runtime-python/Dockerfile）
RUNTIME_IMAGE = "nexus-runtime-py312"

# 产物容器里 uvicorn 监听的端口；宿主端口由 service 分配后映射
CONTAINER_PORT = 8000

# 一次执行的上限：启动 60 秒、停止 10 秒
START_TIMEOUT_SECONDS = 60
STOP_TIMEOUT_SECONDS = 10


@dataclass(frozen=True, slots=True)
class RunSpec:
    """起一个产物容器要的全部输入。"""

    run_id: str
    files_dir: str
    host_port: int
    database_url: str


def docker_available() -> bool:
    """docker CLI 在不在。不在时上层给 RUNTIME_UNAVAILABLE，而不是抛奇怪的错。"""
    return shutil.which("docker") is not None


def build_run_args(spec: RunSpec) -> list[str]:
    """拼 `docker run` 参数。

    六个限制一个都不能少：
    - --cpus / --memory / --pids-limit  防跑飞、防 fork 炸弹
    - --read-only + --tmpfs /tmp       产物代码不许写宿主
    - --network=<name>                 自定义网络：能连宿主 MySQL，出不去外网
    文件挂载是 :ro —— 容器只该读自己的代码，写操作没有正当理由。
    """
    return [
        "docker",
        "run",
        "--detach",
        "--rm",
        "--name",
        f"nexus-run-{spec.run_id}",
        "--cpus=1",
        "--memory=1g",
        "--pids-limit=200",
        "--read-only",
        "--tmpfs",
        "/tmp:rw,size=64m",
        "--network",
        network_name(spec.run_id),
        "--add-host",
        "host.docker.internal:host-gateway",
        "-e",
        f"DATABASE_URL={spec.database_url}",
        "-e",
        f"PORT={CONTAINER_PORT}",
        "-v",
        f"{spec.files_dir}:/app:ro",
        "-p",
        f"127.0.0.1:{spec.host_port}:{CONTAINER_PORT}",
        "--label",
        f"nexus.run_id={spec.run_id}",
        RUNTIME_IMAGE,
    ]


def network_name(run_id: str) -> str:
    return f"nexus-net-{run_id}"


def ensure_network(run_id: str) -> None:
    """建一个专属网络。已存在就复用（幂等）。"""
    result = subprocess.run(
        ["docker", "network", "create", network_name(run_id)],
        capture_output=True,
        text=True,
        timeout=START_TIMEOUT_SECONDS,
    )
    # 已存在时 docker 返回非 0 并带 "already exists"，这不是错误
    if result.returncode != 0 and "already exists" not in (result.stderr or ""):
        raise RuntimeError(result.stderr.strip() or "创建容器网络失败")


def remove_network(run_id: str) -> None:
    subprocess.run(
        ["docker", "network", "rm", network_name(run_id)],
        capture_output=True,
        text=True,
        timeout=STOP_TIMEOUT_SECONDS,
    )


def run_container(spec: RunSpec) -> str:
    """起容器，返回 container id。"""
    ensure_network(spec.run_id)
    result = subprocess.run(
        build_run_args(spec),
        capture_output=True,
        text=True,
        timeout=START_TIMEOUT_SECONDS,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "容器启动失败")
    return result.stdout.strip()


def stop_container(container_id: str) -> None:
    """停容器。--rm 会顺手删掉它；已经不在了也算成功。"""
    subprocess.run(
        ["docker", "stop", container_id],
        capture_output=True,
        text=True,
        timeout=STOP_TIMEOUT_SECONDS,
    )


def container_status(container_id: str) -> str:
    """running / exited / 未知。

    容器用 --rm，退出后 inspect 会找不到 —— 这时按 exited 处理最接近事实。
    """
    result = subprocess.run(
        ["docker", "inspect", "--format", "{{.State.Status}}", container_id],
        capture_output=True,
        text=True,
        timeout=STOP_TIMEOUT_SECONDS,
    )
    if result.returncode != 0:
        return "exited"
    return result.stdout.strip() or "exited"


def container_logs(container_id: str, *, tail: int = 40) -> str:
    """最近若干行日志，用于失败时解释"为什么没起来"。"""
    result = subprocess.run(
        ["docker", "logs", "--tail", str(tail), container_id],
        capture_output=True,
        text=True,
        timeout=STOP_TIMEOUT_SECONDS,
    )
    return (result.stdout or "") + (result.stderr or "")


def wait_healthy(host_port: int, *, attempts: int = 20, interval: float = 0.5) -> bool:
    """轮询 /health，直到 200 或次数用完。

    只连 127.0.0.1：端口映射就是绑在本机回环上的。
    """
    for _ in range(attempts):
        connection = HTTPConnection("127.0.0.1", host_port, timeout=2)
        try:
            connection.request("GET", "/health")
            response = connection.getresponse()
            response.read()
            if response.status == 200:
                return True
        except OSError:
            pass
        finally:
            connection.close()
        time.sleep(interval)
    return False


def list_nexus_containers() -> list[dict[str, str]]:
    """所有带 nexus.run_id 标签的容器（回收任务用）。"""
    result = subprocess.run(
        ["docker", "ps", "-a", "--filter", "label=nexus.run_id", "--format", "{{json .}}"],
        capture_output=True,
        text=True,
        timeout=STOP_TIMEOUT_SECONDS,
    )
    if result.returncode != 0:
        return []
    out: list[dict[str, str]] = []
    for line in result.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return out
