/**
 * 成本流水的 SQLite 实现。金额单位是元，按原始小数保存，不做四舍五入。
 * 每次模型调用一行，含失败的调用。
 */

import { eq } from "drizzle-orm";
import { db } from "./client";
import { costRecords, runs } from "./schema";
import type { CostRecord, NewCostRecord } from "@/core/domain/cost";
import type { CostStore } from "@/core/ports/cost-store";
import type { TokenUsage } from "@/core/ports/model";

type CostRow = typeof costRecords.$inferSelect;

function toDomain(row: CostRow): CostRecord {
  const usage: TokenUsage = {
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    reasoningTokens: row.reasoningTokens,
    cacheHitTokens: row.cacheHitTokens,
    cacheMissTokens: row.cacheMissTokens,
  };
  return {
    id: row.id,
    runId: row.runId,
    stage: row.stage,
    nodeId: row.nodeId,
    tier: row.tier,
    model: row.model,
    purpose: row.purpose,
    usage,
    costCny: row.costCny,
    priceTier: row.priceTier,
    latencyMs: row.latencyMs,
    createdAt: row.createdAt,
  };
}

export const sqliteCostStore: CostStore = {
  async record(data: NewCostRecord): Promise<void> {
    db.insert(costRecords)
      .values({
        runId: data.runId,
        stage: data.stage,
        nodeId: data.nodeId,
        tier: data.tier,
        model: data.model,
        purpose: data.purpose,
        inputTokens: data.usage.inputTokens,
        outputTokens: data.usage.outputTokens,
        reasoningTokens: data.usage.reasoningTokens,
        cacheHitTokens: data.usage.cacheHitTokens,
        cacheMissTokens: data.usage.cacheMissTokens,
        costCny: data.costCny,
        priceTier: data.priceTier,
        latencyMs: data.latencyMs,
        createdAt: Date.now(),
      })
      .run();
  },

  async listByRun(runId: string): Promise<CostRecord[]> {
    const rows = db
      .select()
      .from(costRecords)
      .where(eq(costRecords.runId, runId))
      .all();
    return rows.map(toDomain);
  },

  async totalByRun(runId: string): Promise<number> {
    const rows = await this.listByRun(runId);
    return rows.reduce((sum, r) => sum + r.costCny, 0);
  },

  async totalByUser(userId: number): Promise<number> {
    // 先取出该用户的全部运行 id，再汇总这些运行的流水。
    // 数据量在这个量级下没必要写复杂 SQL，可读性更重要。
    const userRuns = db
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.userId, userId))
      .all();
    let total = 0;
    for (const r of userRuns) {
      total += await this.totalByRun(r.id);
    }
    return total;
  },
};
