/**
 * 导出接口
 * ============================================================
 * GET /api/runs/<运行id>/export
 *
 * 把一条运行压成**一个文件**吐出来：抬头 + 全部事件 + 全部产物 + 成本流水。
 * 用户存下它，换一台电脑从「导入」放回去，清单 / 画布 / 产物 / 事件
 * 应当与导出前**逐项一致**。
 *
 * ── 为什么是一个文件而不是一个 zip ──
 *   一个 JSON 就能被任何东西读（文本编辑器、diff、jq、答辩时当场打开看），
 *   而 zip 要先解压才知道里面是什么。这个项目的核心主张是"全程可见"，
 *   导出物本身也应该一眼看得见。
 *   代价是体积 —— 所以下面有大小上限与 `skipped` 如实记录。
 *
 * ── 为什么归属校验返回 404 而不是 403 ──
 *   和 generate / artifact 两条接口同一个理由：403 等于告诉对方
 *   "这个 id 是真实存在的，只是不属于你"，那本身就是一条泄漏。
 *
 * ── 为什么有体积上限 ──
 *   产物是模型写的单文件 HTML，正常几十 KB，但没有硬性上限。
 *   一个几百 MB 的响应会把浏览器和内存一起拖垮，
 *   而用户真正想要的是"这条运行的记录"，不是"把整个磁盘搬走"。
 *   所以：单个 > 1MB 的不带，总量 > 4MB 之后不再带。
 *   ⚠️ 两条路都**写进 skipped**，绝不悄悄丢 ——
 *      否则用户在另一台电脑上会发现少了东西，却不知道为什么。
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

/** 单个产物的上限：超过它就不往文件里塞 */
const MAX_ARTIFACT_BYTES = 1_048_576; // 1MB
/** 全部产物的总上限 */
const MAX_TOTAL_BYTES = 4_194_304; // 4MB

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
  const stored = await fsArtifactStore.listByRun(run.id);
  const costs = await sqliteCostStore.listByRun(run.id);

  /* ---------- 打包产物，超限的如实记进 skipped ---------- */
  const packed: NexusExport["artifacts"] = [];
  const skipped: NexusExport["skipped"] = [];
  let totalBytes = 0;
  /*
    总量到顶之后**不再读盘**（读本身就是最贵的一步），
    但仍然逐条记进 skipped —— "停止打包"不等于"当它不存在"。
  */
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
      // 登记还在但文件没了 —— 属于数据不一致，明说，不当作"没有这个产物"
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
    // at 一起带上：回放的时间轴靠它（理由见 core/domain/export.ts）
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
      /*
        ---------- 两个文件名 ----------
        filename= 是 ASCII 兜底（老浏览器只认它，所以固定写一个合法的）；
        filename*= 才是真名 —— 中文按 RFC 5987 做百分号编码。
        只写中文那一个的话，某些浏览器会把文件名里的中文丢掉，
        用户拿到一个没有名字后缀的下载。

        ⚠️ 真名由 exportFileName 洗过：路径分隔符、Windows 保留字符、
           控制字符、首尾的点全部去掉了。文件名来自用户那句话，
           不洗的话它能决定这个文件被存到哪里去。
      */
      "Content-Disposition":
        `attachment; filename="nexus-run.nexus.json"; ` +
        `filename*=UTF-8''${encodeURIComponent(realName)}`,
      // 导出的是"此刻的库"，任何一层缓存都会让用户拿到上一次的文件
      "Cache-Control": "no-store",
    },
  });
}