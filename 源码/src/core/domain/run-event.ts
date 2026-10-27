/**
 * 运行事件：生成过程中流过、落库之后用来回放的事件。
 * GenerateEvent 是实时推给浏览器的逐片段事件、不落库；RunEvent 要序号、时间与合并后的粒度。
 * 混用会逼着为省存储去改生成器的吐法，那会伤到实时体验。
 */

import type { GenerateEvent } from "../generate/service";

/** 与 GenerateEvent 的 kind 一一对应 */
export type RunEventKind = GenerateEvent["kind"];

/**
 * 一条已落库的事件。
 * at 是绝对 Unix 毫秒：绝对时间还能回答生成发生在几点，相对偏移随时可算，反过来做不到。
 */
export interface RunEvent {
  id: number;
  runId: string;
  /** 运行内序号，从 0 开始且连续 */
  seq: number;
  at: number;
  kind: RunEventKind;
  /** 结构由 kind 决定，读取时收窄 */
  payload: GenerateEvent;
}

/** 还没有自增 id */
export type NewRunEvent = Omit<RunEvent, "id">;

/** 库里那行 JSON 文本还原成事件对象 */
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

/** 只序列化 payload，seq 与 at 由落库方补 */
export function serializeRunEvent(event: GenerateEvent): string {
  return JSON.stringify(event);
}

// 回放：把一串事件还原成某一刻的画面。纯函数，可单测

export interface ReplayFrame {
  /** 相对生成开始的毫秒偏移 */
  offsetMs: number;
  /** 到这一刻为止写出的正文 */
  text: string;
  /** 到这一刻为止的思考 */
  reasoning: string;
  /** 还没收到 phase 事件时为 null */
  phaseLabel: string | null;
  /** 还没收到 usage 事件时为 null，不拿 0 冒充已知 */
  costCny: number | null;
  /** 还没做检查时为 null */
  checks: { passed: number; total: number } | null;
  /** 还没落盘时为 null */
  artifactBytes: number | null;
  /** 还没到规格阶段时为 null */
  specAcceptance: { total: number; must: number } | null;
  /** 到这一刻为止的错误信息 */
  error: string | null;
  /** 界面标刻度用 */
  consumed: number;
}

/**
 * 时间轴停在 offsetMs 这一刻的画面。
 * 基准取第一条事件而不是运行创建时间：中间隔着一次网络往返，算进去开头会是一段空白。
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
    specAcceptance: null,
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
      case "spec":
        frame.specAcceptance = {
          total: e.payload.spec.acceptance.length,
          must: e.payload.spec.acceptance.filter((a) => a.level === "must").length,
        };
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

/** 回放总时长（毫秒），没有事件时为 0 */
export function replayDurationMs(events: readonly RunEvent[]): number {
  if (events.length < 2) return 0;
  return events[events.length - 1].at - events[0].at;
}

/**
 * 事件序号到时间轴的换算。
 * 按事件序号定位比按毫秒稳：模型吐字速度不均匀，按毫秒拖会有些段落怎么拖都不动。
 */
export function offsetOfSeq(events: readonly RunEvent[], seq: number): number {
  if (events.length === 0) return 0;
  const origin = events[0].at;
  const hit = events.find((e) => e.seq >= seq);
  return hit ? hit.at - origin : events[events.length - 1].at - origin;
}