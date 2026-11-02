/**
 * GET /api/runs/<id>/download：把整个工程打成 zip 下载。
 *
 * 用 GET 而不是 POST：浏览器可以直接 <a href> 下载，前端不用绕 fetch+blob。
 */

import { zipFileName, zipRun } from "@/adapters/files/zip";
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

  const zipped = await zipRun(run.id);
  if (zipped.fileCount === 0) {
    return new Response("这次构建还没有产物", { status: 404 });
  }

  return new Response(zipped.bytes, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${zipFileName(run.id)}"`,
      "Cache-Control": "no-store",
    },
  });
}
