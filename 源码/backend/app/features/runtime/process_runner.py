"""进程版运行器：直接把产物后端当宿主机进程跑起来。

**为什么需要它**：Docker 要管理员权限，Windows 开发机上常常没有；
没有 Docker 就没法演示"生成 → 真的跑起来"这条链路。这个运行器让开发机也能跑通，
接口与容器版完全一致，代价是**没有隔离**：产物代码就是你自己刚生成的，
跑坏了最多删掉工作区。

默认仍是 docker；要用它必须在 .env 里显式写 `RUNTIME_RUNNER=process`。
"""

import os
import subprocess
import sys
import time
from pathlib import Path

import psutil

PREFIX = "proc:"


def is_process_handle(handle: str) -> bool:
    return handle.startswith(PREFIX)


def start(files_dir: str, host_port: int, database_url: str) -> str:
    """起一个 uvicorn 进程，返回 `proc:<pid>`。

    cwd 设成产物目录，入口固定 `api.main:app` —— 与容器版同一约定。
    输出写进产物目录下的 `.runtime.log`，起不来时能直接看。
    """
    root = Path(files_dir)
    env = {
        **os.environ,
        # 产物进程不需要内部口令，清掉免得被它读到
        "INTERNAL_TOKEN": "",
        "DATABASE_URL": database_url.replace("host.docker.internal", "127.0.0.1"),
        "PORT": str(host_port),
    }
    log_path = root / ".runtime.log"
    with open(log_path, "ab") as log:
        process = subprocess.Popen(  # noqa: S603 —— 命令由我们自己拼，不含用户输入
            [
                sys.executable,
                "-m",
                "uvicorn",
                "api.main:app",
                "--host",
                "127.0.0.1",
                "--port",
                str(host_port),
            ],
            cwd=str(root),
            env=env,
            stdout=log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
    return f"{PREFIX}{process.pid}"


def stop(handle: str) -> None:
    """停进程：先礼后兵。已经不存在也算成功（幂等）。"""
    process = _process_of(handle)
    if process is None:
        return
    try:
        process.terminate()
        process.wait(timeout=5)
    except psutil.TimeoutExpired:
        process.kill()
    except psutil.NoSuchProcess:
        return


def is_running(handle: str) -> bool:
    return _process_of(handle) is not None


def logs(files_dir: str, tail: int = 40) -> str:
    path = Path(files_dir) / ".runtime.log"
    if not path.exists():
        return ""
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    return "\n".join(lines[-tail:])


def wait_ready(host_port: int, *, attempts: int = 40, interval: float = 0.25) -> bool:
    """等端口真的能应答。进程版冷启动比容器快，10 秒足够。"""
    from app.features.runtime.docker import wait_healthy

    for _ in range(attempts):
        if wait_healthy(host_port, attempts=1, interval=0):
            return True
        time.sleep(interval)
    return False


def _process_of(handle: str) -> "psutil.Process | None":
    """按 handle 里的 pid 取进程对象；不存在时返回 None。

    用 psutil 而不是 os.kill(pid, 0)：Windows 上 os.kill 对不存在的 pid
    行为不明确（有的版本直接报错），psutil 在两个平台都稳。
    """
    try:
        return psutil.Process(int(handle[len(PREFIX) :]))
    except (psutil.NoSuchProcess, ValueError):
        return None
