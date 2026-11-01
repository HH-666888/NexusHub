"""运行路由（契约书 §5.2、§5.4 的导入部分）。

- GET    /runs                 游标分页
- POST   /runs                 建运行，支持 Idempotency-Key
- GET    /runs/{run_id}
- DELETE /runs/{run_id}
- POST   /runs/import          导入 .nexus.json 包
"""

from fastapi import APIRouter

router = APIRouter(prefix="/runs", tags=["runs"])
