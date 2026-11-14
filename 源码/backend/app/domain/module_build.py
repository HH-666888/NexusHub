"""自主开发任务的摘要（契约书 §7 的 `modules` 事件、§8）。

**只放摘要，不放代码**：代码是产物，塞进事件只会让事件表变大，
回放时没有任何一处读它（前端 `BuildBatchSummary` 的注释写得很清楚）。
"""

from app.domain.base import ApiModel


class ModuleBuildSummary(ApiModel):
    module_id: str
    name: str
    summary: str
    cost_cny: float
    # 工作台树要用：这个模块产出哪个文件、现在什么状态、写到几成
    file: str = ""
    state: str = "pending"   # pending / live / done / failed
    progress: int = 0


class ModuleBuildFailureSummary(ApiModel):
    module_id: str
    name: str
    message: str
    cost_cny: float


class BuildBatchSummary(ApiModel):
    modules: list[ModuleBuildSummary] = []
    failed: list[ModuleBuildFailureSummary] = []
    mode: str = "sequential"
    total_cost_cny: float = 0
