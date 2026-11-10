"""应用装配：注册路由、挂异常处理、暴露健康检查。

不放业务。业务在 features/*/service.py，工序在 pipeline/。
"""

from pathlib import Path

from fastapi import Request, Depends, FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy.orm import Session
from starlette.exceptions import HTTPException as StarletteHTTPException

from app import __version__
from app.config import get_settings
from app.deps import get_db
from app.domain.health import HealthStatus
from app.features.artifacts.router import router as artifacts_router
from app.features.auth.router import router as auth_router
from app.features.gate.router import router as gate_router
from app.features.runs.router import router as runs_router
from app.features.runtime.router import router as runtime_router
from app.features.settings.router import router as settings_router
from app.features.stream.router import router as stream_router
from app.shared.errors import (
    AppError,
    app_error_handler,
    http_exception_handler,
    unhandled_error_handler,
    validation_exception_handler,
)
from app.shared.health import build_health

API_PREFIX = "/api/v1"


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

    for router in (
        auth_router,
        runs_router,
        gate_router,
        stream_router,
        artifacts_router,
        settings_router,
        runtime_router,
    ):
        app.include_router(router, prefix=API_PREFIX)

    # v2 路由（与 v1 并存，互不影响）
    from app.v2 import router as v2_router
    app.include_router(v2_router, prefix="/api/v2")

    @app.get(f"{API_PREFIX}/health", tags=["health"], response_model=HealthStatus)
    def health(db: Session = Depends(get_db)) -> HealthStatus:
        return build_health(db)

    # 同源部署（前端 rewrite 到本服务）不需要 CORS；只有本地两端不同端口时才开
    if settings.allowed_origin:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=[settings.allowed_origin],
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )

    # 静态站：源码/web（页面、样式、脚本都由这里托管）。
    # 必须挂最后 —— 挂载在 "/" 会接管所有未命中的路径，/api/v1 由上面的路由先匹配。
    web_dir = Path(__file__).resolve().parents[2] / "web"

    @app.middleware("http")
    async def _cache_policy(request: Request, call_next):
        """HTML 每次重新校验，带 ?v= 的静态资源才允许长缓存。

        否则改完样式刷新还是旧的——前端已经踩过这个坑。
        """
        response = await call_next(request)
        content_type = response.headers.get("content-type", "")
        # 文本类资源（html / css / js / json）一律每次校验，避免"改了看不到"；
        # 图片、字体这类二进制仍可长缓存。
        if content_type.startswith("text/") or "javascript" in content_type:
            response.headers["Cache-Control"] = "no-cache"
        return response

    @app.get("/", include_in_schema=False)
    def _root_to_v2():
        # v2 是默认入口；旧站保留在 /v1/
        return RedirectResponse(url="/v2/", status_code=307)

    # ── v2 双轨：/v2 必须挂在 "/" 之前，否则会被旧站截走 ──
    web_v2_dir = Path(__file__).resolve().parents[2] / "web-v2"
    if web_v2_dir.is_dir():
        app.mount("/v2", StaticFiles(directory=str(web_v2_dir), html=True), name="web_v2")

    if web_dir.is_dir():
        app.mount("/v1", StaticFiles(directory=str(web_dir), html=True), name="web_v1")

    return app


app = create_app()
