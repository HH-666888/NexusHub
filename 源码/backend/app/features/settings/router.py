"""设置路由（契约书 §5.5）。

- GET /settings
- PUT /settings
"""

from fastapi import APIRouter

router = APIRouter(prefix="/settings", tags=["settings"])
