"""认证路由（契约书 §5.1）。

- POST /auth/register
- POST /auth/login
- POST /auth/logout
- GET  /auth/me

实现随迁移第 2 刀落地。这里先建空路由器，main.py 才能统一注册。
"""

from fastapi import APIRouter

router = APIRouter(prefix="/auth", tags=["auth"])
