/**
 * 回流：把上一次没通过的检查项拼进下一次的提示词。
 * 只带没过的项、说明是上一轮、detail 为空时不替模型猜原因。
 */

import type { RunEvent } from "../domain/run-event";

/** 上一次尝试留下的东西 */
export interface PreviousAttempt {
  /** 上一次没过的检查项，空表示全过 */
  failures: Array<{ name: string; detail: string }>;
  /** 上一次检查了几项、过了几项 */
  total: number;
  passed: number;
  /** 上一次是否产出成品 */
  hadArtifact: boolean;
  /** 上一次中断的错误信息 */
  error: string | null;
}

/** 取最后一次 check 事件作为最终结论；没有记录时返回 null */
export function extractPreviousAttempt(
  events: readonly RunEvent[],
): PreviousAttempt | null {
  if (events.length === 0) return null;

  let lastCheck: Extract<RunEvent["payload"], { kind: "check" }> | null = null;
  let hadArtifact = false;
  let error: string | null = null;

  for (const e of events) {
    const p = e.payload;
    if (p.kind === "check") {
      lastCheck = p; // 取最后一条
    } else if (p.kind === "artifact") {
      hadArtifact = true;
    } else if (p.kind === "error") {
      error = p.message;
    }
  }

  // 既无 check 也无 error 说明连检查都没跑到，没有可回流的内容
  if (!lastCheck && !error) return null;

  return {
    failures: (lastCheck?.summary.failures ?? []).map((f) => ({
      name: f.name,
      detail: f.detail,
    })),
    total: lastCheck?.summary.total ?? 0,
    passed: lastCheck?.summary.passed ?? 0,
    hadArtifact,
    error,
  };
}


export const CALLBACK_ARTIFACT_NAME = "callback.json";

/** 没有上一次、上一次全过、且无错误时没有可回流的 */
export function hasSomethingToFeedBack(prev: PreviousAttempt | null): boolean {
  if (!prev) return false;
  if (prev.failures.length > 0) return true;
  // 跑挂了也算，中断位置对模型有用
  return prev.error !== null;
}

/** 拼给模型的上下文；无可带内容返回 null，调用方据此不加这条消息 */
export function buildCallbackContext(prev: PreviousAttempt | null): string | null {
  if (!hasSomethingToFeedBack(prev) || !prev) return null;

  const lines: string[] = [
    "【上一轮的结果】",
    "同一句话之前已经生成过一次，下面是那一次**没有通过**的地方。",
    "请这一次直接避开这些问题。",
    "",
  ];

  if (prev.error) {
    lines.push(
      `上一轮没有跑完就中断了：${prev.error}`,
      "这一次请更保守一些，把结构做简单、能一次跑通优先。",
      "",
    );
  }

  if (prev.failures.length > 0) {
    lines.push(`上一轮 ${prev.total} 项检查里过了 ${prev.passed} 项，没过的是：`);
    for (const f of prev.failures) {
      // detail 为空只写名字，不替用户编原因
      lines.push(f.detail.trim() ? `  · ${f.name}：${f.detail}` : `  · ${f.name}`);
    }
  }

  return lines.join("\n");
}

/** 一句人话说明带上了什么，用户看得见 */
export function describeCallback(prev: PreviousAttempt | null): string | null {
  if (!hasSomethingToFeedBack(prev) || !prev) return null;

  const parts: string[] = [];
  if (prev.error) parts.push("上一轮中断的原因");
  if (prev.failures.length > 0) {
    parts.push(`上一轮没过的 ${prev.failures.length} 项检查`);
  }
  return `带上了${parts.join("和")}，让这一次别再犯`;
}

/** callback.json 的内容：喂给模型的原文存下来，事后可查 */
export interface CallbackRecord {
  runId: string;
  /** 上一轮没过的那几项 */
  failures: Array<{ name: string; detail: string }>;
  previousTotal: number;
  previousPassed: number;
  previousError: string | null;
  /** 拼进模型上下文的原文，存下来不重算 */
  context: string;
  at: number;
}

export function buildCallbackRecord(
  runId: string,
  prev: PreviousAttempt,
  context: string,
  now: number,
): CallbackRecord {
  return {
    runId,
    failures: prev.failures,
    previousTotal: prev.total,
    previousPassed: prev.passed,
    previousError: prev.error,
    // 存拼好的原文而非 prev，避免措辞变更后历史文件与当时内容不符
    context,
    at: now,
  };
}