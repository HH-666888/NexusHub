/**
 * 导出 / 导入：把一条运行（一句话 + 事件 + 产物 + 账本）压成一个文件。
 * 只规定两件事：什么样的文件才算数（parseExport），压出来的文件长什么样（buildExport）。
 * version 只认 1：静默降级导入一份残缺记录，比直接拒绝坏得多。
 */

export const EXPORT_FORMAT = "nexus-run";
export const EXPORT_VERSION = 1;

export interface NexusExport {
  format: typeof EXPORT_FORMAT;
  version: typeof EXPORT_VERSION;
  /** ISO 字符串，排查问题时先看它 */
  exportedAt: string;

  /**
   * 抬头。只带重建这条运行需要的最小事实，不带 userId：
   * 导入是导进另一个账号的，写进文件只会变成一个必须被忽略的字段。
   */
  run: {
    id: string;
    prompt: string;
    stage: string;
    status: string;
    createdAt: number;
    updatedAt: number;
  };

  /**
   * 全部事件。at 是后加的：回放的 frameAt 算的是 e.at - 首条.at，
   * 丢了它导入条目的时间轴只能是编的。对老形状兼容：缺 at 照样能导，按导入时刻补。
   */
  events: { seq: number; payload: unknown; at?: number }[];

  artifacts: { path: string; kind: string; content: string }[];

  /**
   * 成本流水。比最小形状多 nodeId / tier / purpose / 两个 cache 计数，
   * 都是导入时要原样写回去的东西；全部可选，老形状的文件照样能导。
   */
  costs: {
    stage: string | null;
    model: string;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    costCny: number;
    priceTier: string;
    latencyMs: number;
    createdAt: number;
    nodeId?: string | null;
    tier?: string;
    purpose?: string;
    cacheHitTokens?: number;
    cacheMissTokens?: number;
  }[];

  /**
   * 如实记录被跳过的产物（太大 / 读不到），不悄悄丢：
   * 少一个文件，与少一个没人告诉你的文件，是两回事。
   */
  skipped: { path: string; reason: string }[];
}

/** 数组与 null 都不算 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function nullableStr(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/**
 * 校验并解析一个导出文件。不合规返回 null，不抛：调用方是 HTTP 接口，
 * 它要把为什么不行变成一句人话回给用户，而不是一句栈帧。
 * 形状不对（format/version、run 缺 id/prompt、三个数组不是数组）一律拒绝；
 * 字段缺失补安全默认；条目本身不是对象也拒绝，那不是缺字段，是补不出来。
 */
export function parseExport(raw: unknown): NexusExport | null {
  if (!isPlainObject(raw)) return null;

  if (raw.format !== EXPORT_FORMAT) return null;
  if (raw.version !== EXPORT_VERSION) return null;

  if (!isPlainObject(raw.run)) return null;
  const rawRun = raw.run;
  const runId = rawRun.id;
  const runPrompt = rawRun.prompt;
  if (typeof runId !== "string" || runId.trim() === "") return null;
  if (typeof runPrompt !== "string" || runPrompt.trim() === "") return null;

  if (!Array.isArray(raw.events)) return null;
  if (!Array.isArray(raw.artifacts)) return null;
  if (!Array.isArray(raw.costs)) return null;

  const events: NexusExport["events"] = [];
  for (let i = 0; i < raw.events.length; i++) {
    const e: unknown = raw.events[i];
    if (!isPlainObject(e)) return null;
    const seq = num(e.seq, i);
    /*
      只在真的有 at 时才带这个键：写成 at: undefined 会让往返的 deep equal 变红，
      看起来像事件变了。
    */
    events.push(
      typeof e.at === "number" && Number.isFinite(e.at)
        ? { seq, payload: e.payload, at: e.at }
        : { seq, payload: e.payload },
    );
  }

  const artifacts: NexusExport["artifacts"] = [];
  for (const a of raw.artifacts) {
    if (!isPlainObject(a)) return null;
    const path = a.path;
    if (typeof path !== "string" || path.trim() === "") return null;
    artifacts.push({
      path,
      // kind 缺失给 "text"，最中性（不会被当成可预览的 HTML）
      kind: str(a.kind, "text"),
      // content 缺失给空串：文件在、内容是空的，仍算一次成功的导出
      content: str(a.content, ""),
    });
  }

  const costs: NexusExport["costs"] = [];
  for (const c of raw.costs) {
    if (!isPlainObject(c)) return null;
    costs.push({
      stage: nullableStr(c.stage),
      model: str(c.model, ""),
      inputTokens: num(c.inputTokens, 0),
      outputTokens: num(c.outputTokens, 0),
      reasoningTokens: num(c.reasoningTokens, 0),
      costCny: num(c.costCny, 0),
      priceTier: str(c.priceTier, ""),
      latencyMs: num(c.latencyMs, 0),
      createdAt: num(c.createdAt, 0),
      // 这几个是老形状没有的，缺失时不写而不是写 null：
      // 写 null 会把本来没这项变成这项是空，导入时要走不同分支
      ...(c.nodeId !== undefined ? { nodeId: nullableStr(c.nodeId) } : {}),
      ...(typeof c.tier === "string" ? { tier: c.tier } : {}),
      ...(typeof c.purpose === "string" ? { purpose: c.purpose } : {}),
      ...(typeof c.cacheHitTokens === "number"
        ? { cacheHitTokens: num(c.cacheHitTokens, 0) }
        : {}),
      ...(typeof c.cacheMissTokens === "number"
        ? { cacheMissTokens: num(c.cacheMissTokens, 0) }
        : {}),
    });
  }

  const skipped: NexusExport["skipped"] = [];
  if (Array.isArray(raw.skipped)) {
    for (const s of raw.skipped) {
      if (!isPlainObject(s)) continue;
      const p = s.path;
      if (typeof p !== "string" || p.trim() === "") continue;
      skipped.push({ path: p, reason: str(s.reason, "") });
    }
  }

  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    /*
      exportedAt 缺失时从 run.createdAt 推，而不是写 1970：
      推出来的那个值至少是真的发生过的时间。
    */
    exportedAt: str(
      raw.exportedAt,
      new Date(num(rawRun.createdAt, 0)).toISOString(),
    ),
    run: {
      id: runId,
      prompt: runPrompt,
      // 缺失时给最保守的取值。它们是给导入方校验用的：
      // import 路由会拿 isStageId / RUN_STATUS_LABEL 复核，补出来的值合法所以能过，
      // 而文件里写了个不认识的值会被明确拒绝。
      stage: str(rawRun.stage, "spec"),
      status: str(rawRun.status, "running"),
      createdAt: num(rawRun.createdAt, 0),
      updatedAt: num(rawRun.updatedAt, num(rawRun.createdAt, 0)),
    },
    events,
    artifacts,
    costs,
    skipped,
  };
}

/**
 * 组装导出载荷。纯函数，IO 由调用方做完再喂进来。
 * now 由调用方给：会自己看表的函数测不稳，而 exportedAt 正是要被断言的东西。
 */
export function buildExport(input: {
  run: NexusExport["run"];
  events: NexusExport["events"];
  artifacts: NexusExport["artifacts"];
  costs: NexusExport["costs"];
  skipped: NexusExport["skipped"];
  now: number;
}): NexusExport {
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: new Date(input.now).toISOString(),
    run: { ...input.run },
    /*
      逐条重建而不是直接展开调用方数组：那样会把别的字段一并带出去，
      导出文件的形状必须由这个文件说了算。
    */
    events: input.events.map((e) =>
      e.at === undefined
        ? { seq: e.seq, payload: e.payload }
        : { seq: e.seq, payload: e.payload, at: e.at },
    ),
    artifacts: input.artifacts.map((a) => ({
      path: a.path,
      kind: a.kind,
      content: a.content,
    })),
    costs: input.costs.map((c) => ({ ...c })),
    skipped: input.skipped.map((s) => ({ path: s.path, reason: s.reason })),
  };
}

/** 路径分隔符 + Windows 保留字符 + 控制字符 */
const FORBIDDEN_IN_FILENAME = /[\\/:*?"<>|\u0000-\u001F\u007F]/g;

/** prompt 取前多少字符进文件名 */
const FILENAME_PROMPT_CHARS = 20;

/**
 * 导出文件名不能含路径分隔符与系统保留字符。名字取用户那句话的前 20 个字：
 * 下载目录里躺着五个 nexus-run.nexus.json 的时候，只有它能让用户认出哪个是哪个。
 * 控制字符也要去（Windows 同样不允许 0x00–0x1F），否则用户拿到一个自己系统存不下的名字；
 * 首尾的点也要去，否则系统会悄悄吃掉那个点，.nexus.json 就变成 .json。
 */
export function exportFileName(prompt: string): string {
  const stem = prompt
    // 先截前 20 个字：文件名要短
    .slice(0, FILENAME_PROMPT_CHARS)
    .replace(FORBIDDEN_IN_FILENAME, "")
    // 去掉首尾空白与点，中间的点和空白是正常的
    .replace(/^[\s.]+/, "")
    .replace(/[\s.]+$/, "");

  return `${stem === "" ? "nexus-run" : stem}.nexus.json`;
}

/**
 * 把一条产物路径挂到新的运行目录下。
 * 原样写会覆盖导出那条运行的产物，而用户导入的意图是留一份，不是搬走。
 * 只换最外层那一段（运行 id），里面的文件名与子目录一个字不动；
 * 路径只有一段时也挂到新目录下，否则会落到工作区根上、和别的运行混在一起。
 */
export function rebaseArtifactPath(originalPath: string, newRunId: string): string {
  const segments = originalPath.split("/").filter((s) => s !== "");
  // 最外层那一段属于导出那条运行，无论它看起来像不像运行 id
  const rest = segments.length > 1 ? segments.slice(1) : segments;
  return [newRunId, ...rest].join("/");
}