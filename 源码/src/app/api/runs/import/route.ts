/**
 * POST /api/runs/import：收 .nexus.json（multipart 的 file 字段），新建运行后 303 跳到画布。
 * 不认文件里的原 id：它可能属于别的账号或机器，照写会撞主键或覆盖他人运行。
 * 写入细节在 adapters/store/import-repo.ts；本层只做读取、报错与语义复核。
 */

import { importRun, type ImportRunPayload } from "@/adapters/store/import-repo";
import { env } from "@/config/env";
import type { ArtifactKind } from "@/core/domain/artifact";
import { EXPORT_FORMAT, EXPORT_VERSION, parseExport } from "@/core/domain/export";
import { RUN_STATUS_LABEL, type RunStatus } from "@/core/domain/run";
import type { RunEventKind } from "@/core/domain/run-event";
import { isStageId } from "@/core/pipeline/stages";
import { getCurrentUser } from "@/server/auth-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 落库时 kind 存为文本，读回来要收窄成合法值 */
const RUN_EVENT_KINDS: ReadonlySet<string> = new Set<RunEventKind>([
  "phase",
  "text",
  "reasoning",
  "spec",
  "arch",
  "ui",
  "modules",
  "usage",
  "check",
  "artifact",
  "error",
]);

const ARTIFACT_KINDS: ReadonlySet<string> = new Set<ArtifactKind>([
  "html",
  "json",
  "text",
]);

/** 400 + 具体原因，响应体形状固定为 { error } */
function reject(reason: string, status = 400): Response {
  return Response.json({ error: reason }, { status });
}

/**
 * 解析失败后的具体原因。只在 parseExport 返回 null 后调用，不重复校验规则。
 * format 与 version 单独说明，因为拖错文件和版本过新最常见。
 */
function describeShapeProblem(raw: unknown): string {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return "文件顶层不是一个对象 —— 这不是一个 Nexus 导出文件";
  }
  const o = raw as Record<string, unknown>;

  if (o.format !== EXPORT_FORMAT) {
    return `不是 nexus-run 导出文件（format = ${JSON.stringify(o.format)}）`;
  }
  if (o.version !== EXPORT_VERSION) {
    return (
      `版本不支持：这个文件是 version ${JSON.stringify(o.version)}，` +
      `本程序只认识 ${EXPORT_VERSION}。` +
      `请用与它相同（或更新）的版本打开 —— 当成 ${EXPORT_VERSION} 导入会悄悄丢掉不认识的东西`
    );
  }
  if (typeof o.run !== "object" || o.run === null) {
    return "缺少 run：文件里没有这次运行的抬头";
  }

  return (
    "导出文件的形状不对：run 里必须有非空的 id 与 prompt，" +
    "events / artifacts / costs 都必须是数组，" +
    "每条事件与产物本身也必须是对象（产物的 path 不能为空）"
  );
}

/** 从 payload 读取事件 kind，未知类型整份拒绝 */
function kindOfEvent(payload: unknown): RunEventKind | null {
  if (typeof payload !== "object" || payload === null) return null;
  const kind = (payload as { kind?: unknown }).kind;
  if (typeof kind !== "string" || !RUN_EVENT_KINDS.has(kind)) return null;
  return kind as RunEventKind;
}

export async function POST(req: Request): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return new Response("未登录", { status: 401 });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return reject("请求不是 multipart/form-data，或者表单在传输中被截断了");
  }

  const file = form.get("file");
  if (file === null || typeof file === "string") {
    return reject(
      `没有收到文件：字段名必须是 file（这次收到的字段：${[...form.keys()].join("、") || "一个都没有"}）`,
    );
  }

  const text = await file.text();
  if (text.trim() === "") return reject("文件是空的");

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return reject(`不是合法的 JSON：${err instanceof Error ? err.message : String(err)}`);
  }

  const bundle = parseExport(raw);
  if (!bundle) return reject(describeShapeProblem(raw));

  // stage/status 需额外复核：parseExport 只补缺失值，未知值会画出不存在的工序树。
  // 明确拒绝比画出一棵假树强。
  if (!isStageId(bundle.run.stage)) {
    return reject(`导出文件里的 stage 不是合法工序：「${bundle.run.stage}」`);
  }
  if (!Object.prototype.hasOwnProperty.call(RUN_STATUS_LABEL, bundle.run.status)) {
    return reject(`导出文件里的 status 不是合法状态：「${bundle.run.status}」`);
  }
  const status = bundle.run.status as RunStatus;

  const artifactKinds: ArtifactKind[] = [];
  for (const a of bundle.artifacts) {
    if (!ARTIFACT_KINDS.has(a.kind)) {
      return reject(`产物的 kind 不认识：「${a.kind}」（只认识 html / json / text）`);
    }
    artifactKinds.push(a.kind as ArtifactKind);
  }

  // 老导出文件没有事件 at：按创建时间 + seq 补齐以保持时间轴单调；无可信创建时间时用导入时刻。
  // seq 递增，于是回放拖起来不会来回跳。
  const created = bundle.run.createdAt > 0 ? bundle.run.createdAt : Date.now();

  const events: ImportRunPayload["events"] = [];
  for (const e of bundle.events) {
    const kind = kindOfEvent(e.payload);
    if (kind === null) {
      return reject(
        `事件（seq=${e.seq}）的载荷里没有可用的 kind —— 无法如实还原这次运行的过程`,
      );
    }
    events.push({ seq: e.seq, at: e.at ?? created + e.seq, kind, payload: e.payload });
  }

  const artifacts: ImportRunPayload["artifacts"] = bundle.artifacts.map((a, i) => ({
    path: a.path,
    kind: artifactKinds[i],
    content: a.content,
  }));

  const costs: ImportRunPayload["costs"] = bundle.costs.map((c) => ({
    stage: c.stage,
    nodeId: c.nodeId ?? null,
    // tier / purpose 是 cost_records 的 NOT NULL 列，老导出文件没有：默认 execute 与空串。
    // 空串表示用途未知，比编一个更诚实。
    tier: c.tier ?? "execute",
    model: c.model,
    purpose: c.purpose ?? "",
    inputTokens: c.inputTokens,
    outputTokens: c.outputTokens,
    reasoningTokens: c.reasoningTokens,
    cacheHitTokens: c.cacheHitTokens ?? 0,
    cacheMissTokens: c.cacheMissTokens ?? 0,
    costCny: c.costCny,
    priceTier: c.priceTier,
    latencyMs: c.latencyMs,
    createdAt: c.createdAt > 0 ? c.createdAt : created,
  }));

  try {
    const result = await importRun({
      userId: user.id,
      // prompt 原样保留，它是这条运行的起点，不做归一化改写
      prompt: bundle.run.prompt,
      stage: bundle.run.stage,
      status,
      // workflowVersion 不在导出文件里：记录继续处理这条运行的当前工作流版本
      workflowVersion: env.run.workflowVersion,
      createdAt: created,
      updatedAt: bundle.run.updatedAt > 0 ? bundle.run.updatedAt : created,
      events,
      artifacts,
      costs,
    });
    if (!result.ok) return reject(result.reason);

    // 303：POST 后去 GET 画布，用户应看到刚导入的项目。
    // 200 加 JSON 会让用户看到屏幕上一坨花括号。
    return Response.redirect(new URL(`/canvas?run=${result.runId}`, req.url), 303);
  } catch (err) {
    // 真正的 IO 失败；存储层已撤销自己写入的数据
    // 回 500 而不是 400，因为请求本身是合法的
    return reject(
      `导入时写入失败：${err instanceof Error ? err.message : String(err)}`,
      500,
    );
  }
}