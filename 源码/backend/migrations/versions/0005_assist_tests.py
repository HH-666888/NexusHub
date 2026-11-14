"""辅助开发测试用例。

Revision ID: 0005
Revises: 0004
"""

import os
from pathlib import Path

from alembic import op

from migrations.sql_loader import split_statements

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def _schema_path() -> Path:
    override = os.environ.get("NEXUS_TESTS_SQL")
    if override:
        return Path(override)
    return Path(__file__).resolve().parents[3] / "database" / "schema" / "006_assist_tests.sql"


def upgrade() -> None:
    for statement in split_statements(_schema_path().read_text(encoding="utf-8")):
        op.execute(statement)


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS assist_test_cases")