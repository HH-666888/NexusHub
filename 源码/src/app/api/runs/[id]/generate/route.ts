/**
 * 流式生成接口（SSE）
 * ============================================================
 * GET /api/runs/<运行id>/generate
 *
 * 为什么用 SSE 而不是 WebSocket：
 *   这里是单向的「服务器持续往客户端推」，SSE 正好；
 *   而且它基于普通 HTTP，不需要额外的协议升级与心跳处理。
 *   WebSocket 要用在真正双向的场景（比如协作编辑），这里用不上。
 *
 * 为什么用 GET：
 *   EventSource 只支持 GET。这是一个「有副作用的 GET」，
 *   严格来说不符合 HTTP 语义，但这是 SSE 的通行做法。
 *   我们靠下面的幂等保护来消除重复触发的风险。
 *
 * ⚠️ 一次点击只花一次钱：
 *   浏览器刷新会让 EventSource 自动重连，如果不加保护就会重复调用模型。
 *   所以这里先查是否已经产出过成品 —— 有就直接回放，不再花钱。
 */

import { fsArtifactStore } from "@/adapters/store/artifact-repo";
import { sqliteCostStore } from "@/adapters/store/cost-repo";
import { sqliteRunStore } from "@/adapters/store/run-repo";
import { createDeepSeekPort } from "@/adapters/model/deepseek";
import { resolveModelEndpoint } from "@/adapters/model/resolve-endpoint";
import { env } from "@/config/env";
import { generateApp, type GenerateEvent } from "@/core/generate/service";
import { getOwnedRun } from "@/core/run/service";
import { getCurrentUser } from "@/server/auth-context";

/** 必须显式声明 Node 运行时：会话校验要用 better-sqlite3，Edge 跑不了 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) {
    return new Response("未登录", { status: 401 });
  }

  const { id } = await params;
  const run = await getOwnedRun(sqliteRunStore, id, user.id);
  if (!run) {
    // 返回 404 而不是 403：不泄露「这个 id 是真实存在的」
    return new Response("找不到该构建", { status: 404 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: GenerateEvent) => {
        if (closed) return;
        try {
          // SSE 格式：data: <一行 JSON>\n\n
          // 用 JSON 而不是多行文本，是为了让事件里可以安全包含换行
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
          );
        } catch {
          // 客户端断开后 enqueue 会抛错，标记为已关闭即可
          closed = true;
        }
      };

      try {
        // ---------- 幂等保护：已经出过成品就直接回放，不再花钱 ----------
        // 浏览器刷新会让 EventSource 自动重连，没有这道闸门就会重复调用模型。
        // 想重新生成请先 DELETE（它会清掉产物），这是刻意的：
        // 「重新生成」应该是一个明确动作，而不是刷新的副作用。
        const existing = await fsArtifactStore.findLatest(run.id, "html");
        if (existing) {
          send({
            kind: "phase",
            phase: "done",
            label: "已有成品，直接回放（本次未产生费用）",
          });
          send({ kind: "artifact", artifact: existing });
          return;
        }

        // ---------- 决定这次用哪套模型接入 ----------
        // 用户配了自定义就用他自己的；配了但没配全则明确拒绝，
        // 不静默退回平台配置 —— 那会在用户不知情的情况下花掉平台的额度
        const resolved = await resolveModelEndpoint();
        if (!resolved.ready) {
          send({
            kind: "error",
            message: `自定义模型接入配置不完整：${resolved.reason ?? "请到设置页补全"}`,
            hint: "到「设置 → 模型接入」补齐，或切回「使用平台默认接入」",
          });
          send({ kind: "phase", phase: "failed", label: "配置不完整" });
          return;
        }

        const spent = await sqliteCostStore.totalByRun(run.id);

        for await (const event of generateApp(
          {
            // 按解析结果创建端口。适配器本身不知道「配置」这回事，
            // 它只是被绑定到了某一组接入信息上
            model: createDeepSeekPort(resolved.endpoint),
            artifacts: fsArtifactStore,
            runs: sqliteRunStore,
            costs: sqliteCostStore,
          },
          {
            runId: run.id,
            prompt: run.prompt,
            costLimitCny: env.run.costLimitCny,
            spentCny: spent,
          },
        )) {
          send(event);
        }
      } catch (err) {
        send({
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        closed = true;
        try {
          controller.close();
        } catch {
          // 已经关了就算了
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      // 三层都不缓存：任何一层缓存了，用户就会看到「卡住不动」
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // 部署到 nginx 后面时，这一条是让 SSE 不被缓冲的关键
      "X-Accel-Buffering": "no",
    },
  });
}

/** 删除产物：清掉文件和登记，让「重新生成」从干净状态开始 */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return new Response("未登录", { status: 401 });

  const { id } = await params;
  const run = await getOwnedRun(sqliteRunStore, id, user.id);
  if (!run) return new Response("找不到该构建", { status: 404 });

  // removeByRun 已经把文件与登记一并清掉，这里不需要再删一次
  const removed = await fsArtifactStore.removeByRun(run.id);

  // 刻意不清零 totalCostCny：那是「这条运行一共花了多少钱」的真实记录。
  // 清掉它只会制造一个好看但虚假的数字 —— 钱是真花出去了。
  // 预算闸门读的是成本流水表，所以清零也不能让下一次重跑「变便宜」。
  await sqliteRunStore.update(run.id, { status: "cancelled" });

  return Response.json({ removed });
}