/**
 * 运行数据的 SQLite 实现，所有 SQL 收敛于此；换库只需重写这一个文件。
 * 扁平列与嵌套领域对象的互转是适配器职责，不泄漏到内核。
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
// 加法只有一份定义，不要在这里再抄一遍
import { addUsage } from "@/core/domain/module-build";

type RunRow = typeof runs.$inferSelect;

/** 数据库行到领域对象 */
function toDomain(row: RunRow): Run {
  return {
    id: row.id,
    userId: row.userId,
    prompt: row.prompt,
    // 存储层是文本，读出时收窄回字面量；值域由写入路径保证
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

/** 领域对象到各列写入值的映射 */
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
        // 新运行一律从规格化阶段开始，状态为进行中
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
      // 复合索引 idx_runs_user_created 正好覆盖该排序
      // limit 默认 50，列表页足够
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
    // usage 是累加而非覆盖：各调用方报的都是自己那一次的用量，
    // 覆盖会让这一行只剩最后一次调用的数字，而界面实时成本读的正是它。
    // totalCostCny 相反是覆盖：调用方给的本来就是累计值，两者口径不同。
    // 相邻两个字段口径不同，各自写清楚，免得下一个人顺手统一。
    if (patch.usage !== undefined) {
      // 读改写：驱动同步执行，中间没有 await，不存在交错
      const row = db.select().from(runs).where(eq(runs.id, id)).get();
      if (row) {
        Object.assign(values, usageColumns(addUsage(toDomain(row).usage, patch.usage)));
      }
    }

    db.update(runs).set(values).where(eq(runs.id, id)).run();
  },

  async remove(id: string, userId: number): Promise<boolean> {
    // 带上 userId 条件，防止伪造 id 删除他人记录
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