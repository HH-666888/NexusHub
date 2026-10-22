/**
 * 事件端口 —— 内核向外播报「正在发生什么」的唯一通道
 * ============================================================
 * 内核不认识 SSE、不认识 WebSocket。它只往这里发事件，
 * 由 adapters 决定怎么送到浏览器。
 *
 * 界面消费这些事件，把「流程可视化」变成「结构可视化」：
 * 阶段卡片显示的不是模糊的「进行中」，而是契约满足情况与成本。
 */

import type { StageId, StageStatus, FaultClass } from "../pipeline/stages";
import type { TokenUsage } from "./model";

export type RunEvent =
  /** 阶段状态变化 */
  | {
      type: "stage";
      stage: StageId;
      status: StageStatus;
      at: number;
    }
  /** 阶段产物已产出并通过（或未通过）契约校验 */
  | {
      type: "contract";
      stage: StageId;
      artifact: string;
      satisfied: boolean;
      /** 未满足时的具体原因 */
      violations: string[];
      at: number;
    }
  /** 任务图节点状态变化 —— 界面据此让节点亮起 / 变红 */
  | {
      type: "node";
      nodeId: string;
      stage: StageId;
      label: string;
      status: "queued" | "running" | "passed" | "failed";
      at: number;
    }
  /** 失败归因结论 —— 界面直接显示中文结论，而不是一串日志 */
  | {
      type: "attribution";
      nodeId: string;
      fault: FaultClass;
      reason: string;
      action: string;
      at: number;
    }
  /** 模型的思考片段（AI 思考状态可视化的数据源） */
  | {
      type: "thought";
      nodeId: string;
      delta: string;
      at: number;
    }
  /** 成本更新 */
  | {
      type: "cost";
      totalCny: number;
      usage: TokenUsage;
      at: number;
    }
  /** 需要人工确认，流程在此暂停 */
  | {
      type: "attention";
      stage: StageId;
      title: string;
      detail: string;
      options: string[];
      at: number;
    }
  /** 普通日志 */
  | {
      type: "log";
      level: "info" | "warn" | "error";
      message: string;
      at: number;
    };

export type RunEventInput = Omit<RunEvent, "at"> & { at?: number };

export interface EventPort {
  /** 发布事件。内核不关心有没有人听 */
  emit(runId: string, event: RunEventInput): void;
  /** 订阅某个运行的事件流，返回取消订阅函数 */
  subscribe(runId: string, listener: (event: RunEvent) => void): () => void;
}