/**
 * 事件存储端口
 * ============================================================
 * 内核只认识这个接口，不认识 SQLite。
 * 因此回放逻辑可以用内存假存储完整单测，不必起数据库。
 */

import type { NewRunEvent, RunEvent } from "../domain/run-event";

export interface EventStore {
  /**
   * 批量追加事件。
   *
   * 为什么是批量而不是单条：
   *   一次生成会产生上千个片段。逐条写入就是上千次事务，
   *   在 SQLite 上每次都要 fsync，累积起来是肉眼可见的卡顿。
   *   合成一批写一次，写入次数从上千降到几十。
   */
  appendMany(events: readonly NewRunEvent[]): Promise<void>;

  /** 读取某次运行的全部事件，按 seq 正序 */
  listByRun(runId: string): Promise<RunEvent[]>;

  /** 事件条数。列表页上显示「这次跑了多少步」用 */
  countByRun(runId: string): Promise<number>;

  /**
   * 清掉某次运行的事件。
   *
   * 什么时候用：用户点「重新生成」时。
   * 一次运行的事件日志应当**只有一份** —— 重新生成意味着
   * 上一条时间线作废，留着旧的会让回放变成两条线搅在一起。
   * 而且旧事件的花费与检查结果对不上新产物，留着就是误导。
   */
  deleteByRun(runId: string): Promise<number>;
}

/** 内存实现 —— 测试与本地演示用，不落盘 */
export function createInMemoryEventStore(): EventStore & {
  all: () => RunEvent[];
} {
  const rows: RunEvent[] = [];
  let nextId = 1;
  return {
    async appendMany(events) {
      for (const e of events) {
        rows.push({ ...e, id: nextId++ });
      }
    },
    async listByRun(runId) {
      return rows
        .filter((r) => r.runId === runId)
        .sort((a, b) => a.seq - b.seq)
        .map((r) => ({ ...r }));
    },
    async countByRun(runId) {
      return rows.filter((r) => r.runId === runId).length;
    },
    async deleteByRun(runId) {
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i].runId === runId) rows.splice(i, 1);
      }
      return before - rows.length;
    },
    all: () => [...rows],
  };
}