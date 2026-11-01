"""健康检查的响应形状（契约书 §5.5）。

声明成模型而不是返回裸 dict：前端类型是从 OpenAPI 生成的，裸 dict 会退化成
`{[key: string]: unknown}`，等于没有类型约束。
"""

from typing import Literal

from app.domain.base import ApiModel


class HealthStatus(ApiModel):
    ok: bool
    version: str
    db: Literal["ok", "down"]
