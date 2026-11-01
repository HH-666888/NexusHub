"""统一错误信封（契约书 §4.2）。

所有非 2xx 都长成这样：

    {"error": {"code": "UNAUTHORIZED", "message": "未登录", "hint": "请先登录"}}

`message` 给人看，`code` 给程序判断。前端只许按 code 分支。
"""

from typing import Any

from fastapi import Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException


class AppError(Exception):
    """业务错误的唯一载体。路由里不要直接返回 JSONResponse 表达失败。"""

    def __init__(
        self,
        code: str,
        message: str,
        status: int = 400,
        hint: str | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.hint = hint

    def to_body(self) -> dict[str, Any]:
        error: dict[str, Any] = {"code": self.code, "message": self.message}
        if self.hint:
            error["hint"] = self.hint
        return {"error": error}


def bad_request(message: str, hint: str | None = None) -> AppError:
    return AppError("BAD_REQUEST", message, 400, hint)


def unauthorized(message: str = "未登录", hint: str | None = None) -> AppError:
    return AppError("UNAUTHORIZED", message, 401, hint)


def not_found(message: str = "找不到该构建") -> AppError:
    """资源不存在**或不属于当前用户**都返回 404 —— 不泄露 id 是否存在。"""
    return AppError("NOT_FOUND", message, 404)


def conflict(message: str) -> AppError:
    return AppError("CONFLICT", message, 409)


def upstream(message: str) -> AppError:
    return AppError("UPSTREAM", message, 502)


async def app_error_handler(_request: Request, exc: AppError) -> JSONResponse:
    return JSONResponse(status_code=exc.status, content=exc.to_body())


# HTTP 状态码 → 契约里的 code。FastAPI/Starlette 自己抛的错也要走同一个信封，
# 否则前端会同时面对 {"detail": …} 和 {"error": …} 两种形状。
_STATUS_TO_CODE: dict[int, str] = {
    400: "BAD_REQUEST",
    401: "UNAUTHORIZED",
    403: "FORBIDDEN",
    404: "NOT_FOUND",
    405: "METHOD_NOT_ALLOWED",
    409: "CONFLICT",
    410: "GONE",
    413: "TOO_LARGE",
    422: "VALIDATION_FAILED",
    429: "RATE_LIMITED",
    500: "INTERNAL",
    502: "UPSTREAM",
}


async def http_exception_handler(_request: Request, exc: StarletteHTTPException) -> JSONResponse:
    code = _STATUS_TO_CODE.get(exc.status_code, "INTERNAL")
    message = exc.detail if isinstance(exc.detail, str) else "请求失败"
    body = {"error": {"code": code, "message": message}}
    return JSONResponse(status_code=exc.status_code, content=body)


async def validation_exception_handler(
    _request: Request, exc: RequestValidationError
) -> JSONResponse:
    """字段级错误要能指到具体哪一项，否则前端只能提示"参数不对"。"""
    details = [
        {"field": ".".join(str(part) for part in error["loc"][1:]), "message": error["msg"]}
        for error in exc.errors()
    ]
    return JSONResponse(
        status_code=422,
        content={
            "error": {
                "code": "VALIDATION_FAILED",
                "message": "请求参数不合法",
                "details": details,
            }
        },
    )


async def unhandled_error_handler(_request: Request, exc: Exception) -> JSONResponse:
    """兜底：绝不把堆栈返回给前端。日志里有，响应里没有。"""
    return JSONResponse(
        status_code=500,
        content={"error": {"code": "INTERNAL", "message": "服务内部错误"}},
    )
