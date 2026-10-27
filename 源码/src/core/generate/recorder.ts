/**
 * 事件记录器：把生成事件原样转发给调用方，同时合并片段后落库。
 * 片段必须合并，且在任何非片段事件之前冲刷，否则回放顺序会错。
 */

import type { NewRunEvent, RunEventKind } from "../domain/run-event";
import type { EventStore } from "../ports/event-store";
import type { GenerateEvent } from "./service";

export interface RecorderOptions {
  /** 冲刷间隔（毫秒）：太小写入次数多，太大回放粒度粗 */
  flushIntervalMs?: number;
  /** 缓冲字符上限，超过立即冲刷 */
  flushChars?: number;
  /** 注入时钟，便于测试 */
  now?: () => number;
}

const DEFAULT_FLUSH_INTERVAL_MS = 250;
const DEFAULT_FLUSH_CHARS = 4000;

/** 会被合并的片段类型 */
const DELTA_KINDS = new Set<RunEventKind>(["text", "reasoning"]);

/** 原样转发并合并落库；调用方（SSE 接口）无感 */
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

  // 正文与思考交替出现，按 kind 分开攒才能各自成段
  let textBuf = "";
  let reasoningBuf = "";
  let textStartAt = 0;
  let reasoningStartAt = 0;

  /** 把攒着的片段合成一条事件，入待写队列 */
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

  /** 写库；失败只记日志，记账不能拖垮主流程 */
  async function persist() {
    if (pending.length === 0) return;
    const batch = pending.splice(0, pending.length);
    try {
      await store.appendMany(batch);
    } catch (err) {
      // 落库是附加能力，不为回放数据失败整次生成
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
      // 先冲刷片段，保证落库顺序与事件顺序一致
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

    yield event;
  }

  flushDeltas();
  await persist();
}