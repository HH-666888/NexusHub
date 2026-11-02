"""ORM 模型：只描述"怎么存"，不描述"是什么"。

字段与 `docs/05-数据库契约.md` 的 DDL 一一对应；改这里必须先改那份契约。
对外契约是 app/domain 里的 Pydantic 模型，两者之间的转换只发生在 features/*/repo.py。
"""

from sqlalchemy import (
    BigInteger,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    Numeric,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.mysql import CHAR, JSON, LONGTEXT, VARCHAR
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base

# 契约规定：id 一律小写十六进制串，用 ascii 存（比 utf8mb4 省 4 倍且比较更快）。
# 这几个参数属于 MySQL 方言，只能用方言类型（VARCHAR/CHAR），通用 String 不接受。
ASCII_KW = {"charset": "ascii", "collation": "ascii_bin"}


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    username: Mapped[str] = mapped_column(String(32), unique=True)
    display_name: Mapped[str] = mapped_column(String(64))
    password_hash: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[int] = mapped_column(BigInteger)
    updated_at: Mapped[int] = mapped_column(BigInteger)


class UserSession(Base):
    __tablename__ = "sessions"

    # 存的是 sha256(token)。token 本身只在 cookie 里出现，不落库
    id: Mapped[str] = mapped_column(CHAR(64, **ASCII_KW), primary_key=True)
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    expires_at: Mapped[int] = mapped_column(BigInteger, index=True)
    created_at: Mapped[int] = mapped_column(BigInteger)


class Run(Base):
    __tablename__ = "runs"

    id: Mapped[str] = mapped_column(VARCHAR(26, **ASCII_KW), primary_key=True)
    user_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("users.id", ondelete="CASCADE"))
    prompt: Mapped[str] = mapped_column(Text)
    stage: Mapped[str] = mapped_column(String(16))
    status: Mapped[str] = mapped_column(String(16))
    workflow_version: Mapped[str] = mapped_column(String(8), default="v1")
    total_cost_cny: Mapped[float] = mapped_column(Numeric(12, 6), default=0)
    input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0)
    thinking_tokens: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[int] = mapped_column(BigInteger)
    updated_at: Mapped[int] = mapped_column(BigInteger)

    # 游标分页按 (created_at DESC, id DESC) 走，所以索引顺序要和查询一致
    __table_args__ = (
        Index("idx_runs_user_time", "user_id", "created_at", "id"),
        Index("idx_runs_status", "status"),
    )


class RunEvent(Base):
    __tablename__ = "run_events"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    run_id: Mapped[str] = mapped_column(
        VARCHAR(26, **ASCII_KW), ForeignKey("runs.id", ondelete="CASCADE")
    )
    seq: Mapped[int] = mapped_column(Integer, comment="同一次运行内从 1 递增")
    kind: Mapped[str] = mapped_column(String(16))
    payload: Mapped[dict] = mapped_column(JSON, comment="契约书 §7 的整条事件")
    created_at: Mapped[int] = mapped_column(BigInteger)

    __table_args__ = (UniqueConstraint("run_id", "seq", name="uk_events_run_seq"),)


class CostRecord(Base):
    __tablename__ = "cost_records"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    run_id: Mapped[str] = mapped_column(
        VARCHAR(26, **ASCII_KW), ForeignKey("runs.id", ondelete="CASCADE")
    )
    stage: Mapped[str] = mapped_column(String(16))
    model: Mapped[str] = mapped_column(String(48))
    price_tier: Mapped[str] = mapped_column(String(8))
    input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0)
    thinking_tokens: Mapped[int] = mapped_column(Integer, default=0)
    cache_hit_tokens: Mapped[int] = mapped_column(Integer, default=0)
    cost_cny: Mapped[float] = mapped_column(Numeric(12, 6))
    latency_ms: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[int] = mapped_column(BigInteger)

    __table_args__ = (Index("idx_cost_run_time", "run_id", "created_at"),)


class Artifact(Base):
    __tablename__ = "artifacts"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    run_id: Mapped[str] = mapped_column(
        VARCHAR(26, **ASCII_KW), ForeignKey("runs.id", ondelete="CASCADE")
    )
    kind: Mapped[str] = mapped_column(String(8), comment="html|json")
    name: Mapped[str] = mapped_column(String(64), comment="spec.json / plan.html / …")
    content: Mapped[str] = mapped_column(LONGTEXT)
    bytes: Mapped[int] = mapped_column(Integer)
    sha256: Mapped[str] = mapped_column(CHAR(64, **ASCII_KW))
    created_at: Mapped[int] = mapped_column(BigInteger)

    __table_args__ = (UniqueConstraint("run_id", "name", name="uk_artifacts_run_name"),)


class Setting(Base):
    __tablename__ = "settings"

    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    key: Mapped[str] = mapped_column(String(32), primary_key=True)
    value: Mapped[dict] = mapped_column(JSON)
    updated_at: Mapped[int] = mapped_column(BigInteger)


class RagDocument(Base):
    __tablename__ = "rag_documents"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    path: Mapped[str] = mapped_column(String(255), unique=True)
    title: Mapped[str] = mapped_column(String(128))
    sha256: Mapped[str] = mapped_column(CHAR(64, **ASCII_KW))
    bytes: Mapped[int] = mapped_column(Integer)
    updated_at: Mapped[int] = mapped_column(BigInteger)


class RagChunk(Base):
    __tablename__ = "rag_chunks"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    document_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("rag_documents.id", ondelete="CASCADE")
    )
    chunk_index: Mapped[int] = mapped_column(Integer)
    heading: Mapped[str | None] = mapped_column(String(255), nullable=True)
    text: Mapped[str] = mapped_column(Text)
    # FLOAT32 小端序。用 BLOB 而不是 JSON：省 3–5 倍体积，也不用解析
    embedding: Mapped[bytes] = mapped_column(LargeBinary)
    dim: Mapped[int] = mapped_column(Integer)
    model: Mapped[str] = mapped_column(String(48))

    __table_args__ = (UniqueConstraint("document_id", "chunk_index", name="uk_chunk_doc_idx"),)


class IdempotencyKey(Base):
    __tablename__ = "idempotency_keys"

    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    key: Mapped[str] = mapped_column(CHAR(64, **ASCII_KW), primary_key=True)
    run_id: Mapped[str | None] = mapped_column(VARCHAR(26, **ASCII_KW), nullable=True)
    created_at: Mapped[int] = mapped_column(BigInteger)
    expires_at: Mapped[int] = mapped_column(BigInteger, index=True)


class RunDatabase(Base):
    """每个 run 的产物库与专属账号（契约 §5.9）。

    password 必须存：容器启动要注入它，服务重启后也要能重建连接。
    dropped_at 非空表示已经回收，行保留是为了查"这个 run 曾经用过哪个库"。
    """

    __tablename__ = "run_databases"

    run_id: Mapped[str] = mapped_column(VARCHAR(64, **ASCII_KW), primary_key=True)
    db_name: Mapped[str] = mapped_column(String(64), unique=True)
    db_user: Mapped[str] = mapped_column(String(64))
    db_password: Mapped[str] = mapped_column(String(128))
    created_at: Mapped[int] = mapped_column(BigInteger)
    dropped_at: Mapped[int | None] = mapped_column(BigInteger, nullable=True)


class RunRuntime(Base):
    """每个 run 的产物容器。status 取值：creating / running / exited / killed。"""

    __tablename__ = "run_runtimes"

    run_id: Mapped[str] = mapped_column(VARCHAR(64, **ASCII_KW), primary_key=True)
    container_id: Mapped[str] = mapped_column(String(64))
    host_port: Mapped[int] = mapped_column(Integer)
    preview_url: Mapped[str] = mapped_column(String(255))
    status: Mapped[str] = mapped_column(String(16), index=True)
    started_at: Mapped[int] = mapped_column(BigInteger)
    stopped_at: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    error: Mapped[str | None] = mapped_column(String(500), nullable=True)
