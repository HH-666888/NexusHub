/**
 * 运行服务
 * ============================================================
 * 创建、查询、选中「运行」的业务规则。
 * 只依赖 RunStore 接口，不依赖任何数据库 —— 可以注入假存储做单测。
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
 * 创建一次运行。
 *
 * 注意这里只做两件事：校验输入、落库。
 * 它**不会**去执行任何 AI 调用 —— 执行是编排内核的职责，
 * 由后台任务异步推进。这样用户点「开始构建」之后能立刻看到记录出现，
 * 而不是卡在页面上等三十秒。
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
 * 取某用户的一条运行。
 *
 * 之所以要带上 userId：运行 id 是随机串，但仍然必须校验归属，
 * 否则任何登录用户只要猜到 id 就能看别人的构建内容。
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

/** 列出某用户的构建记录 */
export async function listRuns(
  store: RunStore,
  userId: number,
  limit?: number,
): Promise<Run[]> {
  return store.listByUser(userId, limit);
}

/** 删除一条记录（同样校验归属） */
export async function deleteRun(
  store: RunStore,
  runId: string,
  userId: number,
): Promise<boolean> {
  return store.remove(runId, userId);
}