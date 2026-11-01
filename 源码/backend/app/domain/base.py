"""对外模型的基类。

Python 侧写 snake_case，JSON 侧输出 camelCase（契约书 §1 的 R4）：
`total_cost_cny` → `totalCostCny`。这样两端字段名一致，而代码仍然符合 PEP 8。
"""

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel


class ApiModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)
