/**
 * 成本流水存取端口。单开一个端口而不是把成本塞进 runs 表：
 * 累计值只能回答一共花了多少，回答不了钱花在哪个阶段、哪次调用、哪个档位。
 */

import type { NewCostRecord, CostRecord } from "../domain/cost";

export interface CostStore {
  record(data: NewCostRecord): Promise<void>;
  listByRun(runId: string): Promise<CostRecord[]>;
  /** 累计花费（元） */
  totalByRun(runId: string): Promise<number>;
  /** 用户累计花费（元），账户级预算控制用 */
  totalByUser(userId: number): Promise<number>;
}
