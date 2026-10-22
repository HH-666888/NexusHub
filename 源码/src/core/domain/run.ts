/**
 * 运行的领域模型
 * ============================================================
 * 「运行」是整套系统的主线对象：它记住用户要做什么、现在走到哪、
 * 花了多少钱。六个阶段都是围绕它展开的。
 */

import { randomUUID } from "node:crypto";
import type { StageId } from "../pipeline/stages";
import type { TokenUsage } from "../ports/model";

export type RunStatus =
  | "running" // 正在自动执行
  | "paused" // 停在人工确认点，等用户回答
  | "done" // 全部验收标准通过，已交付
  | "failed" // 失败且无法自动恢复
  | "cancelled"; // 用户主动中止

export interface Run {
  id: string;
  userId: number;
  /** 用户输入的那一句话 —— 全流程的起点 */
  prompt: string;
  /** 当前所处阶段 */
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

/* ============================================================
   规则与工具（纯函数，可单测）
   ============================================================ */

/** 主键：随机串，对外不可枚举 */
export function newRunId(): string {
  return randomUUID();
}

/** 一句话输入的上下限 */
export const PROMPT_MIN = 4;
export const PROMPT_MAX = 500;

export interface PromptCheck {
  ok: boolean;
  reason?: string;
  /** 通过时返回归一化后的文本 */
  value?: string;
}

/**
 * 校验并归一化用户输入。
 *
 * 归一化做三件事：去首尾空白、合并连续空白、去掉控制字符。
 * 最后一条容易被忽略 —— 从别处粘贴进来时经常夹带零宽字符或换行，
 * 它们会让后续的字符串比较与去重出现莫名其妙的失败。
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

/** 空的用量，用于新建运行时的初值 */
export function emptyUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
  };
}

/** 中文状态标签（界面用） */
export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  running: "构建中",
  paused: "等你确认",
  done: "已完成",
  failed: "失败",
  cancelled: "已中止",
};

/**
 * 把时间戳转成「刚刚 / 3 分钟前 / 昨天 14:30」这种人话。
 * 放在领域层而不是组件里：它是一段纯计算，可以被单测覆盖。
 */
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