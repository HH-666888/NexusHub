/**
 * 运行事件流（SSE）。
 *
 * 契约 §6.1：服务端只发 `data: <JSON>` 帧，事件类型在 `payload.kind` 里。
 * 契约 §7 的硬规则：**前端遇到未知 kind 必须忽略**，不能崩 —— 后端加事件类型
 * 时前端可能还没发版，这时候用户看到的应该还是能用的界面。
 */

import type { GenerateEvent } from "@/core/generate/service";

/** 契约 §7 登记过的 kind（含"计划"里的 tool / retrieval / cost）。 */
const KNOWN_KINDS = new Set<string>([
  "phase",
  "reasoning",
  "text",
  "spec",
  "arch",
  "ui",
  "modules",
  "usage",
  "check",
  "artifact",
  "error",
  "tool",
  "retrieval",
  "cost",
]);

/**
 * 解析一帧。返回 null 表示这一帧不该被消费（空帧、坏 JSON、未知类型）。
 * 抽成纯函数是为了能测 —— 事件流本身在单测里没法跑。
 */
export function parseEvent(raw: string): GenerateEvent | null {
  if (!raw) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) return null;
  const kind = (payload as { kind?: unknown }).kind;
  if (typeof kind !== "string" || !KNOWN_KINDS.has(kind)) return null;
  return payload as GenerateEvent;
}

export interface RunStreamHandlers {
  onEvent: (event: GenerateEvent) => void;
  /** 连接异常。重连交给浏览器（EventSource 自己会重连），这里只做提示。 */
  onError?: (message: string) => void;
}

/**
 * 打开一次运行的事件流，返回取消函数。
 * 路径与现有前端保持一致；后端上线后由 rewrite 转到 FastAPI，调用方不用改。
 */
export function openRunStream(runId: string, handlers: RunStreamHandlers): () => void {
  const source = new EventSource(`/api/runs/${encodeURIComponent(runId)}/generate`);

  source.onmessage = (message: MessageEvent<string>) => {
    const event = parseEvent(message.data);
    if (event) handlers.onEvent(event);
  };

  source.onerror = () => handlers.onError?.("事件流中断，请刷新或稍后重试");

  return () => source.close();
}
