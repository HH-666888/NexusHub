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
import pathlib
import re

from sqlalchemy import create_engine
from sqlalchemy.engine import Engine

from app.config import get_settings
from app.features.runtime import docker, runner
from app.features.runtime.docker import RunSpec
from app.features.runtime.ports import allocate_port
from app.features.runtime.repo import DatabaseRecord, RuntimeRecord, SqlRuntimeRepo
from app.features.runtime.schemas import Verdict
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


def _checked_files_dir(files_dir: str) -> str:
    """只允许挂载工作区里的目录。

    这是安全边界：filesDir 由调用方给，若不校验，请求方就能让容器挂载
    /etc、/root 之类的宿主目录（只读也够糟）。所以这里必须做前缀校验。
    """
    root = pathlib.Path(get_settings().runtime_workspace_dir).resolve()
    target = pathlib.Path(files_dir).resolve()
    if root != target and root not in target.parents:
        raise AppError("BAD_REQUEST", f"filesDir 不在工作区内：{files_dir}", 400)
    if not target.is_dir():
        raise AppError("BAD_REQUEST", f"filesDir 不存在：{files_dir}", 400)
    return str(target)


def start_runtime(repo: SqlRuntimeRepo, *, run_id: str, files_dir: str, now: int) -> RuntimeRecord:
    """起产物容器：确保库 → 分端口 → 起容器 → 等 /health → 记账。

    幂等：同一个 run 已经在跑就直接返回既有记录，不再起第二个容器。
    """
    existing = repo.find_runtime(run_id)
    if existing is not None and existing.status == "running":
        return existing

    # 先校验入参：坏路径是 400，不该因为"本机没 docker"而变成 503
    checked_dir = _checked_files_dir(files_dir)

    # 顺手回收过期运行：上一个演示跑完没人管时，这里把它清掉
    reap_stale(repo, now=now)

    if not runner.available():
        raise AppError(
            "RUNTIME_UNAVAILABLE",
            "本机没有可用的 docker；开发机可设 RUNTIME_RUNNER=process 用进程版顶一下",
            503,
        )
    database = ensure_database(repo, run_id=run_id, now=now)
    # 先建表再起容器：接口启动时表就该在那儿，否则 /health 过了、列表接口照样 500
    apply_schema(
        checked_dir, product_url(database.db_name).replace("host.docker.internal", "127.0.0.1")
    )
    port = allocate_port()
    spec = RunSpec(
        run_id=run_id,
        files_dir=checked_dir,
        host_port=port,
        database_url=product_url(database.db_name),
    )

    try:
        container_id = runner.start(checked_dir, port, spec.database_url)
    except Exception as exc:  # noqa: BLE001
        raise AppError("RUNTIME_UNAVAILABLE", f"容器启动失败：{exc}", 500) from exc

    # 先落一条 creating：容器起来了但还没通过 /health 时，界面也能看到"正在启动"
    repo.upsert_runtime(
        run_id=run_id,
        container_id=container_id,
        host_port=port,
        preview_url=f"http://127.0.0.1:{port}",
        status="creating",
        now=now,
    )

    if not docker.wait_healthy(port):
        logs = runner.logs(container_id, checked_dir)
        runner.stop(container_id, checked_dir)
        if docker.docker_available():
            docker.remove_network(run_id)
        repo.mark_runtime_stopped(run_id, status="exited", now=now, error=logs[-500:])
        raise AppError("RUNTIME_TIMEOUT", f"容器 60 秒内没通过 /health：{logs[-300:]}", 504)

    return repo.upsert_runtime(
        run_id=run_id,
        container_id=container_id,
        host_port=port,
        preview_url=f"http://127.0.0.1:{port}",
        status="running",
        now=now,
    )


def stop_runtime(repo: SqlRuntimeRepo, *, run_id: str, now: int) -> None:
    """停容器并清理网络。没起过、或已经停过，都算成功（幂等）。"""
    record = repo.find_runtime(run_id)
    if record is None or record.status != "running":
        return

    runner.stop(record.container_id, _run_files_dir(run_id))
    if docker.docker_available():
        docker.remove_network(run_id)
    repo.mark_runtime_stopped(run_id, status="exited", now=now)


# 一次产物最多跑这么久：到点回收容器与库（比赛演示够用，也不做后台线程）
RUNTIME_TTL_MS = 30 * 60 * 1000


def reap_stale(repo: SqlRuntimeRepo, *, now: int) -> int:
    """回收过期运行：先停容器，再删库。

    在 start_runtime 开头顺手调用一次 —— 10 个用户的规模不需要后台守护线程，
    但可能"上一个演示跑完没人管"，这一下就把它清掉。
    """
    reaped = 0
    for record in repo.list_running():
        if now - record.started_at < RUNTIME_TTL_MS:
            continue
        files_dir = _run_files_dir(record.run_id)
        runner.stop(record.container_id, files_dir)
        if docker.docker_available():
            docker.remove_network(record.run_id)
        repo.mark_runtime_stopped(record.run_id, status="killed", now=now)
        drop_database(repo, run_id=record.run_id, now=now)
        reaped += 1
    return reaped


def verify_run(repo: SqlRuntimeRepo, *, run_id: str) -> Verdict:
    """跑三层验证并把 verdict.json 写进这个 run 的工作区。

    数据库与预览地址都从数据库记录里取，不让调用方传 —— 传进来的东西一旦对不上，
    验证的就是另一个东西了。
    """
    from app.features.runtime import verify as verify_module

    runtime = repo.find_runtime(run_id)
    if runtime is None or runtime.status != "running":
        raise AppError("RUNTIME_UNAVAILABLE", "这个运行还没有跑起来", 409)

    database = repo.find_database(run_id)
    if database is None or database.dropped_at is not None:
        raise AppError("RUNTIME_UNAVAILABLE", "这个运行没有可用的数据库", 409)

    # 产物库在宿主上验证：容器里的 host.docker.internal 在这里要换回本机
    db_url = product_url(database.db_name).replace("host.docker.internal", "127.0.0.1")
    verdict = verify_module.verify_all(preview_url=runtime.preview_url, db_url=db_url)

    workspace = pathlib.Path(get_settings().runtime_workspace_dir).resolve() / run_id
    workspace.mkdir(parents=True, exist_ok=True)
    (workspace / "verdict.json").write_text(
        verdict.model_dump_json(by_alias=True, indent=2) + "\n", encoding="utf-8"
    )
    return verdict


def apply_schema(files_dir: str, db_url: str) -> int:
    """把产物里的建表脚本与种子数据执行到 run 自己的库上。

    为什么在这里做、而不是在容器里做：产物后端只管跑接口，不该有建表权限；
    而"表没建"是链路里最容易漏的一环 —— 漏了就会表现成接口 500，
    排查时还以为是模型写错了代码。

    返回执行成功的语句条数。
    """
    root = pathlib.Path(files_dir)
    statements: list[str] = []
    for name in ("db/schema.sql", "db/seed.sql"):
        file = root / name
        if not file.exists():
            continue
        for raw in file.read_text(encoding="utf-8").split(";"):
            statement = raw.strip()
            if statement:
                statements.append(statement)

    if not statements:
        raise AppError("DB_PROVISION_FAILED", "产物里没有可执行的建表脚本", 400)

    engine = create_engine(db_url)
    executed = 0
    try:
        with engine.begin() as conn:
            for statement in statements:
                conn.exec_driver_sql(statement)
                executed += 1
    except Exception as exc:  # noqa: BLE001
        raise AppError("DB_PROVISION_FAILED", f"执行建表脚本失败：{exc}", 400) from exc
    finally:
        engine.dispose()
    return executed


def _run_files_dir(run_id: str) -> str:
    """某个 run 的工作区绝对路径。停进程与看日志都要它。"""
    return str(pathlib.Path(get_settings().runtime_workspace_dir).resolve() / run_id)
