/**
 * GET/POST /api/runs/<id>/artifact：返回最新 html 产物，GET 供预览 iframe，POST 供下载。
 * 产物是模型写的代码，必须带 CSP 与 iframe sandbox：connect-src 'none' 切断数据外传。
 * 同源 localStorage 仍可读写，因未存放敏感数据（会话走 httpOnly Cookie）而可接受。
 */

import { fsArtifactStore } from "@/adapters/store/artifact-repo";
import { sqliteRunStore } from "@/adapters/store/run-repo";
import { getOwnedRun } from "@/core/run/service";
import { getCurrentUser } from "@/server/auth-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 预览沙箱的内容安全策略 */
const SANDBOX_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'",
  "img-src data:",
  "font-src data:",
  // 关键：切断一切对外发送通道
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  // 只允许本站把它放进 iframe
  "frame-ancestors 'self'",
].join("; ");

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return new Response("未登录", { status: 401 });

  const { id } = await params;
  const run = await getOwnedRun(sqliteRunStore, id, user.id);
  // 404 而非 403：不泄露 id 是否存在，与生成接口同一套归属校验
  if (!run) return new Response("找不到该构建", { status: 404 });

  const artifact = await fsArtifactStore.findLatest(run.id, "html");
  if (!artifact) return new Response("这次构建还没有产物", { status: 404 });

  const content = await fsArtifactStore.readContent(artifact);
  if (content === null) {
    // 登记还在但文件没了，属数据不一致，返回 410 而非空页
    return new Response("产物文件已丢失，请重新生成", { status: 410 });
  }

  return new Response(content, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": SANDBOX_CSP,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/** 下载同一份内容，附文件名让浏览器存盘 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return new Response("未登录", { status: 401 });

  const { id } = await params;
  const run = await getOwnedRun(sqliteRunStore, id, user.id);
  if (!run) return new Response("找不到该构建", { status: 404 });

  const artifact = await fsArtifactStore.findLatest(run.id, "html");
  if (!artifact) return new Response("这次构建还没有产物", { status: 404 });

  const content = await fsArtifactStore.readContent(artifact);
  if (content === null) return new Response("产物文件已丢失", { status: 410 });

  return new Response(content, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // 文件名取运行 id 前 8 位，便于区分多次生成
      "Content-Disposition": `attachment; filename="nexus-${run.id.slice(0, 8)}.html"`,
      "Cache-Control": "no-store",
    },
  });
}