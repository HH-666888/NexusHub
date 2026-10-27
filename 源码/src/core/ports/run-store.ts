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
      /** 这条运行的**累计**花费（调用方自己加好，不是"这一次"的金额） */
      totalCostCny: number;
      /**
       * **这一次调用**的 token 用量 —— 实现方负责把它**累加**到已有值上。
       *
       * 口径与 totalCostCny 相反是有意的：每次调用只知道自己那一次的用量，
       * 让调用方自己加就得先读一次运行；而"累加"这件事适配器一次做完更省事。
       * 反过来（覆盖）会怎样：界面上显示的就成了"最后一次调用"的 token ——
       * 实测一条真实运行被显示成"思考 token 0"，而它花了 16446 个思考 token。
       */
      usage: TokenUsage;
    }>,
  ): Promise<void>;
  /** 删除某条记录（用户主动删除时使用） */
  remove(id: string, userId: number): Promise<boolean>;
  /** 统计某用户一共创建过多少次运行 */
  countByUser(userId: number): Promise<number>;
}