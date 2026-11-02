/**
 * GET /api/runs/<id>/files/<path...>：读单个文件的内容（文件树点开时用）。
 *
 * 路径穿越由 workspace 的 safeRelativePath 挡住；这里只负责挑 content-type。
 */

import { sqliteRunStore } from "@/adapters/store/run-repo";
import { readRunFile } from "@/adapters/store/workspace";
import { getOwnedRun } from "@/core/run/service";
import { getCurrentUser } from "@/server/auth-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TEXT = "text/plain; charset=utf-8";

/** 只认这几种；其余一律按纯文本给，避免浏览器把产物当页面执行 */
const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  sql: TEXT,
  py: TEXT,
  md: TEXT,
  txt: TEXT,
  yml: TEXT,
  yaml: TEXT,
  toml: TEXT,
  env: TEXT,
};

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; path: string[] }> },
): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return new Response("未登录", { status: 401 });

  const { id, path: segments } = await params;

  const run = await getOwnedRun(sqliteRunStore, id, user.id);
  if (!run) return new Response("找不到该构建", { status: 404 });

  const relPath = (segments ?? []).join("/");
  try {
    const content = await readRunFile(run.id, relPath);
    const ext = relPath.split(".").pop()?.toLowerCase() ?? "";
    return new Response(content, {
      headers: {
        "Content-Type": CONTENT_TYPES[ext] ?? TEXT,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    // 非法路径与不存在在这里都算 404：不告诉对方"路径非法"和"文件没有"的区别
    return new Response("找不到该文件", { status: 404 });
  }
}
