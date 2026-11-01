"""应用装配：注册路由、挂异常处理、暴露健康检查。

不放业务。业务在 features/*/service.py，工序在 pipeline/。
"""

from fastapi import Depends, FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session
from starlette.exceptions import HTTPException as StarletteHTTPException

from app import __version__
from app.config import get_settings
from app.deps import get_db
from app.features.artifacts.router import router as artifacts_router
from app.features.auth.router import router as auth_router
from app.features.gate.router import router as gate_router
from app.features.runs.router import router as runs_router
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
    ):
        app.include_router(router, prefix=API_PREFIX)

    @app.get(f"{API_PREFIX}/health", tags=["health"])
    def health(db: Session = Depends(get_db)) -> dict[str, object]:
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

    return app


app = create_app()
