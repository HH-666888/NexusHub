"""初始表结构。

Revision ID: 0001
Revises:
Create Date: 2026-11-01

表结构的唯一来源是 `docs/05-数据库契约.md`，可执行版本是
`database/schema/001_init.sql`。这里只负责把它跑一遍，不再抄第二份 DDL ——
抄两份一定会漂移。
"""

import os
from pathlib import Path

from alembic import op

from migrations.sql_loader import split_statements

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None

# 删表顺序与建表顺序相反，先删引用方
TABLES_IN_DROP_ORDER = (
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


def _schema_path() -> Path:
    """允许用环境变量覆盖（容器里目录结构不同），默认按仓库布局推导。"""
    override = os.environ.get("NEXUS_SCHEMA_SQL")
    if override:
        return Path(override)
    return Path(__file__).resolve().parents[3] / "database" / "schema" / "001_init.sql"


def upgrade() -> None:
    sql = _schema_path().read_text(encoding="utf-8")
    for statement in split_statements(sql):
        op.execute(statement)


def downgrade() -> None:
    for table in TABLES_IN_DROP_ORDER:
        op.execute(f"DROP TABLE IF EXISTS {table}")