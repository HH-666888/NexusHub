"""把产物的建表脚本执行到 run 自己的库上。

这一环最容易漏：漏了以后 /health 是 200、列表接口却 500，
排查时会先怀疑模型写错了代码。所以单独测它。
"""

from pathlib import Path

import pytest
from sqlalchemy import create_engine, inspect, text

from app.config import get_settings
from app.features.runtime import service
from app.features.runtime.service import apply_schema
from app.shared.errors import AppError

pytestmark = pytest.mark.integration

SCHEMA = """
CREATE TABLE IF NOT EXISTS todos (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  title VARCHAR(64) NOT NULL
);
"""

SEED = """
INSERT INTO todos (title) VALUES ('买牛奶'), ('写周报');
"""


@pytest.fixture(autouse=True)
def _env(monkeypatch: pytest.MonkeyPatch) -> None:
    get_settings.cache_clear()
    service.reset_engine()
    yield
    get_settings.cache_clear()
    service.reset_engine()


@pytest.fixture
def run_dir(tmp_path: Path) -> Path:
    db_dir = tmp_path / "r_schema_0001" / "db"
    db_dir.mkdir(parents=True)
    (db_dir / "schema.sql").write_text(SCHEMA, encoding="utf-8")
    (db_dir / "seed.sql").write_text(SEED, encoding="utf-8")
    return tmp_path / "r_schema_0001"


def _provision(run_id: str) -> tuple[str, str]:
    """建一个真库，返回 (库名, 宿主可用的连接串)。"""
    from app.db.session import SessionLocal
    from app.features.runtime.repo import SqlRuntimeRepo

    with SessionLocal() as session:
        repo = SqlRuntimeRepo(session)
        record = service.ensure_database(repo, run_id=run_id, now=1_793_600_000_000)
        session.commit()
    url = service.product_url(record.db_name).replace("host.docker.internal", "127.0.0.1")
    return record.db_name, url


def _drop(run_id: str) -> None:
    from app.db.session import SessionLocal
    from app.features.runtime.repo import SqlRuntimeRepo

    with SessionLocal() as session:
        service.drop_database(SqlRuntimeRepo(session), run_id=run_id, now=1_793_600_000_000)
        session.commit()


def test_apply_schema_creates_tables_and_seeds(run_dir: Path) -> None:
    db_name, db_url = _provision("r_schema_0001")
    try:
        executed = apply_schema(str(run_dir), db_url)

        # schema 一条 + seed 一条
        assert executed == 2
        engine = create_engine(db_url)
        try:
            assert "todos" in inspect(engine).get_table_names()
            with engine.connect() as conn:
                count = conn.execute(text("SELECT COUNT(*) FROM todos")).scalar_one()
            assert count == 2
        finally:
            engine.dispose()
    finally:
        _drop("r_schema_0001")


def test_apply_schema_rejects_missing_script(tmp_path: Path) -> None:
    (tmp_path / "empty").mkdir()

    with pytest.raises(AppError) as excinfo:
        apply_schema(str(tmp_path / "empty"), "sqlite://")

    assert excinfo.value.code == "DB_PROVISION_FAILED"


def test_apply_schema_reports_broken_sql(run_dir: Path) -> None:
    db_name, db_url = _provision("r_schema_0002")
    try:
        (run_dir / "db" / "schema.sql").write_text("CREATE TABLE (broken", encoding="utf-8")

        with pytest.raises(AppError) as excinfo:
            apply_schema(str(run_dir), db_url)

        assert excinfo.value.code == "DB_PROVISION_FAILED"
        assert "建表脚本" in excinfo.value.message
    finally:
        _drop("r_schema_0002")
