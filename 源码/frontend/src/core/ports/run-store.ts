/**
 * 运行数据访问端口。内核只认识这个接口，不认识 Drizzle、不认识 SQL。
 * 与 AuthStore 一样，接口刻意定义为异步 —— 为将来换 PostgreSQL 留路。
 */

import type { NewRun, Run, RunStatus } from "../domain/run";
import type { StageId } from "../pipeline/stages";
import type { TokenUsage } from "./model";

export interface RunStore {
  create(data: NewRun): Promise<Run>;
  findById(id: string): Promise<Run | null>;
  /** 某用户的记录，按时间倒序 */
  listByUser(userId: number, limit?: number): Promise<Run[]>;
  update(
    id: string,
    patch: Partial<{
      stage: StageId;
      status: RunStatus;
      workflowVersion: string;
      /** 累计花费，调用方自己加好，不是这一次的金额 */
      totalCostCny: number;
      /**
       * 这一次调用的用量，实现方负责累加到已有值上。
       * 口径与 totalCostCny 相反是有意的：覆盖的话界面显示的就成了最后一次调用的用量
       * （实测一条真实运行被显示成思考 token 0，而它花了 16446 个）。
       */
      usage: TokenUsage;
    }>,
  ): Promise<void>;
  /** 用户主动删除时用 */
  remove(id: string, userId: number): Promise<boolean>;
  /** 该用户一共创建过多少次运行 */
  countByUser(userId: number): Promise<number>;
}
