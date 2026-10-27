/**
 * 成本流水：一次模型调用对应一行账，没有业务规则。
 */

import type { TokenUsage } from "../ports/model";

export interface CostRecord {
  id: number;
  /** 独立调用（探测脚本）没有归属运行 */
  runId: string | null;
  stage: string | null;
  nodeId: string | null;
  tier: string;
  model: string;
  purpose: string;
  usage: TokenUsage;
  costCny: number;
  /** peak | offPeak */
  priceTier: string;
  latencyMs: number;
  createdAt: number;
}

export type NewCostRecord = Omit<CostRecord, "id" | "createdAt">;