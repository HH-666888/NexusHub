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
// 加法只有一份定义（token 五列逐项相加）—— 不要在这里再抄一遍
import { addUsage } from "@/core/domain/module-build";

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
    /*
      ⚠️ usage 是**累加**，不是覆盖。

      ── 为什么（真实运行查出来的，不是设想的）──
        每个调用方报的都是**自己那一次调用**的用量：规格化、架构、界面、
        每个模块、装配各报一次。覆盖的话，这一行的 token 就只剩
        "最后一次调用"的数字。实测一条真实运行（run a468a508）：
          库里 runs 行  → 输入 4638 · 输出 6578 · 思考 0
          cost_records 七条合计 → 输入 9172 · 输出 34881 · 思考 16446
        而界面右侧"实时成本"读的就是这一行 —— 于是一条实打实花了
        16446 思考 token 的运行，被显示成"思考 token 0"。
        这和「思考 tab 永远是空的」是同一类错误，只是换了个地方说出口。

      ── 为什么 totalCostCny 反而是覆盖 ──
        因为调用方给它的就是**累计值**（spent + 这一次），口径本来就不同。
        两者相邻，所以必须各自写清楚，免得下一个人"顺手统一"成一个口径。
    */
    if (patch.usage !== undefined) {
      // 读改写：驱动是同步的，中间没有 await，不存在交错
      const row = db.select().from(runs).where(eq(runs.id, id)).get();
      if (row) {
        Object.assign(values, usageColumns(addUsage(toDomain(row).usage, patch.usage)));
      }
    }

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