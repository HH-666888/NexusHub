/** 事件存储的 SQLite 实现：内核只认识 EventStore 接口。
 * 读取按 seq 升序，回放依赖这个顺序。 */

import { asc, eq, sql } from "drizzle-orm";
import { db } from "./client";
import { runEvents } from "./schema";
import { parseRunEvent, serializeRunEvent } from "@/core/domain/run-event";
import type { NewRunEvent, RunEvent } from "@/core/domain/run-event";
import type { EventStore } from "@/core/ports/event-store";

export const sqliteEventStore: EventStore = {
  async appendMany(events: readonly NewRunEvent[]): Promise<void> {
    if (events.length === 0) return;
    // 一批一次事务：逐条插入会让 SQLite 每行 fsync，上千片段时肉眼可见地卡
    db.transaction((tx) => {
      for (const e of events) {
        tx.insert(runEvents)
          .values({
            runId: e.runId,
            seq: e.seq,
            at: e.at,
            kind: e.kind,
            payload: serializeRunEvent(e.payload),
          })
          .run();
      }
    });
  },

  async listByRun(runId: string): Promise<RunEvent[]> {
    const rows = db
      .select()
      .from(runEvents)
      .where(eq(runEvents.runId, runId))
      .orderBy(asc(runEvents.seq))
      .all();
    return rows.map(parseRunEvent);
  },

  async countByRun(runId: string): Promise<number> {
    const row = db
      .select({ n: sql<number>`count(*)` })
      .from(runEvents)
      .where(eq(runEvents.runId, runId))
      .get();
    return row?.n ?? 0;
  },

  async deleteByRun(runId: string): Promise<number> {
    const res = db.delete(runEvents).where(eq(runEvents.runId, runId)).run();
    return res.changes;
  },
};