/**
 * 产物内容接口
 * ============================================================
 * GET /api/runs/<运行id>/artifact
 *
 * 把生成出来的 HTML 原样吐出来，供预览区的 iframe 加载。
 *
 * ⚠️ 这个接口有一个绕不开的安全问题，必须正面处理：
 *   生成出来的页面是**模型写的代码**，里面带着它自己写的 JavaScript。
 *   如果原样从我们自己的域名下返回，那段脚本就运行在**我们的源**上 ——
 *   它可以拿着用户的 Cookie 去调我们的接口，等于把用户的身份借给了
 *   一段没人审过的代码。
 *
 * 三层缓解，每一层挡不同的东西：
 *
 *   ① iframe 的 sandbox 属性（在预览组件里）
 *      不给 allow-top-navigation，它就不能把整页跳走；
 *      不给 allow-forms，它就不能伪造表单提交。
 *      注意：这里必须给 allow-same-origin，否则 localStorage 不可用，
 *      而生成的应用恰恰靠它做数据持久化 —— 那会让预览功能废掉。
 *
 *   ② 这张响应上的 CSP（本文件）
 *      connect-src 'none' 是**最关键的一条**：它切断了 fetch / XHR /
 *      WebSocket / sendBeacon，也就是切断了「把数据送出去」的所有通道。
 *      即使生成的代码里有恶意逻辑，它也传不出去。
 *      再配上 form-action 'none' 与 base-uri 'none'，把旁路也堵上。
 *
 *   ③ 归属校验（和生成接口同一套）
 *      别人的产物一律 404，不泄露 id 是否有效。
 *
 * 剩下的风险：生成的脚本仍能读写同源的 localStorage。
 * 我们没有把任何敏感数据放在 localStorage 里（会话走 httpOnly Cookie），
 * 所以这一条可以接受。彻底隔离需要独立域名或独立端口，列入后续计划。
 */

import { fsArtifactStore } from "@/adapters/store/artifact-repo";
import { sqliteRunStore } from "@/adapters/store/run-repo";
import { getOwnedRun } from "@/core/run/service";
import { getCurrentUser } from "@/server/auth-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 预览沙箱的内容安全策略，逐条的用意见文件头的说明 */
const SANDBOX_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'",
  "img-src data:",
  "font-src data:",
  // 关键的一条：切断一切对外发送数据的通道
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  // 只允许我们自己把它放进 iframe
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
  // 返回 404 而不是 403，避免泄露「这个 id 是真实存在的」
  if (!run) return new Response("找不到该构建", { status: 404 });

  const artifact = await fsArtifactStore.findLatest(run.id, "html");
  if (!artifact) return new Response("这次构建还没有产物", { status: 404 });

  const content = await fsArtifactStore.readContent(artifact);
  if (content === null) {
    // 登记还在但文件没了 —— 属于数据不一致，明确说出来而不是返回空页面
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

/** 下载产物：同一份内容，但带上文件名，让浏览器直接存盘 */
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
      // 文件名用运行 id 的前 8 位，便于用户区分多次生成的结果
      "Content-Disposition": `attachment; filename="nexus-${run.id.slice(0, 8)}.html"`,
      "Cache-Control": "no-store",
    },
  });
}