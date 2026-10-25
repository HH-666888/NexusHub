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

  /*
    建完直接送到**画布**上，并且带上这条运行的 id。

    以前送到 /studio?run=…。工作台退役之后那条路不改的话，
    用户点完「↑」会落到一个界面上再也没有入口的页面上 —— 那是死路。

    带上 run 参数而不是光去 /canvas：不传的话页面会默认选最近一条，
    虽然此刻最近一条就是它，但"靠默认"和"明确指过去"是两回事 ——
    并发建两条时前者会指错。
  */
  revalidatePath("/canvas");
  redirect(`/canvas?run=${result.value.id}`);
}

export async function deleteRunAction(formData: FormData): Promise<void> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const runId = String(formData.get("runId") ?? "");
  if (!runId) return;

  await deleteRun(sqliteRunStore, runId, user.id);
  /*
    删完回画布，不回工作台 ——
    画布现在是主界面，工作台（/studio）已经退役。
    删一条记录却把人送到一个"不再入口"的页面上，是说不通的。
  */
  revalidatePath("/canvas");
  redirect("/canvas");
}