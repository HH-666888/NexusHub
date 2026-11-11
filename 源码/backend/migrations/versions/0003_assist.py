"""辅助开发与 AI 记忆四张表。

Revision ID: 0003
Revises: 0002
Create Date: 2026-11-11

DDL 唯一来源：`database/schema/004_assist.sql`。
"""

import os
from pathlib import Path

from alembic import op

from migrations.sql_loader import split_statements

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None

TABLES_IN_DROP_ORDER = ("memory_entries", "assist_findings", "assist_files", "assist_projects")


def _schema_path() -> Path:
    override = os.environ.get("NEXUS_ASSIST_SQL")
    if override:
        return Path(override)
    return Path(__file__).resolve().parents[3] / "database" / "schema" / "004_assist.sql"


def upgrade() -> None:
    sql = _schema_path().read_text(encoding="utf-8")
    for statement in split_statements(sql):
        op.execute(statement)


def downgrade() -> None:
    for table in TABLES_IN_DROP_ORDER:
        op.execute(f"DROP TABLE IF EXISTS {table}")