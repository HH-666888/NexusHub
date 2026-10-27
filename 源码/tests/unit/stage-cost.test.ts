/**
 * 保护分阶段花费的归集、对账与显示口径：没花过钱是 null，不是零。
 */

import { describe, expect, it } from "vitest";
import {
  costOf,
  describePriceTier,
  describeStageCost,
  groupCostByStage,
  totalOf,
} from "@/core/domain/stage-cost";
import type { CostRecord } from "@/core/domain/cost";

function rec(over: Partial<CostRecord>): CostRecord {
  return {
    id: 1,
    runId: "run-1",
    stage: "build",
    nodeId: null,
    tier: "execute",
    model: "m",
    purpose: "p",
    // 用量是嵌套的字段，不是摊平的列
    usage: {
      inputTokens: 100,
      outputTokens: 200,
      reasoningTokens: 0,
      cacheHitTokens: 0,
      cacheMissTokens: 100,
    },
    costCny: 0.01,
    priceTier: "offPeak",
    latencyMs: 800,
    createdAt: 0,
    ...over,
  };
}

/** 换掉用量里的某一项，其余不变 */
function withUsage(over: Partial<CostRecord["usage"]>): Partial<CostRecord> {
  return {
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheHitTokens: 0,
      cacheMissTokens: 0,
      ...over,
    },
  };
}

describe("分阶段花费 · 归集", () => {
  it("同阶段的多次调用累加", () => {
    const by = groupCostByStage([
      rec({ stage: "build", costCny: 0.01 }),
      rec({ stage: "build", costCny: 0.02, ...withUsage({ outputTokens: 500 }) }),
    ]);
    expect(by.build?.costCny).toBeCloseTo(0.03, 6);
    expect(by.build?.calls).toBe(2);
    expect(by.build?.outputTokens).toBe(700);
  });

  it("不同阶段分开记 —— 这才是「钱花在哪一步」", () => {
    const by = groupCostByStage([
      rec({ stage: "spec", costCny: 0.005 }),
      rec({ stage: "build", costCny: 0.02 }),
    ]);
    expect(costOf("spec", by)).toBeCloseTo(0.005, 6);
    expect(costOf("build", by)).toBeCloseTo(0.02, 6);
  });

  it("没花过钱的阶段是 0，不凭空造一条记录", () => {
    const by = groupCostByStage([rec({ stage: "spec" })]);
    expect(costOf("build", by)).toBe(0);
    expect(by.build).toBeUndefined();
  });

  it("认不出的阶段名丢掉，不塞进「其它」桶", () => {
    // 探测脚本这类没有运行归属的调用会带奇怪或空的 stage。
    // 混进来会让各阶段之和对不上总数，账对不上比少几个数字更麻烦。
    const by = groupCostByStage([
      rec({ stage: "build", costCny: 0.02 }),
      rec({ stage: "probe", costCny: 99 }),
      rec({ stage: null, costCny: 99 }),
      rec({ stage: "", costCny: 99 }),
    ]);
    expect(totalOf(by)).toBeCloseTo(0.02, 6);
    expect(Object.keys(by)).toEqual(["build"]);
  });

  it("累计耗时也归集 —— 用来解释「为什么这一步慢」", () => {
    const by = groupCostByStage([
      rec({ stage: "build", latencyMs: 1000 }),
      rec({ stage: "build", latencyMs: 2500 }),
    ]);
    expect(by.build?.latencyMs).toBe(3500);
  });

  it("计价档位按次保留，因为峰谷价差一倍", () => {
    const by = groupCostByStage([
      rec({ stage: "build", priceTier: "offPeak" }),
      rec({ stage: "build", priceTier: "peak" }),
    ]);
    expect(by.build?.tiers).toEqual(["offPeak", "peak"]);
  });

  it("空流水归集出空结果", () => {
    expect(groupCostByStage([])).toEqual({});
    expect(totalOf({})).toBe(0);
  });
});

describe("分阶段花费 · 对账", () => {
  it("归集总额等于各条流水之和", () => {
    const records = [
      rec({ stage: "spec", costCny: 0.005 }),
      rec({ stage: "build", costCny: 0.02 }),
      rec({ stage: "verify", costCny: 0.001 }),
    ];
    expect(totalOf(groupCostByStage(records))).toBeCloseTo(0.026, 6);
  });
});

describe("分阶段花费 · 显示", () => {
  it("【关键】没花过钱时返回 null，不返回 ¥0.0000", () => {
  // 没花过钱返回 null，而不是 ¥0.0000：前者是事实，后者是编的。
    expect(describeStageCost({}, "build")).toBeNull();
    const zero = groupCostByStage([rec({ stage: "build", costCny: 0 })]);
    expect(describeStageCost(zero, "build")).toBeNull();
  });

  it("花过钱时给出金额", () => {
    const by = groupCostByStage([rec({ stage: "build", costCny: 0.0256 })]);
    expect(describeStageCost(by, "build")).toBe("¥0.0256");
  });

  it("多次调用时带上次数 —— 用户才知道钱是怎么堆起来的", () => {
    const by = groupCostByStage([
      rec({ stage: "build", costCny: 0.01 }),
      rec({ stage: "build", costCny: 0.01 }),
      rec({ stage: "build", costCny: 0.01 }),
    ]);
    expect(describeStageCost(by, "build")).toContain("3 次调用");
  });

  it("计价档位说得清楚", () => {
    const off = groupCostByStage([rec({ priceTier: "offPeak" })]);
    const peak = groupCostByStage([rec({ priceTier: "peak" })]);
    const both = groupCostByStage([
      rec({ priceTier: "peak" }),
      rec({ priceTier: "offPeak" }),
    ]);
    expect(describePriceTier(off, "build")).toBe("空闲价");
    expect(describePriceTier(peak, "build")).toBe("高峰价");
    expect(describePriceTier(both, "build")).toBe("跨峰谷");
  });

  it("没记录时档位返回 null", () => {
    expect(describePriceTier({}, "build")).toBeNull();
  });
});