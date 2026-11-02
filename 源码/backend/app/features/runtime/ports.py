"""端口分配。

Windows 上只看 bind 是不够的：它允许对已被监听的端口再 bind 一次（和 Unix 不同）。
所以先用"能不能连上"判断占用，再用 bind 兜底。
"""

import socket

# 宿主端口段：够 100 个产物，也不占 root 才能绑的低端口
PORT_RANGE_START = 50000
PORT_RANGE_END = 50100


def port_in_use(port: int) -> bool:
    """有人在这个端口上监听吗。"""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(0.2)
        if probe.connect_ex(("127.0.0.1", port)) == 0:
            return True

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        try:
            probe.bind(("127.0.0.1", port))
        except OSError:
            return True
    return False


def allocate_port(start: int = PORT_RANGE_START, end: int = PORT_RANGE_END) -> int:
    """在端口段里找一个能用的。找不到就报错，而不是硬塞一个多半会冲突的。"""
    for port in range(start, end + 1):
        if not port_in_use(port):
            return port
    raise RuntimeError(f"端口段 {start}-{end} 已用尽")
