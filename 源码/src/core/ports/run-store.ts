/**
 * 运行数据访问端口
 * ============================================================
 * 内核只认识这个接口，不认识 Drizzle、不认识 SQL。
 * 与 AuthStore 一样，接口刻意定义为异步 —— 为将来换 PostgreSQL 留路。
 */

import type { NewRun, Run, RunStatus } from "../domain/run";
import type { StageId } from "../pipeline/stages";
import type { TokenUsage } from "./model";

export interface RunStore {
  create(data: NewRun): Promise<Run>;
  findById(id: string): Promise<Run | null>;
  /** 列出某个用户的构建记录，按时间倒序 */
  listByUser(userId: number, limit?: number): Promise<Run[]>;
  update(
    id: string,
    patch: Partial<{
      stage: StageId;
      status: RunStatus;
      workflowVersion: string;
      totalCostCny: number;
      usage: TokenUsage;
    }>,
  ): Promise<void>;
  /** 删除某条记录（用户主动删除时使用） */
  remove(id: string, userId: number): Promise<boolean>;
  /** 统计某用户一共创建过多少次运行 */
  countByUser(userId: number): Promise<number>;
}