"use server";

/**
 * 运行相关的服务端动作
 * ============================================================
 * 创建运行与删除运行。创建之后不会立刻执行 AI ——
 * 执行由编排内核在后台推进，页面立刻拿到记录、不阻塞。
 */

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { sqliteRunStore } from "@/adapters/store/run-repo";
import { env } from "@/config/env";
import { createRun, deleteRun } from "@/core/run/service";
import { getCurrentUser } from "@/server/auth-context";

export interface RunFormState {
  error?: string;
  /** 回填用户已输入的内容，避免重新打字 */
  value?: string;
}

export async function createRunAction(
  _prev: RunFormState,
  formData: FormData,
): Promise<RunFormState> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const prompt = String(formData.get("prompt") ?? "");

  const result = await createRun(sqliteRunStore, {
    userId: user.id,
    prompt,
    workflowVersion: env.run.workflowVersion,
  });

  if (!result.ok) {
    return { error: result.reason, value: prompt };
  }

  // 让工作台的服务端组件重新取数据，新记录立刻出现在列表里
  revalidatePath("/studio");
  redirect(`/studio?run=${result.value.id}`);
}

export async function deleteRunAction(formData: FormData): Promise<void> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const runId = String(formData.get("runId") ?? "");
  if (!runId) return;

  await deleteRun(sqliteRunStore, runId, user.id);
  revalidatePath("/studio");
  redirect("/studio");
}