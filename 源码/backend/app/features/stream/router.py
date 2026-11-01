"""SSE 路由（契约书 §6）。

- GET /runs/{run_id}/stream

路由只管建流与响应头；推进逻辑在 pipeline/orchestrator。
"""

from fastapi import APIRouter

router = APIRouter(prefix="/runs", tags=["stream"])
