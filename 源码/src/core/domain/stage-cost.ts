/**
 * 按阶段归集花费
 * ============================================================
 * cost_records 表每一行都带 stage 字段 —— 也就是说分阶段的花费
 * **本来就记着**，只是界面上没用上。
 *
 * ── 为什么这件事值得单独一个文件 ──
 *   之前界面上有两个假数字，都出在这里：
 *     一、每道工序旁边写死「¥0.0000」
 *     二、把整次运行的总数挂在某一个阶段旁边，
 *        让人以为那笔钱是这一道工序花的
 *
 *   两个问题的根子是同一个：**没有真的去读分阶段的账**。
 *   抽成纯函数之后，「哪笔钱算在哪道工序」这件事可以被测试钉住，
 *   而不是靠在界面上摆一个看起来像模像样的数字。
 */

import type { CostRecord } from "./cost";
import type { StageId } from "../pipeline/stages";

export interface StageCost {
  /** 该阶段累计花费（元） */
  costCny: number;
  /** 该阶段发生了多少次模型调用 */
  calls: number;
  /** 该阶段累计输出 token。用来解释「为什么这一步贵」 */
  outputTokens: number;
  /** 该阶段累计耗时（毫秒） */
  latencyMs: number;
  /**
   * 记账时用的计价档位。
   * 高峰与空闲价差一倍，不记下来的话，事后复盘会以为
   * 「同样的活儿这次怎么贵了一倍」是模型变笨了。
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
 * 把成本流水按阶段归集。
 *
 * 认不出的阶段名直接丢掉而不是塞进一个「其它」桶：
 * 那些多半是探测脚本这类没有运行归属的调用，
 * 混进来会让「这次运行各阶段花了多少」对不上总数，
 * 而账对不上比少几个数字更麻烦。
 */
export function groupCostByStage(records: readonly CostRecord[]): CostByStage {
  const known = new Set<string>([
    "spec",
    "arch",
    "ui",
    "build",
    "assemble",
    "verify",
  ]);

  const out: CostByStage = {};

  for (const r of records) {
    const stage = r.stage;
    if (!stage || !known.has(stage)) continue;

    const key = stage as StageId;
    const prev = out[key] ?? EMPTY;
    out[key] = {
      costCny: prev.costCny + r.costCny,
      calls: prev.calls + 1,
      // 用量是嵌套的 —— 成本记录的形状是「一次调用 → 一行账」，
      // 用量整体作为一个字段存着
      outputTokens: prev.outputTokens + r.usage.outputTokens,
      latencyMs: prev.latencyMs + r.latencyMs,
      // priceTier 在类型上是 string（数据库里也是文本列），
      // 这里收窄成两档；认不出的当作空闲价，宁可少报也不虚报
      tiers: [...prev.tiers, r.priceTier === "peak" ? "peak" : "offPeak"],
    };
  }

  return out;
}

/** 某道工序花了多少。没花过就是 0 —— 调用方据此决定显不显示 */
export function costOf(stage: StageId, byStage: CostByStage): number {
  return byStage[stage]?.costCny ?? 0;
}

/**
 * 归集出来的总额。
 *
 * 用来和 runs.totalCostCny 对账：两者不等就说明有流水漏了或者阶段名对不上。
 * 界面上不显示这个数，它是给测试和排查用的。
 */
export function totalOf(byStage: CostByStage): number {
  let sum = 0;
  for (const v of Object.values(byStage)) sum += v?.costCny ?? 0;
  return sum;
}

/* ============================================================
   显示文案
   ============================================================ */

/**
 * 阶段花费的一行字。
 *
 * 没花过钱就返回 null，**不返回「¥0.0000」**——
 * 「这一步不花钱」和「花了零元」在界面上长得一样，
 * 但前者是事实，后者是编的。
 */
export function describeStageCost(byStage: CostByStage, stage: StageId): string | null {
  const s = byStage[stage];
  if (!s || s.costCny <= 0) return null;
  const parts = [`¥${s.costCny.toFixed(4)}`];
  if (s.calls > 1) parts.push(`${s.calls} 次调用`);
  return parts.join(" · ");
}

/** 这个阶段所处的是高峰还是空闲计价。混着出现过就说明有跨段 */
export function describePriceTier(byStage: CostByStage, stage: StageId): string | null {
  const s = byStage[stage];
  if (!s || s.tiers.length === 0) return null;
  const peak = s.tiers.filter((t) => t === "peak").length;
  if (peak === 0) return "空闲价";
  if (peak === s.tiers.length) return "高峰价";
  return "跨峰谷";
}