"""集成测试的公共装置：跑在真实的 MySQL 上（`nexus_test` 库）。

为什么要单独一个库：测试会清表。指到开发库上，跑一次测试就把演示数据清了。

**必须在 import 应用之前设置 DATABASE_URL** —— 引擎是在模块导入时按配置创建的，
晚一步设置就会连到开发库上。
"""

import os

os.environ.setdefault(
    "DATABASE_URL",
    "mysql+pymysql://nexus:nexus@127.0.0.1:3306/nexus_test?charset=utf8mb4",
)

from collections.abc import Iterator  # noqa: E402

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import text  # noqa: E402

from app.db import models  # noqa: E402, F401  —— 导入以注册元数据
from app.db.base import Base  # noqa: E402
from app.db.engine import engine  # noqa: E402
from app.main import create_app  # noqa: E402

# 外键先删引用方
TABLES_IN_DELETE_ORDER = (
    "run_runtimes",
    "run_databases",
    "idempotency_keys",
    "rag_chunks",
    "rag_documents",
    "settings",
    "artifacts",
    "cost_records",
    "run_events",
    "runs",
    "sessions",
    "users",
)


@pytest.fixture(scope="session")
def client() -> Iterator[TestClient]:
    Base.metadata.create_all(engine)
    with TestClient(create_app()) as test_client:
        yield test_client


@pytest.fixture(autouse=True)
def clean_tables() -> Iterator[None]:
    yield
    with engine.begin() as conn:
        for table in TABLES_IN_DELETE_ORDER:
            conn.execute(text(f"DELETE FROM {table}"))
