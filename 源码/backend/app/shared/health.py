"""健康检查（契约书 §5.5）。

`db` 字段必须如实反映数据库连通性：连不上时返回 `db: "down"`，
让前端显示明确错误，而不是白屏。**HTTP 状态仍是 200** —— 这是活性探针，
数据库断了不代表进程死了；要判断能否服务，看 `db` 字段。
"""

from sqlalchemy import text
from sqlalchemy.orm import Session

from app import __version__


def build_health(db: Session) -> dict[str, object]:
    try:
        db.execute(text("SELECT 1"))
        db_status = "ok"
    except Exception:  # noqa: BLE001 —— 探针不该因为任何数据库异常而抛出去
        db_status = "down"

    return {"ok": db_status == "ok", "version": __version__, "db": db_status}
