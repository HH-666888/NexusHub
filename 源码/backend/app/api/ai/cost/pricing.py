"""单价与峰谷。

金额单位：元 / 百万 token。
峰谷时间按北京时间；具体数值集中在这里改，别散落在业务代码里。
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, time
from zoneinfo import ZoneInfo

BEIJING = ZoneInfo("Asia/Shanghai")

# DeepSeek 官方价（示例口径，按实际账单可调）
PRICES: dict[str, dict[str, dict[str, float]]] = {
    "deepseek-chat": {
        "input": {"peak": 2.0, "offpeak": 1.0},
        "output": {"peak": 8.0, "offpeak": 4.0},
    },
    "deepseek-reasoner": {
        "input": {"peak": 4.0, "offpeak": 2.0},
        "output": {"peak": 16.0, "offpeak": 8.0},
    },
}


@dataclass(frozen=True)
class Price:
    tier: str
    in_price: float
    out_price: float


def tier_of(moment: datetime | None = None) -> str:
    """峰时 08:30–00:30，其余为谷时。"""
    now = moment.astimezone(BEIJING) if moment else datetime.now(BEIJING)
    minutes = now.hour * 60 + now.minute
    return "peak" if (8 * 60 + 30) <= minutes or minutes < 30 else "offpeak"


def price_of(model: str, moment: datetime | None = None) -> Price:
    table = PRICES.get(model) or PRICES["deepseek-chat"]
    tier = tier_of(moment)
    return Price(tier=tier, in_price=table["input"][tier], out_price=table["output"][tier])


def cost_cny(model: str, prompt_tokens: int, completion_tokens: int, moment: datetime | None = None) -> float:
    price = price_of(model, moment)
    return round(
        (prompt_tokens * price.in_price + completion_tokens * price.out_price) / 1_000_000,
        6,
    )