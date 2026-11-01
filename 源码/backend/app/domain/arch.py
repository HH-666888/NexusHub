"""架构定型产物（契约书 §8；字段细节待 docs/08-阶段产物契约 定稿）。"""

from app.domain.base import ApiModel
from app.domain.spec import AppSpec


class ArchModule(ApiModel):
    id: str
    name: str
    responsibility: str
    depends_on: list[str] = []
    covers_features: list[str] = []


class ArchPackage(ApiModel):
    name: str
    why: str


class ArchSpec(ApiModel):
    modules: list[ArchModule] = []
    packages: list[ArchPackage] = []
    spec: AppSpec
    model: str
    generated_at: int
