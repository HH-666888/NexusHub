/**
 * 导出 / 导入的领域模型
 * ============================================================
 * 一条运行 = 一句话 + 一串事件 + 一批产物 + 一本账。
 * 它们在库里分散在三张表、在磁盘上散在一个目录里，
 * 换一台电脑打开就是空的 —— 这正是用户提过的那个担心：
 * 「换一个地方旧项目就没有了，或者打开是空的」。
 *
 * 这个文件把「一条运行」压成**一个文件**的形状，并且只规定两件事：
 *   · 什么样的文件才算数（parseExport）；
 *   · 压出来的文件长什么样（buildExport）。
 *
 * 两者都是纯函数：不认识磁盘、不认识数据库、不认识 HTTP。
 * 读写由调用方做完再喂进来 —— 于是「导出再导入，两边一模一样」
 * 这件事可以在单测里被钉死，不必起服务器、不必碰真库。
 *
 * ── 为什么格式里带 format 与 version ──
 *   用户会把这个文件存很久、在几个地方之间搬。
 *   没有版本号的话，将来改了形状，旧文件会被**当成新的**解析 ——
 *   缺的字段补个默认值，看起来一切正常，实则把一份残缺的记录
 *   当成完整的导入进来。那比直接拒绝坏得多：拒绝了用户知道要重导，
 *   静默降级用户永远不知道。所以 version 只认 1，其余一律拒绝。
 */

export const EXPORT_FORMAT = "nexus-run";
export const EXPORT_VERSION = 1;

export interface NexusExport {
  format: typeof EXPORT_FORMAT;
  version: typeof EXPORT_VERSION;
  /** ISO 字符串。导出发生在哪一刻 —— 排查问题时先看它 */
  exportedAt: string;

  /**
   * 这次运行的抬头。
   *
   * ⚠️ 只带「重建这条运行需要的最小事实」，不带 userId：
   *    导入是**导进另一个账号**的（那正是它的用途），
   *    把原主人写进文件里，只会在导入时变成一个必须被忽略的字段 ——
   *    而一个"存在但永远不用"的字段，迟早有人会去用它。
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
   * 全部事件。
   *
   * ⚠️ `at` 不在最初的形状里，是我**加上去的**，理由必须说清楚：
   *    回放的时间轴（run-event.ts 的 frameAt）算的是 `e.at - 首条.at`。
   *    导出时把 at 丢掉，导入回来的那条运行时间轴就只能是编的 ——
   *    而"编一个时间戳"正是这个项目最不能接受的那种事。
   *    它对老形状是**兼容的**：只写 {seq, payload} 的文件照样能导进来
   *    （缺 at 时按导入时刻补，见 importRun）。
   */
  events: { seq: number; payload: unknown; at?: number }[];

  artifacts: { path: string; kind: string; content: string }[];

  /**
   * 成本流水。
   *
   * ⚠️ 同样比最小形状多几个字段（nodeId / tier / purpose / 两个 cache 计数），
   *    理由同上：它们都是导入时必须能原样写回去的东西，
   *    丢掉的话"钱花在哪个模块上"这类问题在导入之后就再也答不上来了。
   *    都是可选的 —— 老形状的文件照样能导。
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
   * ⚠️ 如实记录被跳过的产物（太大 / 读不到）—— 不许悄悄丢。
   *
   * 导出有体积上限（见 export/route.ts），必然会遇到"这个产物带不走"。
   * 那时候只有两条路：如实写下来，或者假装它不存在。
   * 后者会让用户在另一台电脑上打开时发现少了东西，却不知道为什么 ——
   * 而"少了一个文件"和"少了一个没人告诉你的文件"是两回事。
   */
  skipped: { path: string; reason: string }[];
}

/* ============================================================
   解析（校验并补齐）
   ============================================================ */

/** 是不是一个"普通的对象"（数组、null 都不算） */
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
 * 校验并解析一个导出文件。**不合规返回 null，不许抛**。
 *
 * 为什么不抛：调用方是 HTTP 接口，它要把"为什么不行"变成一句人话
 * 回给用户。抛异常的话，那句话说起来就变成"在某个栈帧上炸了"，
 * 而用户想知道的是"这个文件哪里不对"。
 *
 * ── 校验的分寸 ──
 *   形状不对（不是对象、format/version 不对、run 缺 id/prompt、
 *   events/artifacts/costs 不是数组）→ **拒绝**。这些错了就没有解析的余地。
 *   字段缺失（skipped 没有、at 没有、tier 没有）→ **补安全默认**。
 *   条目本身不是对象（events 里塞了个字符串）→ **拒绝**：
 *   它不是"缺一个字段"，是"这里根本不是一条事件"，补不出东西来。
 *
 * ⚠️ version 只认 1：未来的版本**显式拒绝**，不许当 1 处理。
 *    理由见文件头 —— 静默降级导入一份残缺的记录，比拒绝坏得多。
 */
export function parseExport(raw: unknown): NexusExport | null {
  if (!isPlainObject(raw)) return null;

  if (raw.format !== EXPORT_FORMAT) return null;
  if (raw.version !== EXPORT_VERSION) return null;

  /* ---------- run：抬头，两个字段错了就没什么可导的 ---------- */
  if (!isPlainObject(raw.run)) return null;
  const rawRun = raw.run;
  const runId = rawRun.id;
  const runPrompt = rawRun.prompt;
  if (typeof runId !== "string" || runId.trim() === "") return null;
  if (typeof runPrompt !== "string" || runPrompt.trim() === "") return null;

  /* ---------- 三个数组：不是数组就直接拒绝 ---------- */
  if (!Array.isArray(raw.events)) return null;
  if (!Array.isArray(raw.artifacts)) return null;
  if (!Array.isArray(raw.costs)) return null;

  /* ---------- 事件：seq 缺失用下标补，条目不是对象则拒绝 ---------- */
  const events: NexusExport["events"] = [];
  for (let i = 0; i < raw.events.length; i++) {
    const e: unknown = raw.events[i];
    if (!isPlainObject(e)) return null;
    const seq = num(e.seq, i);
    /*
      只在这一条**真的有** at 时才带上这个字段（条件展开）。
      写成 `at: undefined` 的话，往返比对（deep equal）会因为
      "多了个值为 undefined 的键"而红 —— 而它看起来像"事件变了"。
    */
    events.push(
      typeof e.at === "number" && Number.isFinite(e.at)
        ? { seq, payload: e.payload, at: e.at }
        : { seq, payload: e.payload },
    );
  }

  /* ---------- 产物：path 是它的身份，缺了就没法写 ---------- */
  const artifacts: NexusExport["artifacts"] = [];
  for (const a of raw.artifacts) {
    if (!isPlainObject(a)) return null;
    const path = a.path;
    if (typeof path !== "string" || path.trim() === "") return null;
    artifacts.push({
      path,
      // kind 缺失给 "text"：它是最中性的那个（不会被当成可预览的 HTML）
      kind: str(a.kind, "text"),
      // content 缺失给空串：文件在、内容是空的 —— 这仍然是一次成功的导出
      content: str(a.content, ""),
    });
  }

  /* ---------- 成本：整行都是可选字段，缺什么补什么 ---------- */
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
      // 这几个是老形状里没有的，缺失时**不写**（而不是写 null）：
      // 写进去会让"这个文件本来就没有这项"变成"这项的值是空"，
      // 而这两件事在导入时要走不同的分支
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

  /* ---------- skipped：非数组当空数组（它是"附注"，不是主数据） ---------- */
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
      exportedAt 缺失时**从 run.createdAt 推**，而不是写 1970。
      它要回答的是"这份文件是什么时候压出来的"，
      推出来的那个值至少是真的发生过的时间，1970 则是一个一眼假的占位。
    */
    exportedAt: str(
      raw.exportedAt,
      new Date(num(rawRun.createdAt, 0)).toISOString(),
    ),
    run: {
      id: runId,
      prompt: runPrompt,
      // stage/status 缺失时给最保守的取值（还没开始跑）。
      // ⚠️ 它们是给导入方**校验**用的，不是一个可以随便补的默认：
      //    import 那条路由会拿 isStageId / RUN_STATUS_LABEL 复核，
      //    补出来的值合法所以能过，而文件里写了个不认识的值会被明确拒绝。
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

/* ============================================================
   组装
   ============================================================ */

/**
 * 组装导出载荷。**纯函数** —— IO 由调用方做完再喂进来。
 *
 * now 由调用方给，不在这里调 Date.now()：
 * 一个会自己看表的函数是测不稳的（同一份输入两次调用结果不同），
 * 而 exportedAt 恰恰是要被断言的东西之一。
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
      逐条重建，而不是 `events: input.events` ——
      那样会把调用方数组里的**别的字段**一并带出去。
      导出文件的形状必须是这个文件说了算，不能由调用方顺手决定。
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

/* ============================================================
   文件名
   ============================================================ */

/** 文件名里不许出现的字符：路径分隔符 + Windows 保留字符 + 控制字符 */
const FORBIDDEN_IN_FILENAME = /[\\/:*?"<>|\u0000-\u001F\u007F]/g;

/** 取 prompt 前多少个字符进文件名 */
const FILENAME_PROMPT_CHARS = 20;

/**
 * 导出文件名。**不能含路径分隔符与操作系统保留字符**。
 *
 * 名字取用户那句话的前 20 个字 —— 下载目录里躺着五个
 * `nexus-run.nexus.json` 的时候，只有这个名字能让他认出哪个是哪个。
 *
 * ── 为什么连控制字符也要去掉 ──
 *   要求里只列了 `\ / : * ? " < > |`，但 Windows 的文件名
 *   **同样不允许 0x00–0x1F**。而 prompt 是从网页输入框来的，
 *   粘贴时夹带换行或零宽字符是常事（core/domain/run.ts 的
 *   checkPrompt 就专门清过一遍）。少清一次，用户会拿到一个
 *   在自己系统上存不下的文件名，而报错来自浏览器、莫名其妙。
 *
 * ── 为什么首尾的点也要去掉 ──
 *   Windows 上以点结尾的文件名会被系统悄悄吃掉那个点，
 *   `.nexus.json` 就变成了 `nexus.json`。用户看到的名字
 *   和实际存下来的名字对不上，而这个后缀正是"这个文件能重新导入"
 *   的唯一标记。
 */
export function exportFileName(prompt: string): string {
  const stem = prompt
    // 先截前 20 个字：文件名要短，而不是"把一整句话洗干净"
    .slice(0, FILENAME_PROMPT_CHARS)
    .replace(FORBIDDEN_IN_FILENAME, "")
    // 去掉首尾空白与点（中间的点和空白是正常的，"番茄钟 v1.2" 不该被改）
    .replace(/^[\s.]+/, "")
    .replace(/[\s.]+$/, "");

  return `${stem === "" ? "nexus-run" : stem}.nexus.json`;
}

/* ============================================================
   产物路径的"换根"
   ============================================================ */

/**
 * 把一条产物的路径挂到**新的运行目录**下。
 *
 * ── 为什么必须换，不能"按原 path 写" ──
 *   产物路径的约定是 `<运行id>/<文件名>`（见 core/domain/artifact.ts）。
 *   导入时如果原样写 `<旧运行id>/index.html`，就会**覆盖导出那条运行的产物** ——
 *   而用户导入的意图恰恰是"把这条运行也留一份"，不是"把它搬走"。
 *   覆盖之后，原运行会指向新导入的内容（甚至在新运行被删掉时整个消失），
 *   这是一种最难排查的坏：两边看起来都在，内容却串了。
 *
 *   所以换掉的只有最外层那一段（运行 id），**运行目录里的相对布局
 *   一个字不动** —— 文件名、子目录、扩展名全部照旧。
 *   界面和产物检查读的都是文件名（spec.json / index.html / answers.json 那套约定），
 *   换根不会动到它们。
 *
 * ⚠️ 只换"看起来像运行目录"的第一段：
 *    如果路径只有一个片段（`index.html`），说明它本来就没有运行目录，
 *    那就挂到新运行目录下 —— 否则它会落到工作区根上，和别的运行混在一起。
 */
export function rebaseArtifactPath(originalPath: string, newRunId: string): string {
  const segments = originalPath.split("/").filter((s) => s !== "");
  // 去掉最外层那一段（无论它看起来像不像运行 id，它都属于**导出那条运行**）
  const rest = segments.length > 1 ? segments.slice(1) : segments;
  return [newRunId, ...rest].join("/");
}