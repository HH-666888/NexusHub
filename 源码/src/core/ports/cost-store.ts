/**
 * 成本流水存取端口
 * ============================================================
 * 为什么值得单开一个端口而不是把成本字段塞进 runs 表：
 *   累计值只能回答「一共花了多少」，回答不了
 *   「钱花在哪个阶段、哪一次调用、哪个模型、哪个档位」。
 *   而后者才是成本优化的依据。
 */

import type { NewCostRecord, CostRecord } from "../domain/cost";

export interface CostStore {
  record(data: NewCostRecord): Promise<void>;
  listByRun(runId: string): Promise<CostRecord[]>;
  /** 某次运行的累计花费（元） */
  totalByRun(runId: string): Promise<number>;
  /** 某个用户的累计花费（元），用于账户级预算控制 */
  totalByUser(userId: number): Promise<number>;
}