/**
 * GET /api/runs/<id>/runtime：这个运行有没有在跑、预览地址是什么。
 *
 * 运行时状态存在后端（MySQL 的 run_runtimes），这里只做一层带归属校验的转发：
 * 浏览器拿不到内部口令，也不该直连后端端口。
 */

import { runtimeStatus } from "@/adapters/runtime/client";
import { sqliteRunStore } from "@/adapters/store/run-repo";
import { getOwnedRun } from "@/core/run/service";
import { getCurrentUser } from "@/server/auth-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return new Response("未登录", { status: 401 });

  const { id } = await params;
  const run = await getOwnedRun(sqliteRunStore, id, user.id);
  if (!run) return new Response("找不到该构建", { status: 404 });

  try {
    const status = await runtimeStatus(run.id);
    return Response.json(status, { headers: { "Cache-Control": "no-store" } });
  } catch {
    // 后端没起来不该让界面报错：当成"没在跑"，前端据此不显示预览入口
    return Response.json(
      { status: "unavailable" },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
}
