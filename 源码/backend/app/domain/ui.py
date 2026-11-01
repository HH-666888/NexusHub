"""界面设计产物（契约书 §8；字段细节待 docs/08-阶段产物契约 定稿）。"""

from app.domain.arch import ArchSpec
from app.domain.base import ApiModel
from app.domain.spec import AppSpec


class DesignToken(ApiModel):
    name: str
    value: str


class UiPage(ApiModel):
    id: str
    name: str
    route: str
    covers_features: list[str] = []
    data_needs: list[str] = []


class UiComponent(ApiModel):
    id: str
    name: str
    used_on: list[str] = []
    uses_tokens: list[str] = []


class UiSpec(ApiModel):
    tokens: list[DesignToken] = []
    pages: list[UiPage] = []
    components: list[UiComponent] = []
    user_input: str
    spec: AppSpec
    arch: ArchSpec
