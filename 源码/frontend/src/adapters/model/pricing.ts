/**
 * 模型计价：单价单位为元 / 百万 tokens，取自 DeepSeek 官方价格页。
 * 高峰时段为北京时间工作日 9:00-12:00 与 14:00-18:00，其余时间价格减半。
 * 缓存命中的输入价约为未命中的 1/50，把稳定系统提示词放最前是最省钱的用法。
 */

export type PriceTier = "peak" | "offPeak";

export interface ModelPrice {
  /** 输入·缓存命中（元/百万 tokens） */
  cacheHitInput: number;
  /** 输入·缓存未命中（元/百万 tokens） */
  cacheMissInput: number;
  /** 输出（元/百万 tokens） */
  output: number;
}

export interface ModelPricing {
  peak: ModelPrice;
  offPeak: ModelPrice;
}

/** 官方价格表（元/百万 tokens）；新增模型必须同时补 peak 与 offPeak */
export const PRICING: Record<string, ModelPricing> = {
  "deepseek-flash": {
    peak: { cacheHitInput: 0.04, cacheMissInput: 2, output: 8 },
    offPeak: { cacheHitInput: 0.02, cacheMissInput: 1, output: 4 },
  },
  "deepseek-v4-pro": {
    peak: { cacheHitInput: 0.3, cacheMissInput: 9, output: 27 },
    offPeak: { cacheHitInput: 0.15, cacheMissInput: 4.5, output: 13.5 },
  },
};

/** 找不到价格时按 flash 高峰价兜底：宁可高估预算，不可低估 */
const FALLBACK: ModelPricing = PRICING["deepseek-flash"];

export function pricingFor(model: string): ModelPricing {
  return PRICING[model] ?? FALLBACK;
}

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * 判断某时刻是否处于高峰时段：先用 UTC 方法取北京时间，避免服务器时区影响结果。
 * 法定节假日不单独排除，一律按高峰处理，取保守值。
 */
export function priceTierAt(at: Date): PriceTier {
  const beijing = new Date(at.getTime() + BEIJING_OFFSET_MS);
  const day = beijing.getUTCDay(); // 0=周日, 6=周六
  const hour = beijing.getUTCHours();

  // 周末全天空闲（法定节假日按高峰处理的保守简化）
  if (day === 0 || day === 6) return "offPeak";

  // 工作日：9:00-12:00 与 14:00-18:00 为高峰，左闭右开
  const inMorningPeak = hour >= 9 && hour < 12;
  const inAfternoonPeak = hour >= 14 && hour < 18;
  return inMorningPeak || inAfternoonPeak ? "peak" : "offPeak";
}

export interface CostBreakdown {
  cacheHitInput: number;
  cacheMissInput: number;
  output: number;
  total: number;
}

/**
 * 按 token 用量折算成本。reasoningTokens 不单独计价，它已包含在 outputTokens 里。
 */
export function computeCost(
  model: string,
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheHitTokens: number;
    cacheMissTokens: number;
  },
  at: Date = new Date(),
): { costCny: number; tier: PriceTier; breakdown: CostBreakdown; price: ModelPrice } {
  const tier = priceTierAt(at);
  const price = pricingFor(model)[tier];

  const perMillion = (tokens: number, unitPrice: number) =>
    (tokens / 1_000_000) * unitPrice;

  // 命中与未命中的输入分开计价；上游只给总输入时按全部未命中算，同样取保守值。
  const hit = usage.cacheHitTokens;
  const miss = usage.cacheMissTokens > 0 ? usage.cacheMissTokens : usage.inputTokens;

  const breakdown: CostBreakdown = {
    cacheHitInput: perMillion(hit, price.cacheHitInput),
    cacheMissInput: perMillion(miss, price.cacheMissInput),
    output: perMillion(usage.outputTokens, price.output),
    total: 0,
  };
  breakdown.total =
    breakdown.cacheHitInput + breakdown.cacheMissInput + breakdown.output;

  return { costCny: breakdown.total, tier, breakdown, price };
}

/** 金额格式化：小额不显示成 ¥0.00，小于一分用六位小数 */
export function formatCny(amount: number): string {
  if (amount === 0) return "¥0";
  if (amount < 0.01) return `¥${amount.toFixed(6)}`;
  if (amount < 1) return `¥${amount.toFixed(4)}`;
  return `¥${amount.toFixed(2)}`;
}
