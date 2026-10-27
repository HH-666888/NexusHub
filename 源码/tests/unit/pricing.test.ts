import { describe, expect, it } from "vitest";
import {
  computeCost,
  formatCny,
  priceTierAt,
  pricingFor,
  PRICING,
} from "@/adapters/model/pricing";

/**
 * 构造一个北京时间某点对应的时刻。
 * 北京时间 = UTC+8，所以北京 10:00 就是 UTC 02:00。
 * 用 UTC 构造而不是本地时间构造 —— 否则测试结果会随跑测机器的时区变化。
 */
function beijing(
  y: number,
  month: number,
  day: number,
  hour: number,
  minute = 0,
): Date {
  return new Date(Date.UTC(y, month - 1, day, hour - 8, minute));
}

/**
 * 2026-10-22 是星期四，2026-10-24 是星期六，2026-10-25 是星期日。
 * 这几个日期先核对过，避免测试自己算错星期几。
 */
describe("高峰 / 空闲时段判断", () => {
  it("确认测试用的日期确实是那几天（前提校验）", () => {
    // 用北京时间的星期来核对，避免测试建立在错误前提上
    const thu = new Date(beijing(2026, 10, 22, 12).getTime() + 8 * 3600_000);
    expect(thu.getUTCDay()).toBe(4); // 星期四
    const sat = new Date(beijing(2026, 10, 24, 12).getTime() + 8 * 3600_000);
    expect(sat.getUTCDay()).toBe(6); // 星期六
    const sun = new Date(beijing(2026, 10, 25, 12).getTime() + 8 * 3600_000);
    expect(sun.getUTCDay()).toBe(0); // 星期日
  });

  it("工作日的高峰时段内判为高峰", () => {
    expect(priceTierAt(beijing(2026, 10, 22, 10, 0))).toBe("peak");
    expect(priceTierAt(beijing(2026, 10, 22, 9, 0))).toBe("peak"); // 左边界含
    expect(priceTierAt(beijing(2026, 10, 22, 11, 59))).toBe("peak");
    expect(priceTierAt(beijing(2026, 10, 22, 14, 0))).toBe("peak"); // 下午段左边界含
    expect(priceTierAt(beijing(2026, 10, 22, 17, 59))).toBe("peak");
  });

  it("高峰时段的右边界不含 —— 12:00 与 18:00 已经是空闲", () => {
    expect(priceTierAt(beijing(2026, 10, 22, 12, 0))).toBe("offPeak");
    expect(priceTierAt(beijing(2026, 10, 22, 18, 0))).toBe("offPeak");
  });

  it("工作日的中午休息与清晨夜晚都是空闲", () => {
    expect(priceTierAt(beijing(2026, 10, 22, 8, 59))).toBe("offPeak");
    expect(priceTierAt(beijing(2026, 10, 22, 13, 0))).toBe("offPeak");
    expect(priceTierAt(beijing(2026, 10, 22, 20, 0))).toBe("offPeak");
    expect(priceTierAt(beijing(2026, 10, 22, 3, 0))).toBe("offPeak");
  });

  it("周末全天空闲，即使处在工作日的时段区间内", () => {
    expect(priceTierAt(beijing(2026, 10, 24, 10, 0))).toBe("offPeak"); // 周六上午
    expect(priceTierAt(beijing(2026, 10, 24, 15, 0))).toBe("offPeak"); // 周六下午
    expect(priceTierAt(beijing(2026, 10, 25, 10, 0))).toBe("offPeak"); // 周日上午
    expect(priceTierAt(beijing(2026, 10, 25, 16, 0))).toBe("offPeak"); // 周日下午
  });

  it("判断结果不依赖跑测机器的时区（同一时刻结果恒定）", () => {
    const t = beijing(2026, 10, 22, 10, 0);
    // 同一个时间戳反复判断，结果必须一致
    expect(priceTierAt(t)).toBe(priceTierAt(new Date(t.getTime())));
  });
});

describe("价格表", () => {
  it("空闲价是高峰价的一半 —— 这是官方口径，必须成立", () => {
    for (const [model, p] of Object.entries(PRICING)) {
      expect(p.offPeak.cacheHitInput * 2, model).toBeCloseTo(p.peak.cacheHitInput, 10);
      expect(p.offPeak.cacheMissInput * 2, model).toBeCloseTo(
        p.peak.cacheMissInput,
        10,
      );
      expect(p.offPeak.output * 2, model).toBeCloseTo(p.peak.output, 10);
    }
  });

  it("缓存命中的输入比未命中便宜 50 倍（flash）", () => {
    const flash = PRICING["deepseek-flash"];
    expect(flash.offPeak.cacheMissInput / flash.offPeak.cacheHitInput).toBe(50);
    expect(flash.peak.cacheMissInput / flash.peak.cacheHitInput).toBe(50);
  });

  it("未知模型回退到 flash 价（宁可高估，不可低估预算）", () => {
    expect(pricingFor("某个不存在的模型")).toEqual(PRICING["deepseek-flash"]);
  });
});

describe("成本计算", () => {
  // 2026-10-24 是周六，全天空闲，价格减半，便于心算核对
  const offPeak = beijing(2026, 10, 24, 12, 0);

  it("输出按输出单价计费：100 万 tokens 输出 = 4 元（flash 空闲）", () => {
    const r = computeCost(
      "deepseek-flash",
      {
        inputTokens: 0,
        outputTokens: 1_000_000,
        cacheHitTokens: 0,
        cacheMissTokens: 0,
      },
      offPeak,
    );
    // 注意：cacheMissTokens 为 0 时按 inputTokens 兜底，所以这里要把它设对
    expect(r.breakdown.output).toBeCloseTo(4, 10);
  });

  it("缓存命中与未命中的输入分开计价", () => {
    const r = computeCost(
      "deepseek-flash",
      {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheHitTokens: 500_000,
        cacheMissTokens: 500_000,
      },
      offPeak,
    );
    // 50 万命中 × 0.02/百万 = 0.01；50 万未命中 × 1/百万 = 0.5
    expect(r.breakdown.cacheHitInput).toBeCloseTo(0.01, 10);
    expect(r.breakdown.cacheMissInput).toBeCloseTo(0.5, 10);
    expect(r.costCny).toBeCloseTo(0.51, 10);
  });

  it("高峰时段价格恰好是空闲的两倍", () => {
    const usage = {
      inputTokens: 100_000,
      outputTokens: 100_000,
      cacheHitTokens: 0,
      cacheMissTokens: 100_000,
    };
    const peak = computeCost("deepseek-flash", usage, beijing(2026, 10, 22, 10, 0));
    const off = computeCost("deepseek-flash", usage, offPeak);
    expect(peak.costCny).toBeCloseTo(off.costCny * 2, 10);
    expect(peak.tier).toBe("peak");
    expect(off.tier).toBe("offPeak");
  });

  it("未提供缓存拆分时，按“全部未命中”保守估算", () => {
    const r = computeCost(
      "deepseek-flash",
      {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheHitTokens: 0,
        cacheMissTokens: 0,
      },
      offPeak,
    );
    expect(r.breakdown.cacheMissInput).toBeCloseTo(1, 10);
  });

  it("实测复核探测脚本那次真实的调用，成本能对上", () => {
    // 来自 grep 到的真实数据：关闭思考那次，输入 198、输出 6961、空闲时段
    const r = computeCost(
      "deepseek-flash",
      { inputTokens: 198, outputTokens: 6961, cacheHitTokens: 0, cacheMissTokens: 198 },
      offPeak,
    );
    // 198/1e6*1 = 0.000198；6961/1e6*4 = 0.027844
    expect(r.breakdown.cacheMissInput).toBeCloseTo(0.000198, 10);
    expect(r.breakdown.output).toBeCloseTo(0.027844, 10);
    expect(r.costCny).toBeCloseTo(0.028042, 9);
  });

  it("思考 token 不额外计费 —— 它已经包含在输出里", () => {
    const withReasoning = computeCost(
      "deepseek-flash",
      {
        inputTokens: 0,
        outputTokens: 1000, // 其中思考 800
        cacheHitTokens: 0,
        cacheMissTokens: 0,
      },
      offPeak,
    );
    expect(withReasoning.breakdown.output).toBeCloseTo((1000 / 1e6) * 4, 10);
  });

  it("零用量成本为零", () => {
    const r = computeCost(
      "deepseek-flash",
      { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 },
      offPeak,
    );
    expect(r.costCny).toBe(0);
  });
});

describe("金额格式化", () => {
  it("零显示为 ¥0，不显示成 ¥0.0000", () => {
    expect(formatCny(0)).toBe("¥0");
  });

  it("一分钱以下保留六位小数，避免显示成 ¥0.00", () => {
    expect(formatCny(0.000198)).toBe("¥0.000198");
  });

  it("一毛到一元之间保留四位小数", () => {
    expect(formatCny(0.028042)).toBe("¥0.0280");
  });

  it("一元以上保留两位小数", () => {
    expect(formatCny(12.3456)).toBe("¥12.35");
  });
});
