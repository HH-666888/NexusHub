"""辅助开发用量记录。

Revision ID: 0004
Revises: 0003
Create Date: 2026-11-13
"""

import os
from pathlib import Path

from alembic import op

from migrations.sql_loader import split_statements

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None

TABLES_IN_DROP_ORDER = ("usage_records",)


def _schema_path() -> Path:
    override = os.environ.get("NEXUS_USAGE_SQL")
    if override:
        return Path(override)
    return Path(__file__).resolve().parents[3] / "database" / "schema" / "005_usage.sql"


def upgrade() -> None:
    sql = _schema_path().read_text(encoding="utf-8")
    for statement in split_statements(sql):
        op.execute(statement)


def downgrade() -> None:
    for table in TABLES_IN_DROP_ORDER:
        op.execute(f"DROP TABLE IF EXISTS {table}")