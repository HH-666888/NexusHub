"""运行时的数据访问：`run_databases` 与 `run_runtimes`。

SQL 只写在这里（目录契约 D5）；对外返回 dataclass，SQLAlchemy 对象不出这一层。
"""

from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import RunDatabase, RunRuntime


@dataclass(frozen=True, slots=True)
class DatabaseRecord:
    run_id: str
    db_name: str
    db_user: str
    db_password: str
    created_at: int
    dropped_at: int | None


@dataclass(frozen=True, slots=True)
class RuntimeRecord:
    run_id: str
    container_id: str
    host_port: int
    preview_url: str
    status: str
    started_at: int
    stopped_at: int | None
    error: str | None


class SqlRuntimeRepo:
    def __init__(self, db: Session) -> None:
        self._db = db

    # ---- 数据库 ----

    def find_database(self, run_id: str) -> DatabaseRecord | None:
        row = self._db.get(RunDatabase, run_id)
        return _to_database(row) if row is not None else None

    def insert_database(
        self, *, run_id: str, db_name: str, db_user: str, db_password: str, now: int
    ) -> DatabaseRecord:
        row = self._db.get(RunDatabase, run_id)
        if row is None:
            row = RunDatabase(
                run_id=run_id,
                db_name=db_name,
                db_user=db_user,
                db_password=db_password,
                created_at=now,
                dropped_at=None,
            )
            self._db.add(row)
        else:
            # 这个 run 之前被回收过：原地复用那一行，避免主键冲突
            row.db_name = db_name
            row.db_user = db_user
            row.db_password = db_password
            row.created_at = now
            row.dropped_at = None
        self._db.flush()
        return _to_database(row)

    def mark_database_dropped(self, run_id: str, now: int) -> None:
        row = self._db.get(RunDatabase, run_id)
        if row is not None:
            row.dropped_at = now

    # ---- 容器 ----

    def find_runtime(self, run_id: str) -> RuntimeRecord | None:
        row = self._db.get(RunRuntime, run_id)
        return _to_runtime(row) if row is not None else None

    def upsert_runtime(
        self,
        *,
        run_id: str,
        container_id: str,
        host_port: int,
        preview_url: str,
        status: str,
        now: int,
    ) -> RuntimeRecord:
        row = self._db.get(RunRuntime, run_id)
        if row is None:
            row = RunRuntime(
                run_id=run_id,
                container_id=container_id,
                host_port=host_port,
                preview_url=preview_url,
                status=status,
                started_at=now,
                stopped_at=None,
                error=None,
            )
            self._db.add(row)
        else:
            row.container_id = container_id
            row.host_port = host_port
            row.preview_url = preview_url
            row.status = status
            row.started_at = now
            row.stopped_at = None
            row.error = None
        self._db.flush()
        return _to_runtime(row)

    def mark_runtime_stopped(
        self, run_id: str, *, status: str, now: int, error: str | None = None
    ) -> None:
        row = self._db.get(RunRuntime, run_id)
        if row is not None:
            row.status = status
            row.stopped_at = now
            row.error = error

    def list_running(self) -> list[RuntimeRecord]:
        rows = self._db.scalars(select(RunRuntime).where(RunRuntime.status == "running")).all()
        return [_to_runtime(row) for row in rows]


def _to_database(row: RunDatabase) -> DatabaseRecord:
    return DatabaseRecord(
        run_id=row.run_id,
        db_name=row.db_name,
        db_user=row.db_user,
        db_password=row.db_password,
        created_at=row.created_at,
        dropped_at=row.dropped_at,
    )


def _to_runtime(row: RunRuntime) -> RuntimeRecord:
    return RuntimeRecord(
        run_id=row.run_id,
        container_id=row.container_id,
        host_port=row.host_port,
        preview_url=row.preview_url,
        status=row.status,
        started_at=row.started_at,
        stopped_at=row.stopped_at,
        error=row.error,
    )
