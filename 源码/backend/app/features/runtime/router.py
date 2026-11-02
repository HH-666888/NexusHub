"""内部运行时接口（契约书 §5.9）。

浏览器不会调这里：调用方是 Next 侧的流水线，负责把"数据库 + 容器 + 验证"跑起来。
全部端点都过 `require_internal_token`；没有口令一律 503，口令不对 401。
"""

from fastapi import APIRouter, Depends, Response
from sqlalchemy.orm import Session

from app.deps import get_db, require_internal_token
from app.features.runtime import service
from app.features.runtime.repo import SqlRuntimeRepo
from app.features.runtime.schemas import CreateDatabaseRequest, DatabaseInfo
from app.shared.time import now_ms

router = APIRouter(
    prefix="/runtime",
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
