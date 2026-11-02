"""docker 参数拼装与端口分配。

这些断言都是"改坏了会被发现"的：少一个资源限制、少一个只读挂载、
端口分配撞车——每一条都能在事故前拦住。
"""

import socket

import pytest

from app.features.runtime.docker import CONTAINER_PORT, RunSpec, build_run_args
from app.features.runtime.service import allocate_port

SPEC = RunSpec(
    run_id="r_abc123",
    files_dir="/srv/workspace/r_abc123",
    host_port=50123,
    database_url="mysql+pymysql://u:p@host.docker.internal:3306/nexus_run_x?charset=utf8mb4",
)


def test_run_args_pin_every_resource_limit() -> None:
    args = build_run_args(SPEC)
    joined = " ".join(args)

    for required in ("--cpus=1", "--memory=1g", "--pids-limit=200", "--read-only"):
        assert required in args, required
    assert "--tmpfs" in args
    # 自定义网络 + 宿主别名：能连 MySQL，出不去外网（出网规则由 DOCKER-USER 链管）
    assert "nexus-net-r_abc123" in args
    assert "host.docker.internal:host-gateway" in args
    assert "/srv/workspace/r_abc123:/app:ro" in args
    assert f"127.0.0.1:{SPEC.host_port}:{CONTAINER_PORT}" in args
    assert "nexus.run_id=r_abc123" in args
    assert joined.endswith("nexus-runtime-py312")


def test_run_args_pass_database_url_as_env_only() -> None:
    args = build_run_args(SPEC)

    # 连接串只出现在环境变量里，不许进命令行参数之外的位置（日志会打到命令行）
    assert f"DATABASE_URL={SPEC.database_url}" in args


def test_run_args_are_detached_and_self_cleaning() -> None:
    args = build_run_args(SPEC)

    assert "--detach" in args
    assert "--rm" in args
    assert f"nexus-run-{SPEC.run_id}" in args


def test_allocate_port_skips_busy_port() -> None:
    """占住一个端口后，分配器必须绕开它。"""
    holder = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    holder.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    holder.bind(("127.0.0.1", 0))
    holder.listen(1)
    busy = holder.getsockname()[1]

    try:
        allocated = allocate_port(start=busy, end=busy + 5)
        assert allocated != busy
    finally:
        holder.close()


def test_allocate_port_raises_when_range_exhausted() -> None:
    holder = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    holder.bind(("127.0.0.1", 0))
    holder.listen(1)
    busy = holder.getsockname()[1]

    try:
        with pytest.raises(RuntimeError):
            allocate_port(start=busy, end=busy)
    finally:
        holder.close()
