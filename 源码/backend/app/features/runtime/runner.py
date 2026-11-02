"""运行器选择：容器版与进程版共用同一套调用。

上层（service）只认这里的四个函数，不关心底下是 docker 还是进程。
默认 docker —— 没有隔离的进程版必须由配置显式打开。
"""

from app.config import get_settings
from app.features.runtime import docker, process_runner


def selected() -> str:
    return "process" if get_settings().runtime_runner == "process" else "docker"


def available() -> bool:
    return docker.docker_available() if selected() == "docker" else True


def start(files_dir: str, host_port: int, database_url: str) -> str:
    """起产物，返回一个 handle（容器 id 或 proc:<pid>）。"""
    if selected() == "process":
        return process_runner.start(files_dir, host_port, database_url)
    return docker.run_container(
        docker.RunSpec(
            run_id=_run_id_of(files_dir),
            files_dir=files_dir,
            host_port=host_port,
            database_url=database_url,
        )
    )


def stop(handle: str, files_dir: str) -> None:
    if process_runner.is_process_handle(handle):
        process_runner.stop(handle)
        return
    docker.stop_container(handle)


def is_running(handle: str) -> bool:
    if process_runner.is_process_handle(handle):
        return process_runner.is_running(handle)
    return docker.container_status(handle) == "running"


def logs(handle: str, files_dir: str, *, tail: int = 40) -> str:
    if process_runner.is_process_handle(handle):
        return process_runner.logs(files_dir, tail=tail)
    return docker.container_logs(handle, tail=tail)


def _run_id_of(files_dir: str) -> str:
    """工作区最后一段就是 runId —— 容器名与网络名都靠它，别另传一遍。"""
    return files_dir.replace("\\", "/").rstrip("/").split("/")[-1]
