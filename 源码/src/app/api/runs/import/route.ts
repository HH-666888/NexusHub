/**
 * 导入接口
 * ============================================================
 * POST /api/runs/import
 *
 * 收一个 `.nexus.json`（multipart 表单的 file 字段），
 * 把里面那条运行**新建**到当前用户名下，然后 303 跳过去看它。
 *
 * ── 为什么是"新建"而不是"覆盖" ──
 *   导出文件里带着原来那条运行的 id，但导入**不认这个 id**：
 *   它属于另一个账号、另一台机器上的一次导入。
 *   照原 id 写回去，轻则撞主键，重则把别人库里的同名运行覆盖掉。
 *   所以每次都新建一条（新 id、属于当前用户），
 *   而原来的那条运行**一动不动** —— 导入的语义是"也留一份"，
 *   不是"搬过来"。这一点必须有测试钉着（e2e 第二十七步验了）。
 *
 * ── 为什么写完之后是 303 而不是 200 ──
 *   这是一个**表单提交**（用户选了文件点导入），浏览器会当导航处理。
 *   返回 200 + JSON 的话，用户看到的是屏幕上一坨花括号 ——
 *   而他刚做完的动作是"把项目导进来"，他期望看到的是那个项目。
 *   303 的语义正是"POST 完了，去 GET 那个地址"，而画布就是那个地址。
 *
 * ── 这一层只做三件事 ──
 *   把请求读成对象、把不合规的东西**说清哪里不合规**、把合规的交给存储层。
 *   真正的写入（含"先验后写"与失败补偿）在 adapters/store/import-repo.ts。
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

/** 落库时 kind 这一列是文本，读回来要靠这里收窄成合法值 */
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

/** 400 + 一句具体原因。形状按约定固定成 { error } */
function reject(reason: string, status = 400): Response {
  return Response.json({ error: reason }, { status });
}

/**
 * 解析失败时给出**具体**原因。
 *
 * ⚠️ 这里不是校验器 —— 校验器只有一个（parseExport）。
 *    本函数只在它已经返回 null 之后被调用，用来把"不行"翻译成人话。
 *    最要紧的两条（format / version）单独说，因为用户最常遇到的就是
 *    「拖错了文件」和「文件来自更新的版本」；其余情况给一句
 *    "一个合法的文件里必须有什么"，而不是重复一遍校验规则 ——
 *    两处各写一遍规则，迟早会分叉，而分叉的那天没人会发现。
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

/** 事件的 kind 从 payload 里读 —— 落库那一列存的就是它 */
function kindOfEvent(payload: unknown): RunEventKind | null {
  if (typeof payload !== "object" || payload === null) return null;
  const kind = (payload as { kind?: unknown }).kind;
  if (typeof kind !== "string" || !RUN_EVENT_KINDS.has(kind)) return null;
  return kind as RunEventKind;
}

export async function POST(req: Request): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return new Response("未登录", { status: 401 });

  /* ---------- ① 读表单 ---------- */
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

  /* ---------- ② 解析 ---------- */
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return reject(`不是合法的 JSON：${err instanceof Error ? err.message : String(err)}`);
  }

  const bundle = parseExport(raw);
  if (!bundle) return reject(describeShapeProblem(raw));

  /* ---------- ③ 语义校验：能补的已经补过，剩下这些补不了 ---------- */
  /*
    为什么 stage / status 要额外复核：
    parseExport 对**缺失**的它们是补默认值（补出来的一定合法），
    但文件里如果写着一个我们不认识的值（比如来自另一个产品线的文件），
    补是不行的 —— 那会把一条运行画到一棵根本不存在的工序树上。
    这种时候明确拒绝，比画出一棵假树强。
  */
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

  /*
    时间基准：老形状的导出文件里没有事件的 at。
    那时候按"运行创建那一刻 + 序号"补 —— 序号是递增的，
    于是时间轴仍然单调，回放拖起来不会来回跳。
    没有可信的创建时间（0）时用导入这一刻，而不是 1970。
  */
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
    /*
      tier / purpose 是 cost_records 上的 NOT NULL 列，而它们在老形状的
      导出文件里没有。默认值取"最不冒充信息"的那两个：
      execute 是绝大多数调用真实所属的档位，空串是一句诚实的"不知道用途"。
    */
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

  /* ---------- ④ 写 ---------- */
  try {
    const result = await importRun({
      userId: user.id,
      // 用户那句话**原样保留** —— 它是这条运行的起点，不许被归一化改写
      prompt: bundle.run.prompt,
      stage: bundle.run.stage,
      status,
      /*
        workflowVersion 不在导出文件里：它不是"这条运行的事实"，
        而是"这份产物是照哪一版工作流做出来的"。导入之后，
        它将要被这一版的工序继续处理，所以写当前版本。
      */
      workflowVersion: env.run.workflowVersion,
      createdAt: created,
      updatedAt: bundle.run.updatedAt > 0 ? bundle.run.updatedAt : created,
      events,
      artifacts,
      costs,
    });
    if (!result.ok) return reject(result.reason);

    // 303：POST 完了，去 GET 画布。用户该看到的是刚导进来的那个项目
    return Response.redirect(new URL(`/canvas?run=${result.runId}`, req.url), 303);
  } catch (err) {
    // 走到这里说明是真正的 IO 失败（存储层已经把自己写的东西撤干净了）
    return reject(
      `导入时写入失败：${err instanceof Error ? err.message : String(err)}`,
      500,
    );
  }
}