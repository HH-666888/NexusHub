"""内部运行时接口（契约书 §5.9）。

浏览器不会调这里：调用方是 Next 侧的流水线，负责把"数据库 + 容器 + 验证"跑起来。
只监听本机；每个请求都要求 `x-internal-token`（在 service 里校验）。
"""

from fastapi import APIRouter

router = APIRouter(prefix="/runtime", tags=["runtime"])
