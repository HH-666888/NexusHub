/**
 * 成本流水的领域模型
 * ============================================================
 * 极简：它就是从「一次模型调用」到「一行账」的映射。
 * 没有业务规则，只有字段 —— 所以这个文件短是正常的。
 */

import type { TokenUsage } from "../ports/model";

export interface CostRecord {
  id: number;
  /** 独立调用（例如探测脚本）没有归属运行，允许为空 */
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