"""运行时接口的请求/响应形状（契约书 §5.9）。

检查项复用 `domain.check.StageCheckItem`（name / pass / detail）——
它和架构、界面检查是同一种东西，没必要再定义一遍。
"""

from typing import Literal

from app.domain.base import ApiModel
from app.domain.check import StageCheckItem


class CreateDatabaseRequest(ApiModel):
    run_id: str


class DatabaseInfo(ApiModel):
    db_name: str
    # 容器里直接可用的连接串：主机是 host.docker.internal，不是 127.0.0.1
    db_url: str


class StartRequest(ApiModel):
    files_dir: str
    # 不传就自动分配；传了就必须是空闲端口
    entry_port: int | None = None


class RuntimeInfo(ApiModel):
    container_id: str
    host_port: int
    preview_url: str
    status: str


class RuntimeStatus(ApiModel):
    status: str
    preview_url: str | None = None
    exit_code: int | None = None


class VerifyRequest(ApiModel):
    preview_url: str
    db_name: str
    db_user: str
    db_password: str


class LayerResult(ApiModel):
    layer: Literal["db", "api", "ui"]
    checks: list[StageCheckItem] = []
    passed: int
    total: int


class Verdict(ApiModel):
    layers: list[LayerResult] = []
    passed: int
    total: int
    screenshots: list[str] = []
