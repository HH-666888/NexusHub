/**
 * 规划日志：树是一段只许追加的事件历史，「某一刻的树」是它到 seq 的投影。
 * 只增不改，任何时刻的画面都能由 (日志, seq) 重放；本层不落盘。
 */

import { type TaskPoint, type TaskPointStatus } from "./task-point";

/** 规划事件，只追加不修改 */
export type PlanningEvent =
  | { kind: "born"; seq: number; point: TaskPoint }
  | { kind: "status"; seq: number; id: string; status: TaskPointStatus };

/**
 * 追加出生事件；同 id 已出生则原样返回同一数组，调用方在 useMemo 里靠 === 判断。
 * seq 取 point.bornAtSeq，避免两个来源描述同一件事。
 */
export function appendBorn(
  log: readonly PlanningEvent[],
  point: TaskPoint,
): PlanningEvent[] {
  if (log.some((ev) => ev.kind === "born" && ev.point.id === point.id)) {
    // 返回同一对象是有意的：数组未变，调用方靠 === 跳过重渲染
    return log as PlanningEvent[];
  }
  return [...log, { kind: "born", seq: point.bornAtSeq, point }];
}

/**
 * 追加状态事件，不查重也不校验 id 在场：
 * 查重要扫一遍日志，把 O(1) 追加变成 O(n)；谁在场由投影决定。
 */
export function appendStatus(
  log: readonly PlanningEvent[],
  id: string,
  status: TaskPointStatus,
  seq: number,
): PlanningEvent[] {
  return [...log, { kind: "status", seq, id, status }];
}

/**
 * 到 seq 为止应当存在的点：bornAtSeq <= seq 才存在，状态取最后一条 status 事件。
 * 顺序按出生 seq、同 seq 按日志位置；父子顺序由追加顺序负责，这里不丢孤儿子树。
 */
export function projectAt(log: readonly PlanningEvent[], seq: number): TaskPoint[] {
  /** 出生记录，带事件 seq 与日志位置用于排序 */
  const born: { evSeq: number; order: number; point: TaskPoint }[] = [];
  /** id → 此刻生效的状态（seq 最大，同 seq 取靠后） */
  const statusNow = new Map<
    string,
    { seq: number; order: number; status: TaskPointStatus }
  >();

  log.forEach((ev, order) => {
    if (ev.seq > seq) return;

    if (ev.kind === "born") {
      if (ev.point.bornAtSeq > seq) return;
      born.push({ evSeq: ev.seq, order, point: ev.point });
      return;
    }

    const prev = statusNow.get(ev.id);
    const newer =
      prev === undefined ||
      ev.seq > prev.seq ||
      (ev.seq === prev.seq && order > prev.order);
    if (newer) statusNow.set(ev.id, { seq: ev.seq, order, status: ev.status });
  });

  // 显式写出 order 比较，不依赖 Array.sort 的稳定性
  born.sort((a, b) => a.evSeq - b.evSeq || a.order - b.order);

  const seen = new Set<string>();
  const out: TaskPoint[] = [];
  for (const item of born) {
    // 同 id 只认先出现的一份，与 appendBorn 的幂等一致
    if (seen.has(item.point.id)) continue;
    seen.add(item.point.id);

    const now = statusNow.get(item.point.id);
    out.push(now ? { ...item.point, status: now.status } : { ...item.point });
  }

  return out;
}

/** 日志里最大的 seq，空日志返回 0，即「现在」的哨兵值 */
export function maxSeq(log: readonly PlanningEvent[]): number {
  let max = 0;
  for (const ev of log) {
    if (ev.seq > max) max = ev.seq;
  }
  return max;
}
