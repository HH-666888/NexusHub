/**
 * GET /api/runs/<id>/events：按序号正序返回该运行的全部事件，供回放使用。
 * 一次性返回而非分页：回放需要整段数据算总时长并支持任意拖动。
 * 顺带给出时长统计，省去为界面展示再开一个接口。
 * 分页会让拖动断在未加载的那一段。
 */

import { sqliteEventStore } from "@/adapters/store/event-repo";
import { sqliteRunStore } from "@/adapters/store/run-repo";
import { replayDurationMs } from "@/core/domain/run-event";
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
  // 404 而非 403：不泄露该 id 是否存在，与其它运行接口口径一致
  if (!run) return new Response("找不到该构建", { status: 404 });

  const events = await sqliteEventStore.listByRun(run.id);

  return Response.json({
    runId: run.id,
    count: events.length,
    durationMs: replayDurationMs(events),
    events,
  });
}