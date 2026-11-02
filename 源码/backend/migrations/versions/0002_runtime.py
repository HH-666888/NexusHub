"""全栈运行时的两张表。

Revision ID: 0002
Revises: 0001
Create Date: 2026-11-02

表结构同样只有一份来源：`database/schema/002_runtime.sql`。
"""

import os
from pathlib import Path

from alembic import op

from migrations.sql_loader import split_statements

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None

TABLES_IN_DROP_ORDER = ("run_runtimes", "run_databases")


def _schema_path() -> Path:
    override = os.environ.get("NEXUS_RUNTIME_SQL")
    if override:
        return Path(override)
    return Path(__file__).resolve().parents[3] / "database" / "schema" / "002_runtime.sql"


def upgrade() -> None:
    sql = _schema_path().read_text(encoding="utf-8")
    for statement in split_statements(sql):
        op.execute(statement)


def downgrade() -> None:
    for table in TABLES_IN_DROP_ORDER:
        op.execute(f"DROP TABLE IF EXISTS {table}")