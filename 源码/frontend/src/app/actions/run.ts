"use server";

/**
 * 运行相关的服务端动作：创建与删除。
 * 创建只落库，执行由编排内核在后台推进。
 */

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { sqliteRunStore } from "@/adapters/store/run-repo";
import { env } from "@/config/env";
import { createRun, deleteRun } from "@/core/run/service";
import { getCurrentUser } from "@/server/auth-context";

export interface RunFormState {
  error?: string;
  /** 回填已输入内容 */
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

  // 建完直接跳画布并带上 run id：/studio 已退役，只去 /canvas 会落到默认最近一条，
  // 并发建两条时会指错。revalidatePath 让列表立刻包含新记录。
  revalidatePath("/canvas");
  redirect(`/canvas?run=${result.value.id}`);
}

export async function deleteRunAction(formData: FormData): Promise<void> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const runId = String(formData.get("runId") ?? "");
  if (!runId) return;

  await deleteRun(sqliteRunStore, runId, user.id);
  // 删完回画布：工作台 /studio 已退役，与创建后的跳转目标一致。
  revalidatePath("/canvas");
  redirect("/canvas");
}
