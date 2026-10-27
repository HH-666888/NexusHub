/**
 * 按阶段归集花费。cost_records 每行都带 stage，分阶段的账本来就记着。
 * 界面上曾把 ¥0.0000 写死、也把总数挂在某一阶段旁边，根子都是没真去读这份账。
 * 抽成纯函数之后，哪笔钱算在哪道工序可以被测试钉住。
 */

import type { CostRecord } from "./cost";
import type { StageId } from "../pipeline/stages";

export interface StageCost {
  /** 累计花费（元） */
  costCny: number;
  /** 模型调用次数 */
  calls: number;
  /** 累计输出 token，用来解释这一步为什么贵 */
  outputTokens: number;
  /** 累计耗时（毫秒） */
  latencyMs: number;
  /**
   * 记账时的计价档位。高峰与空闲价差一倍，不记下来复盘时会以为模型变笨了。
   */
  tiers: Array<"peak" | "offPeak">;
}

export type CostByStage = Partial<Record<StageId, StageCost>>;

const EMPTY: StageCost = {
  costCny: 0,
  calls: 0,
  outputTokens: 0,
  latencyMs: 0,
  tiers: [],
};

/**
 * 按阶段归集。认不出的阶段名直接丢掉而不是塞进其它桶：
 * 那些多是探测脚本这类没有运行归属的调用，混进来会让各阶段对不上总数。
 */
export function groupCostByStage(records: readonly CostRecord[]): CostByStage {
  const known = new Set<string>(["spec", "arch", "ui", "build", "assemble", "verify"]);

  const out: CostByStage = {};

  for (const r of records) {
    const stage = r.stage;
    if (!stage || !known.has(stage)) continue;

    const key = stage as StageId;
    const prev = out[key] ?? EMPTY;
    out[key] = {
      costCny: prev.costCny + r.costCny,
      calls: prev.calls + 1,
      // 用量整体作为一个字段存着（一次调用对应一行账）
      outputTokens: prev.outputTokens + r.usage.outputTokens,
      latencyMs: prev.latencyMs + r.latencyMs,
      // priceTier 在类型与库里都是字符串，这里收窄成两档；
      // 认不出的按空闲价算：宁可少报也不虚报
      tiers: [...prev.tiers, r.priceTier === "peak" ? "peak" : "offPeak"],
    };
  }

  return out;
}

/** 某道工序花了多少，没花过就是 0 */
export function costOf(stage: StageId, byStage: CostByStage): number {
  return byStage[stage]?.costCny ?? 0;
}

/**
 * 归集总额，用来和 runs.totalCostCny 对账：不等就说明有流水漏了或阶段名对不上。
 * 界面不显示，给测试与排查用。
 */
export function totalOf(byStage: CostByStage): number {
  let sum = 0;
  for (const v of Object.values(byStage)) sum += v?.costCny ?? 0;
  return sum;
}

/**
 * 阶段花费的一行字。没花过钱返回 null，不返回 ¥0.0000：
 * 这一步不花钱与花了零元在界面上长得一样，但只有前者是事实。
 */
export function describeStageCost(byStage: CostByStage, stage: StageId): string | null {
  const s = byStage[stage];
  if (!s || s.costCny <= 0) return null;
  const parts = [`¥${s.costCny.toFixed(4)}`];
  if (s.calls > 1) parts.push(`${s.calls} 次调用`);
  return parts.join(" · ");
}

/** 高峰还是空闲计价；混着出现说明跨峰谷 */
export function describePriceTier(byStage: CostByStage, stage: StageId): string | null {
  const s = byStage[stage];
  if (!s || s.tiers.length === 0) return null;
  const peak = s.tiers.filter((t) => t === "peak").length;
  if (peak === 0) return "空闲价";
  if (peak === s.tiers.length) return "高峰价";
  return "跨峰谷";
}
