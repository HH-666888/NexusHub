/**
 * 事件存储端口。内核只认识这个接口，不认识 SQLite，
 * 所以回放逻辑可以用内存假存储完整单测。
 */

import type { NewRunEvent, RunEvent } from "../domain/run-event";

export interface EventStore {
  /**
   * 批量追加。一次生成有上千个片段，逐条写就是上千次事务、每次都要 fsync，
   * 合成一批写一次能从上千降到几十。
   */
  appendMany(events: readonly NewRunEvent[]): Promise<void>;

  /** 按 seq 正序 */
  listByRun(runId: string): Promise<RunEvent[]>;

  /** 列表页显示跑了多少步 */
  countByRun(runId: string): Promise<number>;

  /**
   * 清掉某次运行的事件，用户点重新生成时用：一次运行的事件日志只有一份，
   * 留着旧的会让回放变成两条线搅在一起，且旧事件的花费与新产物对不上。
   */
  deleteByRun(runId: string): Promise<number>;
}

/** 内存实现，测试与本地演示用 */
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