/**
 * 运行数据访问的 SQLite 实现
 * ============================================================
 * 所有 SQL 都收敛在这一个文件里。换数据库时只需要重写这一个文件。
 *
 * 这里有一件事只有适配器该做：把「扁平的列」与「嵌套的领域对象」互相转换。
 * 表里 token 是五个独立列（为了能在数据库层直接求和排序），
 * 领域模型里是一个 usage 对象（对内更好用）。
 * 这个转换是适配器的职责，不能泄漏到内核里。
 */

import { and, desc, eq } from "drizzle-orm";
import { db } from "./client";
import { runs } from "./schema";
import type { RunStore } from "@/core/ports/run-store";
import {
  emptyUsage,
  newRunId,
  type NewRun,
  type Run,
  type RunStatus,
} from "@/core/domain/run";
import type { StageId } from "@/core/pipeline/stages";
import type { TokenUsage } from "@/core/ports/model";

type RunRow = typeof runs.$inferSelect;

/** 行 → 领域对象 */
function toDomain(row: RunRow): Run {
  return {
    id: row.id,
    userId: row.userId,
    prompt: row.prompt,
    // 数据库里存的是文本，取出时收窄回字面量类型。
    // 值域由写入路径保证（只写入 StageId / RunStatus 的合法值）。
    stage: row.stage as StageId,
    status: row.status as RunStatus,
    workflowVersion: row.workflowVersion,
    totalCostCny: row.totalCostCny,
    usage: {
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      reasoningTokens: row.reasoningTokens,
      cacheHitTokens: row.cacheHitTokens,
      cacheMissTokens: row.cacheMissTokens,
    },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** 领域对象 → 各列的写入值 */
function usageColumns(usage: TokenUsage) {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens,
    cacheHitTokens: usage.cacheHitTokens,
    cacheMissTokens: usage.cacheMissTokens,
  };
}

export const sqliteRunStore: RunStore = {
  async create(data: NewRun): Promise<Run> {
    const now = Date.now();
    const row = db
      .insert(runs)
      .values({
        id: newRunId(),
        userId: data.userId,
        prompt: data.prompt,
        // 新运行一律从第①阶段（规格化）开始，状态为进行中
        stage: "spec",
        status: "running",
        workflowVersion: data.workflowVersion,
        totalCostCny: 0,
        ...usageColumns(emptyUsage()),
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    return toDomain(row);
  },

  async findById(id: string): Promise<Run | null> {
    const row = db.select().from(runs).where(eq(runs.id, id)).get();
    return row ? toDomain(row) : null;
  },

  async listByUser(userId: number, limit = 50): Promise<Run[]> {
    const rows = db
      .select()
      .from(runs)
      .where(eq(runs.userId, userId))
      // 复合索引 idx_runs_user_created 正好覆盖这个排序
      .orderBy(desc(runs.createdAt))
      .limit(limit)
      .all();
    return rows.map(toDomain);
  },

  async update(id, patch): Promise<void> {
    const values: Record<string, unknown> = { updatedAt: Date.now() };
    if (patch.stage !== undefined) values.stage = patch.stage;
    if (patch.status !== undefined) values.status = patch.status;
    if (patch.workflowVersion !== undefined)
      values.workflowVersion = patch.workflowVersion;
    if (patch.totalCostCny !== undefined) values.totalCostCny = patch.totalCostCny;
    if (patch.usage !== undefined) Object.assign(values, usageColumns(patch.usage));

    db.update(runs).set(values).where(eq(runs.id, id)).run();
  },

  async remove(id: string, userId: number): Promise<boolean> {
    // 带上 userId 条件：防止通过伪造 id 删除别人的记录
    const before = db
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.id, id), eq(runs.userId, userId)))
      .get();
    if (!before) return false;
    db.delete(runs).where(and(eq(runs.id, id), eq(runs.userId, userId))).run();
    return true;
  },

  async countByUser(userId: number): Promise<number> {
    const rows = db
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.userId, userId))
      .all();
    return rows.length;
  },
};