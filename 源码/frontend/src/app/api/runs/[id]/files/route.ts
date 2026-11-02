/**
 * GET /api/runs/<id>/files：列出这次运行生成的所有文件。
 *
 * 只读磁盘，不碰 artifacts 表 —— 全栈模式的真相是工作区目录（见 adapters/store/workspace）。
 * 没有清单时 manifest 返回 null，前端据此知道"这不是全栈产物"。
 */

import { sqliteRunStore } from "@/adapters/store/run-repo";
import { listRunFiles, readManifest } from "@/adapters/store/workspace";
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
  // 404 而非 403：不泄露 id 是否存在
  if (!run) return new Response("找不到该构建", { status: 404 });

  const [files, manifest] = await Promise.all([
    listRunFiles(run.id),
    readManifest(run.id),
  ]);

  return Response.json(
    { runId: run.id, manifest, files },
    { headers: { "Cache-Control": "no-store" } },
  );
}
