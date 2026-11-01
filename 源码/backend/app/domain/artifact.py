"""产物（契约书 §8.3）。

内容存库不落磁盘（数据库契约 §3.6），所以这里没有 path，只有 name：
`spec.json`、`arch.json`、`ui-spec.json`、`manifest.json`、`plan.html`、`modules/<id>.json`。
"""

from enum import StrEnum

from app.domain.base import ApiModel


class ArtifactKind(StrEnum):
    HTML = "html"
    JSON = "json"


class Artifact(ApiModel):
    id: int
    run_id: str
    kind: ArtifactKind
    name: str
    bytes: int
    sha256: str
    created_at: int
