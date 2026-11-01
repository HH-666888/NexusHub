"""MCP 工具服务入口。

后续用官方 MCP SDK 暴露工具（读文件 / 跑检查 / 开预览），由 `app/ai/agent/mcp/client.py`
作为客户端连上来。**现在还没有实现**，所以直接退出而不是假装起了一个服务。

为什么单独一个进程：工具执行与 API 进程隔离，一个工具跑飞了不会拖垮整个后端。
"""

from __future__ import annotations

import sys


def main() -> int:
    sys.stderr.write("MCP 服务尚未实现；随 RAG / Agent 能力一并落地（见 docs/04-目录结构.md）。\n")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
