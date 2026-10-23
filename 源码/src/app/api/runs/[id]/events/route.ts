/**
 * 运行事件接口
 * ============================================================
 * GET /api/runs/<运行id>/events
 *
 * 回放用。返回这次运行落库的全部事件，按序号正序。
 *
 * 为什么一次性返回而不是分页：
 *   合并之后一次生成的事件通常在几十到几百条，
 *   而回放需要**整段**才能算总时长、才能任意拖动。
 *   分页反而会让拖动变得不可用 —— 拖到没加载的那一段就断了。
 *
 * 为什么要带 hasMore 之外的统计：
 *   界面要显示「这是第几次生成、跑了多久」，
 *   这些从事件本身算比再开一个接口便宜。
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
  // 404 而不是 403：不泄露「这个 id 是真实存在的」
  if (!run) return new Response("找不到该构建", { status: 404 });

  const events = await sqliteEventStore.listByRun(run.id);

  return Response.json({
    runId: run.id,
    count: events.length,
    durationMs: replayDurationMs(events),
    events,
  });
}