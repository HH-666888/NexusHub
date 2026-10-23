/**
 * 运行事件
 * ============================================================
 * 生成过程中流过的事件，落库之后用来回放。
 *
 * ── 为什么要有这个文件，而不是直接用 generate/service 里的 GenerateEvent ──
 *   两者的职责不同：
 *     GenerateEvent 是**推给浏览器看的**，实时、逐片段、不落库；
 *     RunEvent      是**存下来回放的**，需要序号、时间、以及合并后的粒度。
 *   混用会导致一件事：为了让存储更省，你会去改生成器的吐法，
 *   而那会伤到实时体验（用户就是要看逐字蹦出来的效果）。
 *   分开之后，两边各按自己的需要来，中间由一个记录器衔接。
 */

import type { GenerateEvent } from "../generate/service";

/** 落库后的事件种类，与 GenerateEvent 的 kind 一一对应 */
export type RunEventKind = GenerateEvent["kind"];

/**
 * 一条已落库的事件。
 *
 * `at` 是**绝对** Unix 毫秒（不是相对偏移）。
 * 为什么不存相对偏移：绝对时间还能顺带回答「这次生成发生在几点」，
 * 而相对偏移可以随时算出来 —— 存绝对、算相对，反过来做不到。
 */
export interface RunEvent {
  id: number;
  runId: string;
  /** 同一次运行内的序号，从 0 开始且连续 */
  seq: number;
  at: number;
  kind: RunEventKind;
  /** 事件原始内容。结构由 kind 决定，读取时收窄 */
  payload: GenerateEvent;
}

/** 写入时用的一半 —— 还没有自增 id */
export type NewRunEvent = Omit<RunEvent, "id">;

/** 把数据库里那行 JSON 文本还原成事件对象 */
export function parseRunEvent(row: {
  id: number;
  runId: string;
  seq: number;
  at: number;
  kind: string;
  payload: string;
}): RunEvent {
  return {
    id: row.id,
    runId: row.runId,
    seq: row.seq,
    at: row.at,
    kind: row.kind as RunEventKind,
    payload: JSON.parse(row.payload) as GenerateEvent,
  };
}

/** 序列化成数据库里的文本 */
export function serializeRunEvent(event: GenerateEvent): string {
  return JSON.stringify(event);
}

/* ============================================================
   回放：把一串事件还原成「某一刻的画面」
   ------------------------------------------------------------
   纯函数，因此可以单测 —— 回放最容易出的错不是渲染，
   而是「拖到某一秒，画面和当时对不上」。
   ============================================================ */

export interface ReplayFrame {
  /** 相对生成开始的毫秒偏移 */
  offsetMs: number;
  /** 到这一刻为止，模型已经写出的正文 */
  text: string;
  /** 到这一刻为止的思考过程 */
  reasoning: string;
  /** 当前阶段标签。还没收到 phase 事件时为 null */
  phaseLabel: string | null;
  /** 已产生的花费。还没收到 usage 事件时为 null —— 不显示 0 冒充已知 */
  costCny: number | null;
  /** 已通过 / 总检查项。还没做检查时为 null */
  checks: { passed: number; total: number } | null;
  /** 产物大小。还没落盘时为 null */
  artifactBytes: number | null;
  /** 这一刻之前的错误信息 */
  error: string | null;
  /** 已经被消费掉的事件条数，用于界面上标刻度 */
  consumed: number;
}

/**
 * 计算「时间轴停在 offsetMs 这一刻」的画面。
 *
 * 时间基准是**第一条事件**，不是运行创建时间 ——
 * 从一句话到模型开口之间隔着一次网络往返，把它算进回放里，
 * 用户拖到开头会看到一段没有任何变化的空白。
 */
export function frameAt(events: readonly RunEvent[], offsetMs: number): ReplayFrame {
  const frame: ReplayFrame = {
    offsetMs,
    text: "",
    reasoning: "",
    phaseLabel: null,
    costCny: null,
    checks: null,
    artifactBytes: null,
    error: null,
    consumed: 0,
  };
  if (events.length === 0) return frame;

  const origin = events[0].at;
  const textParts: string[] = [];
  const reasonParts: string[] = [];

  for (const e of events) {
    if (e.at - origin > offsetMs) break;
    frame.consumed++;

    switch (e.payload.kind) {
      case "phase":
        frame.phaseLabel = e.payload.label;
        break;
      case "text":
        textParts.push(e.payload.delta);
        break;
      case "reasoning":
        reasonParts.push(e.payload.delta);
        break;
      case "usage":
        frame.costCny = e.payload.costCny;
        break;
      case "check":
        frame.checks = {
          passed: e.payload.summary.passed,
          total: e.payload.summary.total,
        };
        break;
      case "artifact":
        frame.artifactBytes = e.payload.artifact.bytes;
        break;
      case "error":
        frame.error = e.payload.message;
        break;
    }
  }

  frame.text = textParts.join("");
  frame.reasoning = reasonParts.join("");
  return frame;
}

/** 整段回放的总时长（毫秒）。没有事件时为 0 */
export function replayDurationMs(events: readonly RunEvent[]): number {
  if (events.length < 2) return 0;
  return events[events.length - 1].at - events[0].at;
}

/**
 * 事件条数到时间轴的换算。
 *
 * 时间轴用「事件序号」而不是毫秒来定位更稳：
 * 模型吐字的速度不是均匀的，按毫秒拖会在某些段落上
 * 怎么拖都不动、在另一些段落上一拖就跳过一大段。
 */
export function offsetOfSeq(events: readonly RunEvent[], seq: number): number {
  if (events.length === 0) return 0;
  const origin = events[0].at;
  const hit = events.find((e) => e.seq >= seq);
  return hit ? hit.at - origin : events[events.length - 1].at - origin;
}