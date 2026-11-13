"""应用装配：注册路由、挂异常处理、托管前端。

只有一份真实源码：前端在 `源码/web`，接口在 `/api`。
原型站已移到仓库根目录的 `原型动画/`，不参与这里。
"""

from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

from app import __version__
from app.api import router as api_router
from app.config import get_settings
from app.shared.errors import (
    AppError,
    app_error_handler,
    http_exception_handler,
    unhandled_error_handler,
    validation_exception_handler,
)

API_PREFIX = "/api"


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="Nexus API",
        version=__version__,
        openapi_url=f"{API_PREFIX}/openapi.json",
        docs_url=f"{API_PREFIX}/docs",
        redoc_url=None,
    )

    app.add_exception_handler(AppError, app_error_handler)
    app.add_exception_handler(StarletteHTTPException, http_exception_handler)
    app.add_exception_handler(RequestValidationError, validation_exception_handler)
    app.add_exception_handler(Exception, unhandled_error_handler)

    app.include_router(api_router, prefix=API_PREFIX)

    # 同源部署不需要 CORS；只有本地两端不同端口时才开
    if settings.allowed_origin:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=[settings.allowed_origin],
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )

    web_dir = Path(__file__).resolve().parents[2] / "web"

    @app.middleware("http")
    async def _cache_policy(request: Request, call_next):
        """HTML 每次重新校验，带 ?v= 的静态资源才允许长缓存。"""
        response = await call_next(request)
        content_type = response.headers.get("content-type", "")
        if content_type.startswith("text/") or "javascript" in content_type:
            response.headers["Cache-Control"] = "no-cache"
        return response

    # 最后挂静态站："/" 会接管所有未命中的路径，/api 由上面的路由先匹配。
    if web_dir.is_dir():
        app.mount("/", StaticFiles(directory=str(web_dir), html=True), name="web")

    return app


app = create_app()