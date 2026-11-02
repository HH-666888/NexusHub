"""运行时的业务：建库、回收。

三条硬约束（契约 §5.9）：
1. **幂等**：同一 run 重复调用返回同一份记录，不重复建库。
2. **最小权限**：库名固定 `nexus_run_` 前缀；产物账号只在这个命名空间里有权限，
   `nexus` 主库它连 SELECT 都会被拒（测过，见 tests/api/test_runtime_database.py）。
3. **标识符全部自己生成**：库名来自 run_id 的哈希，不让调用方影响一段标识符。

为什么不建"每 run 一个 MySQL 用户"：MySQL 要求授出者自己先持有该权限，
而供给账号在运行期新建的库它自己还没有授权，GRANT 必报 1044。
绕法（全局授权 / root 存储过程）都比共享账号更糟，理由写在 002_provisioner.sql 里。
"""

import hashlib
import re

from sqlalchemy import create_engine
from sqlalchemy.engine import Engine

from app.config import get_settings
from app.features.runtime.repo import DatabaseRecord, SqlRuntimeRepo
from app.shared.errors import AppError

# run_id 进 SQL 之前只允许这些字符；与前端 isSafePathSegment 的口径一致
RUN_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,26}$")

_engine: Engine | None = None


def provisioner_engine() -> Engine:
    """供给账号的连接池。没配就明确报错，而不是悄悄拿主库账号去建库。"""
    global _engine
    url = get_settings().mysql_provisioner_url
    if not url:
        raise AppError("RUNTIME_UNAVAILABLE", "未配置 MYSQL_PROVISIONER_URL，无法建库", 503)
    if _engine is None:
        _engine = create_engine(url, pool_pre_ping=True, future=True)
    return _engine


def reset_engine() -> None:
    """测试换库时用：丢掉旧连接池。"""
    global _engine
    if _engine is not None:
        _engine.dispose()
    _engine = None


def database_name(run_id: str) -> str:
    """库名：`nexus_run_<sha256 前 8 位>`。

    用哈希而不是 run_id 本身：库名要短、要小写，也不能让调用方影响标识符。
    """
    if not RUN_ID_PATTERN.match(run_id):
        raise AppError("BAD_REQUEST", f"runId 不合法：{run_id}", 400)
    digest = hashlib.sha256(run_id.encode()).hexdigest()[:8]
    return f"nexus_run_{digest}"


def product_url(db_name: str) -> str:
    """给容器用的连接串。

    主机写 host.docker.internal：容器里的 127.0.0.1 是它自己，不是宿主。
    """
    base = get_settings().mysql_product_url
    if not base:
        raise AppError("RUNTIME_UNAVAILABLE", "未配置 MYSQL_PRODUCT_URL，产物连不上库", 503)
    return f"{base.rstrip('/')}/{db_name}?charset=utf8mb4"


def ensure_database(repo: SqlRuntimeRepo, *, run_id: str, now: int) -> DatabaseRecord:
    """确保这个 run 有库。已有且没被回收就直接返回。"""
    existing = repo.find_database(run_id)
    if existing is not None and existing.dropped_at is None:
        return existing

    db_name = database_name(run_id)
    product = get_settings().mysql_product_url
    # 记录里留一份产物账号，方便出问题时看出"这个库是谁在用"
    db_user = _user_of(product)
    db_password = _password_of(product)

    try:
        _run_ddl(
            provisioner_engine(),
            [
                f"CREATE DATABASE IF NOT EXISTS `{db_name}` "
                "DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci",
            ],
        )
    except AppError:
        raise
    except Exception as exc:  # noqa: BLE001 —— 供给失败统一转成契约里的错误码
        raise AppError("DB_PROVISION_FAILED", f"建库失败：{exc}", 500) from exc

    return repo.insert_database(
        run_id=run_id, db_name=db_name, db_user=db_user, db_password=db_password, now=now
    )


def drop_database(repo: SqlRuntimeRepo, *, run_id: str, now: int) -> None:
    """回收。没建过、或已经回收过，都算成功（幂等）。"""
    existing = repo.find_database(run_id)
    if existing is None or existing.dropped_at is not None:
        return

    try:
        _run_ddl(provisioner_engine(), [f"DROP DATABASE IF EXISTS `{existing.db_name}`"])
    except Exception as exc:  # noqa: BLE001
        raise AppError("DB_PROVISION_FAILED", f"删库失败：{exc}", 500) from exc

    repo.mark_database_dropped(run_id, now)


def _user_of(dsn: str) -> str:
    match = re.match(r"^[^:]+://([^:]+):", dsn)
    return match.group(1) if match else ""


def _password_of(dsn: str) -> str:
    match = re.match(r"^[^:]+://[^:]+:([^@]+)@", dsn)
    return match.group(1) if match else ""


def _run_ddl(engine: Engine, statements: list[str]) -> None:
    """用裸 DBAPI 游标执行 DDL。

    不参数化：语句里没有任何用户输入（库名是哈希出来的），
    走 text() 反而会把 SQL 里的 `%` 当占位符。
    """
    connection = engine.raw_connection()
    try:
        cursor = connection.cursor()
        for statement in statements:
            cursor.execute(statement)
        connection.commit()
    finally:
        connection.close()
