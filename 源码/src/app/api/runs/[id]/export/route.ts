/**
 * GET /api/runs/<id>/export：把一条运行导成单个 .nexus.json，含抬头、事件、产物与成本。
 * 单文件而非 zip，便于直接阅读与比对；代价是体积，故设上限并如实记入 skipped。
 * 单个产物超 1MB 或总量超 4MB 不再打包，两条路都写进 skipped。
 */

import { fsArtifactStore } from "@/adapters/store/artifact-repo";
import { sqliteCostStore } from "@/adapters/store/cost-repo";
import { sqliteEventStore } from "@/adapters/store/event-repo";
import { sqliteRunStore } from "@/adapters/store/run-repo";
import { byteLength } from "@/core/domain/artifact";
import { buildExport, exportFileName, type NexusExport } from "@/core/domain/export";
import { getOwnedRun } from "@/core/run/service";
import { getCurrentUser } from "@/server/auth-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 单个产物上限（1MB），超过则不写入文件 */
const MAX_ARTIFACT_BYTES = 1_048_576; // 1MB
/** 产物总量上限（4MB） */
const MAX_TOTAL_BYTES = 4_194_304; // 4MB

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

  const events = await sqliteEventStore.listByRun(run.id);
  const stored = await fsArtifactStore.listByRun(run.id);
  const costs = await sqliteCostStore.listByRun(run.id);

  const packed: NexusExport["artifacts"] = [];
  const skipped: NexusExport["skipped"] = [];
  let totalBytes = 0;
  // 总量到顶后不再读盘，但仍逐条记入 skipped：停止打包不等于当作不存在。
  // 读盘本身是最贵的一步。
  let budgetExhausted = false;

  for (const a of stored) {
    if (budgetExhausted) {
      skipped.push({
        path: a.path,
        reason: `产物总量已达 ${Math.round(MAX_TOTAL_BYTES / 1024 / 1024)}MB 上限，从这里开始不再打包`,
      });
      continue;
    }

    const content = await fsArtifactStore.readContent(a);
    if (content === null) {
      // 登记还在但文件没了，属数据不一致，明确记录而不是当作没有这个产物
      skipped.push({ path: a.path, reason: "文件读不到（登记还在，磁盘上已经没有这个文件）" });
      continue;
    }

    const bytes = byteLength(content);
    if (bytes > MAX_ARTIFACT_BYTES) {
      skipped.push({
        path: a.path,
        reason: `单个产物 ${bytes} 字节，超过 ${Math.round(MAX_ARTIFACT_BYTES / 1024)}KB 上限`,
      });
      continue;
    }

    if (totalBytes + bytes > MAX_TOTAL_BYTES) {
      skipped.push({
        path: a.path,
        reason: `产物总量已达 ${Math.round(MAX_TOTAL_BYTES / 1024 / 1024)}MB 上限，从这里开始不再打包`,
      });
      budgetExhausted = true;
      continue;
    }

    totalBytes += bytes;
    packed.push({ path: a.path, kind: a.kind, content });
  }

  const payload = buildExport({
    run: {
      id: run.id,
      prompt: run.prompt,
      stage: run.stage,
      status: run.status,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    },
    // at 一起带上：回放的时间轴靠它，缺了只能按 seq 猜时间
    events: events.map((e) => ({ seq: e.seq, at: e.at, payload: e.payload })),
    artifacts: packed,
    costs: costs.map((c) => ({
      stage: c.stage,
      model: c.model,
      inputTokens: c.usage.inputTokens,
      outputTokens: c.usage.outputTokens,
      reasoningTokens: c.usage.reasoningTokens,
      costCny: c.costCny,
      priceTier: c.priceTier,
      latencyMs: c.latencyMs,
      createdAt: c.createdAt,
      nodeId: c.nodeId,
      tier: c.tier,
      purpose: c.purpose,
      cacheHitTokens: c.usage.cacheHitTokens,
      cacheMissTokens: c.usage.cacheMissTokens,
    })),
    skipped,
    now: Date.now(),
  });

  const realName = exportFileName(run.prompt);

  return new Response(JSON.stringify(payload), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // filename= 是 ASCII 兜底，filename*= 才是真名，中文按 RFC 5987 编码。
      // 只写后者时部分浏览器会丢掉中文，用户拿到一个没有名字的下载。
      // 真名已由 exportFileName 洗过：路径分隔符、保留字符、首尾的点全部去掉。
      "Content-Disposition":
        `attachment; filename="nexus-run.nexus.json"; ` +
        `filename*=UTF-8''${encodeURIComponent(realName)}`,
      // 导出的是"此刻的库"，任何一层缓存都会让用户拿到上一次的文件
      // 内容随时会变，不能用 ETag 之类的协商缓存
      "Cache-Control": "no-store",
    },
  });
}