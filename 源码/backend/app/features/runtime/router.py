"""内部运行时接口（契约书 §5.9）。

浏览器不会调这里：调用方是 Next 侧的流水线，负责把"数据库 + 容器 + 验证"跑起来。
全部端点都过 `require_internal_token`；没有口令一律 503，口令不对 401。
"""

from fastapi import APIRouter, Depends, Response
from sqlalchemy.orm import Session

from app.deps import get_db, require_internal_token
from app.features.runtime import docker, service
from app.features.runtime.repo import SqlRuntimeRepo
from app.features.runtime.schemas import (
    CreateDatabaseRequest,
    DatabaseInfo,
    RuntimeInfo,
    RuntimeStatus,
    StartRequest,
    Verdict,
)
from app.shared.time import now_ms

# 旧的运行时接口（/runtime/*）：保留给已有测试与内部脚本，新代码请用
# POST/GET /runs/{run_id}/runtime。已从 OpenAPI 文档里隐藏，避免和主接口混淆。
router = APIRouter(
    prefix="/runtime",
    include_in_schema=False,
    tags=["runtime"],
    dependencies=[Depends(require_internal_token)],
)


@router.post("/databases", status_code=201, response_model=DatabaseInfo)
def create_database(payload: CreateDatabaseRequest, db: Session = Depends(get_db)) -> DatabaseInfo:
    """建库建账号。同一 run 重复调用返回同一份凭据（幂等）。"""
    record = service.ensure_database(SqlRuntimeRepo(db), run_id=payload.run_id, now=now_ms())
    db.commit()
    return DatabaseInfo(db_name=record.db_name, db_url=service.product_url(record.db_name))


@router.delete("/databases/{run_id}", status_code=204)
def delete_database(run_id: str, db: Session = Depends(get_db)) -> Response:
    """回收。没建过也算成功。"""
    service.drop_database(SqlRuntimeRepo(db), run_id=run_id, now=now_ms())
    db.commit()
    return Response(status_code=204)


@router.post("/{run_id}/start", status_code=201, response_model=RuntimeInfo)
def start_runtime(run_id: str, payload: StartRequest, db: Session = Depends(get_db)) -> RuntimeInfo:
    """起产物容器。同一 run 已在跑就直接返回同一条记录（幂等）。"""
    record = service.start_runtime(
        SqlRuntimeRepo(db),
        run_id=run_id,
        files_dir=payload.files_dir,
        now=now_ms(),
    )
    db.commit()
    return RuntimeInfo(
        container_id=record.container_id,
        host_port=record.host_port,
        preview_url=record.preview_url,
        status=record.status,
    )


@router.post("/{run_id}/stop", status_code=204)
def stop_runtime(run_id: str, db: Session = Depends(get_db)) -> Response:
    service.stop_runtime(SqlRuntimeRepo(db), run_id=run_id, now=now_ms())
    db.commit()
    return Response(status_code=204)


@router.get("/{run_id}/status", response_model=RuntimeStatus)
def runtime_status(run_id: str, db: Session = Depends(get_db)) -> RuntimeStatus:
    """状态以数据库记录为准；容器可能已经因为 --rm 消失，这时报 exited。"""
    record = SqlRuntimeRepo(db).find_runtime(run_id)
    if record is None:
        return RuntimeStatus(status="none")
    status = record.status
    if status == "running":
        status = docker.container_status(record.container_id)
    return RuntimeStatus(status=status, preview_url=record.preview_url, exit_code=None)


@router.post("/{run_id}/verify", response_model=Verdict)
def verify_run(run_id: str, db: Session = Depends(get_db)) -> Verdict:
    """三层验证。跑完有失败项也返回 200：让调用方拿到完整报告而不是一个错误码。"""
    verdict = service.verify_run(SqlRuntimeRepo(db), run_id=run_id)
    return verdict
