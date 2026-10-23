/**
 * 事件记录器
 * ============================================================
 * 把生成器吐出来的事件，一份推给调用方（实时看），
 * 另一份合并后落库（事后回放）。
 *
 * ── 为什么是「包一层」而不是在生成器里直接写库 ──
 *   生成内核不该认识存储。写进去之后，想换个存储介质、
 *   想在测试里不落库，都得去改内核。
 *   包一层的话，内核一行不动，落库是可插拔的。
 *
 * ── 为什么必须合并片段 ──
 *   一次生成会吐出三千多个正文与思考片段。
 *   逐条落库 = 三千多次写入，在 SQLite 上每次都 fsync，
 *   累积起来是肉眼可见的卡顿 —— 而这一切只是为了回放时
 *   能看到「第 1200 毫秒时已经写了 400 个字」，
 *   合并成几十条完全够用。
 *
 * ── 一条容易写错的地方 ──
 *   缓冲区必须在**任何非片段事件之前**先冲刷。
 *   否则 usage 事件会先落库，而它前面那段正文后落库，
 *   回放到那一刻时就会看到「钱已经花了，字还没出来」。
 */

import type { NewRunEvent, RunEventKind } from "../domain/run-event";
import type { EventStore } from "../ports/event-store";
import type { GenerateEvent } from "./service";

export interface RecorderOptions {
  /**
   * 缓冲区攒多久冲刷一次（毫秒）。
   * 太小 → 写入次数多；太大 → 回放粒度粗、拖动时跳跃感明显。
   */
  flushIntervalMs?: number;
  /** 缓冲区字符数上限，超过就立刻冲刷，避免长回答把内存撑大 */
  flushChars?: number;
  /** 注入时钟，便于测试里精确控制时间 */
  now?: () => number;
}

const DEFAULT_FLUSH_INTERVAL_MS = 250;
const DEFAULT_FLUSH_CHARS = 4000;

/** 会被合并的片段类型 */
const DELTA_KINDS = new Set<RunEventKind>(["text", "reasoning"]);

/**
 * 包装一个事件流：原样转发，同时合并落库。
 *
 * 返回的仍然是同一个事件流 —— 调用方（SSE 接口）不需要知道自己被记录了。
 */
export async function* recordRunEvents(
  source: AsyncIterable<GenerateEvent>,
  store: EventStore,
  runId: string,
  options: RecorderOptions = {},
): AsyncIterable<GenerateEvent> {
  const flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const flushChars = options.flushChars ?? DEFAULT_FLUSH_CHARS;
  const now = options.now ?? (() => Date.now());

  let seq = 0;
  const pending: NewRunEvent[] = [];

  /*
    尚未落库的片段。按 kind 分开攒 ——
    正文和思考会交替出现，混在一个缓冲里就分不出来了。
  */
  let textBuf = "";
  let reasoningBuf = "";
  let textStartAt = 0;
  let reasoningStartAt = 0;

  /** 把攒着的片段合成一条事件推进待写队列 */
  function flushDeltas(at = now()) {
    if (textBuf) {
      pending.push({
        runId,
        seq: seq++,
        at: textStartAt || at,
        kind: "text",
        payload: { kind: "text", delta: textBuf },
      });
      textBuf = "";
      textStartAt = 0;
    }
    if (reasoningBuf) {
      pending.push({
        runId,
        seq: seq++,
        at: reasoningStartAt || at,
        kind: "reasoning",
        payload: { kind: "reasoning", delta: reasoningBuf },
      });
      reasoningBuf = "";
      reasoningStartAt = 0;
    }
  }

  /** 真正写库。失败只记不抛 —— 记账是附加能力，不能拖垮主流程 */
  async function persist() {
    if (pending.length === 0) return;
    const batch = pending.splice(0, pending.length);
    try {
      await store.appendMany(batch);
    } catch (err) {
      // 写不进去就算了。用户要的是把东西生成出来，
      // 不能因为回放数据没记上就让整次生成失败。
      console.error(
        `[events] 落库失败，已丢弃 ${batch.length} 条事件（生成继续）：`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  for await (const event of source) {
    const t = now();

    if (DELTA_KINDS.has(event.kind)) {
      const delta = (event as { delta: string }).delta;
      if (event.kind === "text") {
        if (!textBuf) textStartAt = t;
        textBuf += delta;
      } else {
        if (!reasoningBuf) reasoningStartAt = t;
        reasoningBuf += delta;
      }

      // 攒够时间或攒够字数就冲刷
      const buffered = textBuf.length + reasoningBuf.length;
      const oldest = Math.min(
        textStartAt || t,
        reasoningStartAt || t,
      );
      if (buffered >= flushChars || t - oldest >= flushIntervalMs) {
        flushDeltas(t);
        await persist();
      }
    } else {
      // 非片段事件：先把攒着的片段落下去，保证顺序不错乱
      flushDeltas(t);
      pending.push({
        runId,
        seq: seq++,
        at: t,
        kind: event.kind,
        payload: event,
      });
      await persist();
    }

    // 原样转发给调用方，实时体验一点不受影响
    yield event;
  }

  // 流结束时把最后一点尾巴写掉
  flushDeltas();
  await persist();
}