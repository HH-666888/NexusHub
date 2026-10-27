/**
 * 运行的领域模型：一句话需求、当前阶段、累计花费。
 */

import { randomUUID } from "node:crypto";
import type { StageId } from "../pipeline/stages";
import type { TokenUsage } from "../ports/model";

export type RunStatus =
  | "running"
  | "paused" // 停在人工确认点
  | "done"
  | "failed"
  | "cancelled"; // 用户主动中止

export interface Run {
  id: string;
  userId: number;
  /** 用户原话，全流程的起点 */
  prompt: string;
  stage: StageId;
  status: RunStatus;
  /** 工作流版本，失效传播的判据 */
  workflowVersion: string;
  totalCostCny: number;
  usage: TokenUsage;
  createdAt: number;
  updatedAt: number;
}

export type NewRun = Pick<Run, "userId" | "prompt" | "workflowVersion">;

/** 随机串，对外不可枚举 */
export function newRunId(): string {
  return randomUUID();
}

export const PROMPT_MIN = 4;
export const PROMPT_MAX = 500;

export interface PromptCheck {
  ok: boolean;
  reason?: string;
  /** 通过时返回归一化后的文本 */
  value?: string;
}

/**
 * 校验并归一化用户输入：去首尾空白、合并连续空白、去控制字符。
 * 粘贴进来的零宽字符与换行会破坏后续的字符串比较与去重。
 */
export function checkPrompt(raw: string): PromptCheck {
  const cleaned = raw
    .replace(/[\u0000-\u001F\u007F\u200B-\u200D\uFEFF]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned.length < PROMPT_MIN) {
    return { ok: false, reason: `描述太短了，至少 ${PROMPT_MIN} 个字` };
  }
  if (cleaned.length > PROMPT_MAX) {
    return { ok: false, reason: `描述太长了，最多 ${PROMPT_MAX} 个字` };
  }
  return { ok: true, value: cleaned };
}

/** 新建运行时的初值 */
export function emptyUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
  };
}

/** 界面标签 */
export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  running: "构建中",
  paused: "等你确认",
  done: "已完成",
  failed: "失败",
  cancelled: "已中止",
};

/** 时间戳转成人话：刚刚 / 3 分钟前 / 昨天。纯计算，放领域层是为了能单测 */
export function describeTime(ts: number, now: number): string {
  const diff = now - ts;
  if (diff < 0) return "刚刚";
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diff < minute) return "刚刚";
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 2 * day) return "昨天";
  if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`;
  return new Date(ts).toLocaleDateString("zh-CN");
}