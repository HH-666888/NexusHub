"""本机进程运行时：起产物、等端口、停进程。

与容器语义对齐：独立工作区、动态端口、可回收。
"""

from __future__ import annotations

import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import httpx


def pick_port(start: int = 50000) -> int:
    for port in range(start, start + 500):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind(("127.0.0.1", port))
            except OSError:
                continue
            return port
    raise RuntimeError("没有可用端口")


def start(workspace: Path, entry: str, port: int) -> subprocess.Popen:
    env = {**os.environ, "PORT": str(port), "PYTHONUNBUFFERED": "1"}
    log = open(workspace / "_runtime.log", "w", encoding="utf-8")  # noqa: SIM115
    process = subprocess.Popen(  # noqa: S603
        [sys.executable, entry],
        cwd=str(workspace),
        env=env,
        stdout=log,
        stderr=subprocess.STDOUT,
    )
    process._log_path = workspace / "_runtime.log"  # type: ignore[attr-defined]
    return process


def wait_http(url: str, timeout: float = 20.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            response = httpx.get(url, timeout=2.0)
            if response.status_code < 500:
                return True
        except httpx.HTTPError:
            time.sleep(0.4)
    return False


def stop(process: subprocess.Popen) -> None:
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()


def log_tail(process: subprocess.Popen, lines: int = 12) -> str:
    path = getattr(process, "_log_path", None)
    if path is None or not Path(path).is_file():
        return ""
    content = Path(path).read_text(encoding="utf-8", errors="replace").splitlines()
    return "\n".join(content[-lines:])