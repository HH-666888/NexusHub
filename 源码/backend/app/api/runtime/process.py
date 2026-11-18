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
    """挑一个真正空的端口。

    Windows 上 SO_REUSEADDR 允许重复绑定已在用的端口，拿它探测会把
    "别的运行正在服务的端口" 判成可用 —— 新进程随后绑不上直接退出，
    而 wait_http 探测到的其实是上一个应用。所以这里先探是否有人在听，
    再用独占方式绑定。
    """
    for port in range(start, start + 500):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.settimeout(0.2)
            if probe.connect_ex(("127.0.0.1", port)) == 0:
                continue
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
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


def wait_http(url: str, timeout: float = 20.0, process: subprocess.Popen | None = None) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        # 进程已经退出就别再探测：端口上应答的可能是别的运行留下的服务
        if process is not None and process.poll() is not None:
            return False
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


def _win_pid_open(pid: int) -> bool:
    """Windows 下用内核句柄判断进程是否存活。

    不再解析 tasklist 的本地化文本：在受限环境里那条命令会返回空输出，
    `str(pid) in stdout` 就会抛 "argument of type 'NoneType' is not iterable"，
    把整个「停止预览 / 删除运行」接口打成 500。
    """
    try:
        import ctypes

        handle = ctypes.windll.kernel32.OpenProcess(0x1000, False, int(pid))
        if not handle:
            return False
        ctypes.windll.kernel32.CloseHandle(handle)
        return True
    except Exception:
        return False


def pid_alive(pid: int) -> bool:
    """进程还在不在。跨平台：能查到就不是僵尸，查不到就当已退出。"""
    if pid <= 0:
        return False
    if sys.platform == "win32":
        return _win_pid_open(pid)
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def terminate_pid(pid: int) -> None:
    """按 PID 收掉一个进程。后端重启后 _PREVIEWS 是空的，只能靠 PID。"""
    if not pid_alive(pid):
        return
    if sys.platform == "win32":
        try:
            subprocess.run(  # noqa: S603
                ["taskkill", "/F", "/PID", str(pid)], capture_output=True, timeout=10
            )
        except (OSError, subprocess.SubprocessError):
            pass
        # taskkill 也可能被环境拦掉，最后用内核调用兜底，不能留下孤儿进程
        if pid_alive(pid):
            try:
                import ctypes

                handle = ctypes.windll.kernel32.OpenProcess(0x0001, False, int(pid))
                if handle:
                    ctypes.windll.kernel32.TerminateProcess(handle, 1)
                    ctypes.windll.kernel32.CloseHandle(handle)
            except Exception:
                pass
        return
    try:
        os.kill(pid, 15)
    except OSError:
        return


def log_tail(process: subprocess.Popen, lines: int = 12) -> str:
    path = getattr(process, "_log_path", None)
    if path is None or not Path(path).is_file():
        return ""
    content = Path(path).read_text(encoding="utf-8", errors="replace").splitlines()
    return "\n".join(content[-lines:])