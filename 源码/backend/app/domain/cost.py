"""成本（契约书 §8.3）。

一次模型调用一行。不做"只记汇总"——历史教训是汇总值会把明细覆盖掉，
那样"每一分钱花在哪"就再也答不上来了。
"""

from enum import StrEnum

from app.domain.base import ApiModel


class PriceTier(StrEnum):
    PEAK = "peak"
    OFF_PEAK = "offPeak"


class CostRecord(ApiModel):
    run_id: str
    stage: str
    model: str
    price_tier: PriceTier
    input_tokens: int = 0
    output_tokens: int = 0
    thinking_tokens: int = 0
    cache_hit_tokens: int = 0
    cost_cny: float
    latency_ms: int
    created_at: int
