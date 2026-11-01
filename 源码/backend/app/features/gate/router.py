"""门禁路由（契约书 §5.3）。

- GET  /runs/{run_id}/gate
- POST /runs/{run_id}/answers
- POST /runs/{run_id}/acknowledge

路径挂在 /runs 下，所以 prefix 与 runs 相同、tags 不同。
"""

from fastapi import APIRouter

router = APIRouter(prefix="/runs", tags=["gate"])
