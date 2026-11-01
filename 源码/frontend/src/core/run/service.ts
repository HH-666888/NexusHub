/**
 * 运行服务：创建、查询、删除运行的业务规则。
 * 只依赖 RunStore 接口，可以注入假存储做单测。
 */

import { checkPrompt, type Run } from "../domain/run";
import type { RunStore } from "../ports/run-store";

export type RunResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface CreateRunInput {
  userId: number;
  prompt: string;
  workflowVersion: string;
}

/**
 * 只做两件事：校验输入、落库，不执行任何 AI 调用 —— 执行是编排内核的职责，
 * 由后台任务推进，用户点开始构建后能立刻看到记录出现。
 */
export async function createRun(
  store: RunStore,
  input: CreateRunInput,
): Promise<RunResult<Run>> {
  const check = checkPrompt(input.prompt);
  if (!check.ok || !check.value) {
    return { ok: false, reason: check.reason ?? "描述不符合要求" };
  }

  const run = await store.create({
    userId: input.userId,
    prompt: check.value,
    workflowVersion: input.workflowVersion,
  });

  return { ok: true, value: run };
}

/**
 * 取某用户的一条运行。运行 id 是随机串，但仍要校验归属，
 * 否则任何登录用户猜到 id 就能看别人的构建内容。
 */
export async function getOwnedRun(
  store: RunStore,
  runId: string,
  userId: number,
): Promise<Run | null> {
  const run = await store.findById(runId);
  if (!run) return null;
  if (run.userId !== userId) return null;
  return run;
}

/** 某用户的构建记录 */
export async function listRuns(
  store: RunStore,
  userId: number,
  limit?: number,
): Promise<Run[]> {
  return store.listByUser(userId, limit);
}

/** 同样校验归属 */
export async function deleteRun(
  store: RunStore,
  runId: string,
  userId: number,
): Promise<boolean> {
  return store.remove(runId, userId);
}
