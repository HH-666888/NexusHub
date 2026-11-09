"""记账：每次模型调用写一条 cost_records，并累加到 runs.total_cost_cny。

不做汇总缓存，不估算：金额 = usage × 单价。
"""

from __future__ import annotations

from sqlalchemy.orm import Session

from app.db.models import CostRecord, Run
from app.shared.time import now_ms
from app.v2.ai.cost.pricing import cost_cny, price_of
from app.v2.ai.model.client import ModelReply


def record_cost(
    db: Session,
    *,
    run_id: str,
    stage: str,
    reply: ModelReply,
) -> float:
    price = price_of(reply.model)
    amount = cost_cny(reply.model, reply.prompt_tokens, reply.completion_tokens)

    db.add(
        CostRecord(
            run_id=run_id,
            stage=stage,
            model=reply.model,
            price_tier=price.tier,
            input_tokens=reply.prompt_tokens,
            output_tokens=reply.completion_tokens,
            thinking_tokens=0,
            cache_hit_tokens=0,
            cost_cny=amount,
            latency_ms=reply.latency_ms,
            created_at=now_ms(),
        )
    )
    run = db.get(Run, run_id)
    if run is not None:
        run.total_cost_cny = float(run.total_cost_cny or 0) + amount
        run.updated_at = now_ms()
    db.commit()
    return amount