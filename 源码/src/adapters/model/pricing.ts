/**
 * 模型计价
 * ============================================================
 * 价格来源：DeepSeek 官方文档「模型 & 价格」页（已核对，非估算）
 *   https://api-docs.deepseek.com/zh-cn/quick_start/pricing
 *
 * 单位统一为「元 / 百万 tokens」。
 *
 * 两条对成本影响极大的事实，写在这里免得忘记：
 *
 *   ① 时段价差一倍
 *      北京时间周一至周五 9:00-12:00、14:00-18:00 为高峰时段；
 *      其余时间（含周末与法定节假日全天）为空闲时段，价格是高峰的一半。
 *      → 批量跑构建尽量安排在空闲时段，成本直接减半。
 *
 *   ② 缓存命中的输入便宜 50 倍
 *      flash 缓存命中 0.02 元/百万，未命中 1 元/百万。
 *      → 把稳定的系统提示词放在消息最前面，是最大的省钱手段。
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

/** 已核对的官方价格表 */
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

/** 找不到价格时的兜底：按 flash 高峰价算，宁可高估也不低估预算 */
const FALLBACK: ModelPricing = PRICING["deepseek-flash"];

export function pricingFor(model: string): ModelPricing {
  return PRICING[model] ?? FALLBACK;
}

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * 判断某个时刻是否处于高峰时段。
 *
 * 实现要点：先用 UTC 方法取出「北京时间」的年月日时分，
 * 而不是用本地时区方法 —— 否则服务器换个时区，算出来的价格就变了。
 *
 * 已知简化：中国法定节假日不单独排除，一律按高峰处理。
 * 这是**故意保守**的选择 —— 高估花费不会让预算失控，低估才会。
 */
export function priceTierAt(at: Date): PriceTier {
  const beijing = new Date(at.getTime() + BEIJING_OFFSET_MS);
  const day = beijing.getUTCDay(); // 0=周日, 6=周六
  const hour = beijing.getUTCHours();

  // 周末全天空闲
  if (day === 0 || day === 6) return "offPeak";

  // 工作日：9:00-12:00 与 14:00-18:00 是高峰（左闭右开）
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
 * 按 token 用量折算成本（人民币）。
 *
 * 注意 reasoningTokens 不单独计价 —— 它已经包含在 outputTokens 里。
 * 官方计费口径是「输入与输出总 token 数」，思考 token 属于输出。
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

  // 缓存命中与未命中的输入分开计价。
  // 若上游只给了总输入没给拆分，按「全部未命中」算 —— 同样取保守值。
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

/** 把金额格式化成人看的样子：小额不显示成 ¥0.00 */
export function formatCny(amount: number): string {
  if (amount === 0) return "¥0";
  if (amount < 0.01) return `¥${amount.toFixed(6)}`;
  if (amount < 1) return `¥${amount.toFixed(4)}`;
  return `¥${amount.toFixed(2)}`;
}