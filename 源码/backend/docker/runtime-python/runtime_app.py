"""运行入口包装：一个端口同时给出页面与接口。

产物只有两样东西：`api/main.py`（FastAPI 应用）与 `web/index.html`（静态页）。
直接 `uvicorn api.main:app` 只能拿到接口，打开预览地址会看到 404 ——
所以起服务前写这么一层：根路径给页面，其余全部交给产物应用。

为什么不改产物代码：那是模型写的、可能被重新生成；这层是我们的，稳定且只要几行。
"""

from __future__ import annotations

import pathlib

from api.main import app as product_app
from fastapi import FastAPI
from fastapi.responses import HTMLResponse

ROOT = pathlib.Path(__file__).parent
PAGE = ROOT / "web" / "index.html"

app = FastAPI(title="nexus-runtime", docs_url=None, redoc_url=None, openapi_url=None)


@app.get("/", response_class=HTMLResponse)
def index() -> HTMLResponse:
    """首页永远是产物页面；没写出来时给一句人能看懂的话。"""
    if not PAGE.exists():
        return HTMLResponse("<h1>还没有生成页面</h1>", status_code=200)
    return HTMLResponse(PAGE.read_text(encoding="utf-8"))


# 其余路径全给产物应用：/health 与 /api/* 都在它里面
app.mount("/", product_app)
