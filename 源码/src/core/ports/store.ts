/**
 * 状态存储端口 —— 内核与「持久化」之间的唯一契约
 * ============================================================
 * 断点续跑的物理基础：每个节点干完，把输出存起来；
 * 重跑时按顺序命中即跳过，直接读上次的结果，而不是重新执行。
 *
 * 为什么不用「每个节点打一个 git 提交」：
 *   git 只能回滚文件，回滚不了已经发出去的请求、已经花掉的钱；
 *   多个执行 Agent 并行往同一条历史里提交会互相污染；
 *   重跑一个调过模型的节点等于重新抽样，拿不到上次的产物。
 */

import type { StageId, StageStatus, FaultClass } from "../pipeline/stages";
import type { TokenUsage } from "./model";

/** 节点的重放等级 —— 决定重跑时该复用还是该重算 */
export type ReplayLevel =
  | "deterministic" // 纯计算，重跑结果一致，可直接重算
  | "memoizable" // 有外部调用，但结果可存可复用（调模型属于此类）
  | "non_replayable"; // 有不可逆副作用（推分支、发部署），只能复用不可重算

export interface NodeRecord {
  id: string;
  runId: string;
  stage: StageId;
  /** 并行扇出时的分组标识，同组并行 */
  groupId: string;
  label: string;
  status: "queued" | "running" | "passed" | "failed" | "skipped";
  /** 单调递增，决定重放顺序 */
  sequence: number;
  replayLevel: ReplayLevel;
  /** 幂等键 */
  idempotencyKey: string;
  /** 副作用清单，例如 ["llm_call", "file_write", "git_push"] */
  sideEffects: string[];
  /** 输入指纹，用于判断缓存是否命中 */
  inputsHash: string;
  /** 产物：内容寻址（并行构建时避免互相污染） */
  outputs: Array<{ kind: "artifact" | "memo" | "pointer"; address: string }>;
  /** 产出该节点时的工作流版本 —— 失效传播的判据 */
  producerVersion: string;
  /** 失败时 */
  fault?: FaultClass;
  faultReason?: string;
  usage?: TokenUsage;
  costCny: number;
  startedAt?: number;
  finishedAt?: number;
}

export interface RunRecord {
  id: string;
  /** 用户输入的那一句话 */
  prompt: string;
  /** 当前阶段 */
  stage: StageId;
  status: "running" | "paused" | "done" | "failed" | "cancelled";
  /** 工作流版本，用于判断旧产物与新代码是否兼容 */
  workflowVersion: string;
  totalCostCny: number;
  usage: TokenUsage;
  createdAt: number;
  updatedAt: number;
}

export interface StageRecord {
  runId: string;
  stage: StageId;
  status: StageStatus;
  /** 本阶段产出的结构化产物（已解析） */
  artifact?: unknown;
  costCny: number;
  attempts: number;
  startedAt?: number;
  finishedAt?: number;
}

export interface StorePort {
  createRun(input: { prompt: string; workflowVersion: string }): Promise<RunRecord>;
  getRun(runId: string): Promise<RunRecord | null>;
  updateRun(runId: string, patch: Partial<RunRecord>): Promise<void>;
  listRuns(limit?: number): Promise<RunRecord[]>;

  upsertStage(record: StageRecord): Promise<void>;
  listStages(runId: string): Promise<StageRecord[]>;

  saveNode(record: NodeRecord): Promise<void>;
  getNode(runId: string, nodeId: string): Promise<NodeRecord | null>;
  listNodes(runId: string, stage?: StageId): Promise<NodeRecord[]>;
  /** 查缓存：同输入指纹且版本兼容的已完成节点 */
  findReusableNode(
    runId: string,
    inputsHash: string,
    workflowVersion: string,
  ): Promise<NodeRecord | null>;
}