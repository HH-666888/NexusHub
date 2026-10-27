/**
 * 模块构建产物（module-build）：并行构建那一道的产物模型。
 * 这一道的产物是每个模块各一份实现，不是一整页 HTML；解析、特征提取与装配提示词都在这里。
 * 部分失败是常态，所以 failed 是必填字段而不是可选备注。
 */

import { extractJsonText, type AppSpec } from "./spec";
import type { ArchModule, ArchSpec } from "./arch";
import type { TokenUsage } from "../ports/model";

/** concurrency 未给或 <=0 时用它 */
export const DEFAULT_BUILD_CONCURRENCY = 3;

/**
 * 单个模块每次调用的输出预算。预算里不只有代码，还有思考，而思考 token 计入 max_tokens
 * （见适配器文件头），这一道的思考长度极不稳定。
 * 实测两次被顶满：预算 6000 时两个模块的思考占满、正文一个字没吐；16384 时 storage-sync
 * 思考 13997 又顶满。所以按最坏观测值定：13997 + 片段 2k~6k + 余量 = 32768。
 * 只有真用掉的 token 才计费，截断才是真的贵（那次白花 ¥0.066 还少装一个模块）。
 * 改这个数之前先去 cost_records 看 reasoning_tokens 的实际分布。
 */
export const MODULE_MAX_OUTPUT_TOKENS = 32768;

/** 一个模块的产出 */
export interface ModuleBuild {
  /** 对应 ArchModule.id，装配与任务点都靠它认领 */
  moduleId: string;
  /** 一句话说明做了什么 */
  summary: string;
  /** 不含 <html>/<head>/<body> */
  html: string;
  /** CSS 片段 */
  css: string;
  /** JS 片段 */
  js: string;
  /** 折算人民币 */
  costCny: number;
  /** 记进成本流水 */
  usage: TokenUsage;
  /** 实际使用的模型名 */
  model: string;
  /** 计价档位 */
  priceTier: "peak" | "offPeak";
  /** 耗时 */
  latencyMs: number;
  /** 被长度上限截断，片段可能不完整 */
  truncated: boolean;
  /**
   * 这一次调用模型想的东西。必须跟着结果走出来：它原先进了 ModelResult 没人取，
   * 界面上并行构建那一步的思考页签永远写着没有返回，而单个模块实测想过 12706 tokens。
   * 并行调用没有先后时序，编排层按 arch 顺序逐条发出，那是归属不是时序。
   */
  reasoning: string;
  /**
   * 这一份是上次的产出沿用来的，本次没有任何调用。
   * 用 0 元 0 token 表示会和花了但便宜或失败的那种混起来，账单上说不清；
   * 所以 route.ts 对 reused 的模块不写新的流水行，那笔钱上次已记过。
   */
  reused?: boolean;
}

/**
 * 一个失败的模块。字段比 ModuleBuild 少但必须有：
 * 少了它，部分失败只能靠模块数去猜。
 */
export interface ModuleBuildFailure {
  moduleId: string;
  /** 人可读，直接显示 */
  message: string;
  /**
   * 这次失败调用的花费。调用抛错时是 0；
   * 而调用成功、解析失败那一类是真的花了钱，不记就是糊涂账。
   */
  costCny: number;
  usage: TokenUsage;
  /** 没拿到模型名就失败时为 null */
  model: string | null;
  /** 调用没成功时为 null，不随手写一个档位糊弄账本 */
  priceTier: "peak" | "offPeak" | null;
  latencyMs: number;
  /**
   * 失败那次调用的思考。解析失败的那类照样要带：截断的往往正是想得最多的那些，
   * 藏起来用户只看到失败，看不到它其实认真想过。调用直接抛错时给空串。
   */
  reasoning: string;
}

/** 一次并行构建的全貌 */
export interface BuildBatch {
  /** 顺序与 arch.modules 一致，便于对账 */
  modules: ModuleBuild[];
  /** 部分失败允许，必须如实记录 */
  failed: ModuleBuildFailure[];
  /** 实际使用的并发上限（>=1） */
  concurrency: number;
  /** 含失败的那几次 */
  totalCostCny: number;
  /** token 合计 */
  totalUsage: TokenUsage;
  /**
   * 墙钟耗时。不是各次调用耗时之和：并发跑的时候相加没有意义
   * （3 个各 10 秒的调用并行跑完只过了 10 秒），记墙钟才是用户真实的等待。
   */
  wallClockMs: number;
  /**
   * 同时在飞的最大调用数，由工作池自己数出来，恒定 <= concurrency；
   * 串行实现恒为 1。界面与测试都以它作为真并行的证据。
   */
  peakInFlight: number;
  /**
   * 因输出被截断而加倍预算重试过的模块 id（按 arch 顺序）。
   * 空数组表示这一批没有任何模块重试过，是绝大多数情况。
   */
  retriedModules: string[];
}

/**
 * 持久化 / 投影用的摘要，kind:"modules" 事件装的就是它。
 * 事件里不带代码片段：事件要逐条落库、要回放，而回放没有一处读片段，
 * 代码有没有真的进产物由产物检查那条探针回答。
 */
export interface ModuleBuildSummary {
  moduleId: string;
  /** 从 arch 查（见 summarizeBatch） */
  name: string;
  summary: string;
  costCny: number;
}

export interface ModuleBuildFailureSummary {
  moduleId: string;
  name: string;
  message: string;
  costCny: number;
}

export interface BuildBatchSummary {
  modules: ModuleBuildSummary[];
  failed: ModuleBuildFailureSummary[];
  concurrency: number;
  totalCostCny: number;
  /** 界面上用它说明这次真的是并行的 */
  peakInFlight: number;
}

/**
 * 空的 token 用量，给拿不到用量的那几笔填空。
 * 冻结起来：它是共享对象，谁顺手改一下，所有没花钱的记录都会跟着变。
 */
export const ZERO_USAGE: TokenUsage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cacheHitTokens: 0,
  cacheMissTokens: 0,
});

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    cacheHitTokens: a.cacheHitTokens + b.cacheHitTokens,
    cacheMissTokens: a.cacheMissTokens + b.cacheMissTokens,
  };
}

/**
 * 单模块构建的系统提示词。三条硬性要求是判据，不是格式洁癖：
 * data-module 标记让装配与产物检查认领这段代码；具名函数是代码真的在跑的证据
 * （标记可能被装配当成注释留下）；只写自己这块，否则几个模块的产出会互相覆盖。
 */
export const MODULE_SYSTEM_PROMPT = `你是一条并行构建流水线上的执行工程师。你只负责**一个**模块，
其它模块由别人同时在做，你们互不可见。

只输出一个 JSON 对象，不要有任何解释文字、不要包代码块围栏。

字段要求：
{
  "summary": "一句话说明你这个模块做了什么",
  "html": "这个模块的 HTML 片段。最外层必须是 <section data-module=\\"模块id\\">…</section>",
  "css": "这个模块的 CSS 片段，所有类选择器都以模块 id 当前缀",
  "js": "这个模块的 JS 片段，至少有一个具名函数，函数名里必须含模块 id 的驼峰形式"
}

硬性要求：
1. 只写你这一个模块。**不要**写整页，不要出现 <html> / <head> / <body> / <!DOCTYPE>
2. html 最外层的 \`data-module="模块id"\` **一字不改**：装配时要靠它认领，
   产物检查也要靠它确认你的代码真的进了最终产物
3. js 里的具名函数名必须含模块 id 的驼峰形式（例如模块 id 是 task-store，
   就写 function taskStoreInit(...)），并且它要真的被调用
4. css 里的类选择器一律以模块 id 打头（例如 .task-store-card）
5. 界面文字用简体中文；数据用 localStorage 持久化
6. 不要引用任何外部资源（CDN、外链字体或图片）`;

/** 一个模块在提示词里要交代的全部信息 */
export interface ModuleBrief {
  module: ArchModule;
  /** 覆盖的功能条目，从 spec 查 */
  features: { id: string; statement: string; level: "must" | "should" }[];
  /** 依赖的模块 */
  dependencies: { id: string; name: string; responsibility: string }[];
}

/**
 * 把架构里的一条模块记录配上规格与依赖，变成一份派工单。
 * 职责必须写清楚：派工单上没写只管这一块，N 个模块就会各自写一个完整应用。
 */
export function moduleBrief(arch: ArchSpec, spec: AppSpec, target: ArchModule): ModuleBrief {
  const features = spec.acceptance
    .filter((a) => target.coversFeatures.includes(a.id))
    .map((a) => ({ id: a.id, statement: a.statement, level: a.level }));

  const dependencies = arch.modules
    .filter((m) => target.dependsOn.includes(m.id))
    .map((m) => ({ id: m.id, name: m.name, responsibility: m.responsibility }));

  return { module: target, features, dependencies };
}

/**
 * 一个模块的用户消息：原话 + 职责 + 功能条目 + 依赖。
 * total 是整个应用的模块数，不是这一批要建几个：断点续跑时可能只补 1 个模块，
 * 说成本批第 1 个，它就不知道自己在多模块应用里排第几、还要留什么接口。
 */
export function buildModulePrompt(
  brief: ModuleBrief,
  userInput: string,
  total: number,
  index: number,
): string {
  const { module: m, features, dependencies } = brief;

  const featureLines =
    features.length > 0
      ? features.map(
          (f) => `  · ${f.id}｜${f.statement}（${f.level === "must" ? "必需" : "期望"}）`,
        )
      : ["  （这个模块在架构里没有挂到具体条目上 —— 按职责写，不要越界）"];

  const depLines =
    dependencies.length > 0
      ? dependencies.map((d) => `  · ${d.id}（${d.name}）：${d.responsibility || "（未填写）"}`)
      : ["  （它不依赖别的模块）"];

  return [
    "用户的一句话需求：",
    "",
    userInput.trim(),
    "",
    `整个应用一共 ${total} 个模块，你负责第 ${index} 个：`,
    `  · 模块 id：${m.id}`,
    `  · 模块名：${m.name}`,
    `  · 它负责什么：${m.responsibility || "（架构里没写职责 —— 按模块名理解，只做这一块）"}`,
    "  · 它要覆盖的功能条目：",
    ...featureLines,
    "  · 它依赖的模块（别人在做，你只按它们的边界用，不要重造）：",
    ...depLines,
    "",
    "请只产出这一个模块的 JSON。",
  ].join("\n");
}

// 只做结构校验，不做质量判断；这个模块写得好不好是另一件事

export type ModuleParseResult =
  | {
      ok: true;
      /*
        parseModuleBuild 只解析正文，所以拿不到这一次调用的账与思考：costCny / usage /
        model / priceTier / latencyMs / truncated / reasoning 都由调用方补（见 build-modules.ts）。
      */
      build: Omit<
        ModuleBuild,
        | "costCny"
        | "usage"
        | "model"
        | "priceTier"
        | "latencyMs"
        | "truncated"
        | "reasoning"
      >;
    }
  | { ok: false; reason: string };

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * 三块片段一块都没有才算失败：只要有一段可用就该进装配。
 * 多收一段无用代码的代价只是提示词长一点，少收一个模块的代价是产物少一整块功能。
 */
export function parseModuleBuild(moduleId: string, raw: string): ModuleParseResult {
  const jsonText = extractJsonText(raw);
  if (!jsonText) return { ok: false, reason: "模型输出里找不到 JSON 对象" };

  let obj: unknown;
  try {
    obj = JSON.parse(jsonText);
  } catch (e) {
    return {
      ok: false,
      reason: `JSON 解析失败：${e instanceof Error ? e.message : String(e)}`,
    };
  }

  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    return { ok: false, reason: "JSON 顶层不是对象" };
  }

  const o = obj as Record<string, unknown>;
  const html = asString(o.html);
  const css = asString(o.css);
  const js = asString(o.js);
  if (!html && !css && !js) {
    return { ok: false, reason: "html / css / js 三段都是空的" };
  }

  return {
    ok: true,
    build: {
      moduleId,
      // summary 缺了给一句实话，不编一句已完成
      summary: asString(o.summary) || "（模块没有给出摘要）",
      html,
      css,
      js,
    },
  };
}

// 特征片段：产物检查那条探针的全部依据，回答这个模块的代码有没有真的进入产物。
// 判据不能恒真（恒真等于没检查），也不能太软（表演式并行照样会绿）。

/**
 * 一个模块的特征片段候选，按可信度从高到低。
 * 用一组而不是一个：装配是模型在写，可能把双引号改单引号、把类名归一化，
 * 只认一个会让检查因为无害改写变红，那是另一种谎。命中任意一条就算过。
 */
export function moduleSignatureCandidates(m: {
  moduleId: string;
  html: string;
  css: string;
  js: string;
}): string[] {
  const out: string[] = [];
  const push = (s: string | null | undefined) => {
    const v = (s ?? "").trim();
    if (v && !out.includes(v)) out.push(v);
  };

  /*
    认领标记：模块构建提示词强制要求、装配提示词要求原样保留的那一个。
    两种引号都收，模型换引号不该让检查变红。
  */
  push(m.html.includes(`data-module="${m.moduleId}"`) ? `data-module="${m.moduleId}"` : null);
  push(m.html.includes(`data-module='${m.moduleId}'`) ? `data-module='${m.moduleId}'` : null);

  // js 里的具名函数：标记可能被装配时当成注释留下，函数名是代码真的在跑的证据
  push(firstIdentifier(m.js));
  // css 里的类选择器 / id 选择器
  push(firstSelector(m.css));
  // html 里的 id：最后的兜底，至少证明这一块进过产物
  push(/id="([A-Za-z][\w-]{3,})"/.exec(m.html)?.[1] ?? null);

  return out.slice(0, 4);
}

/** js 里第一个具名函数 / 类 / 常量名 */
function firstIdentifier(js: string): string | null {
  const patterns = [
    /\bfunction\s+([A-Za-z_$][\w$]{2,})\s*\(/,
    /\bclass\s+([A-Za-z_$][\w$]{2,})\b/,
    /\bconst\s+([A-Za-z_$][\w$]{3,})\s*=/,
    /\b(?:let|var)\s+([A-Za-z_$][\w$]{3,})\s*=/,
  ];
  for (const re of patterns) {
    const hit = re.exec(js)?.[1];
    if (hit) return hit;
  }
  return null;
}

/** css 里第一个类或 id 选择器，取整个选择器 */
function firstSelector(css: string): string | null {
  const hit = /(^|[\s,{}])([.#][A-Za-z][\w-]{2,})/.exec(css)?.[2];
  return hit ?? null;
}

/**
 * 首选特征片段，界面与报错用它指认是哪个模块。提不出候选时返回 null：
 * 无法判断不能算通过（见 prompt.ts 里那条检查）。
 */
export function moduleSignature(m: {
  moduleId: string;
  html: string;
  css: string;
  js: string;
}): string | null {
  return moduleSignatureCandidates(m)[0] ?? null;
}

// 装配提示词：模块产出真的喂给最终产物的那一处。
// 前面几步只是准备，片段真的进了装配那一次调用的提示词，并行构建才不是表演。

/**
 * 每个模块的片段最多带多少字符：6 个模块各上万字符会让 token 成本盖过并行省下的时间。
 * 掐尾而不是掐头：特征片段都在开头，掐头会让探针因为提示词里没给而变红，那是自造假故障。
 */
const MODULE_FRAGMENT_MAX_CHARS = 4000;

/** 所有片段合起来的上限，防止模块多的时候提示词失控 */
const ASSEMBLE_TOTAL_MAX_CHARS = 24000;

/** 掐尾并留痕：静默丢内容是最难查的一类问题 */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n/* …（片段过长，已截断 ${text.length - max} 字符）*/`;
}

/**
 * 装配那一次调用的用户消息。顺序是有意的：先用户原话（一字不改），
 * 再逐块给模块片段，然后是失败清单，最后是装配要求。
 */
export function buildAssemblePrompt(input: {
  prompt: string;
  batch: BuildBatch;
  arch?: ArchSpec;
}): string {
  const { batch } = input;
  const nameOf = (id: string): string =>
    input.arch?.modules.find((m) => m.id === id)?.name ?? id;
  const responsibilityOf = (id: string): string =>
    input.arch?.modules.find((m) => m.id === id)?.responsibility ?? "";

  const parts: string[] = [
    "用户的一句话需求：",
    "",
    input.prompt.trim(),
    "",
    `下面是并行构建阶段各模块**真的写出来的代码片段**（共 ${batch.modules.length} 个模块，` +
      `并发上限 ${batch.concurrency}）。请把它们装配成一个成品。`,
    "",
  ];

  let used = 0;
  batch.modules.forEach((m, i) => {
    // 单模块能带的额度：既不超过单模块上限，也不超过全局剩余额度
    const room = Math.max(0, Math.min(MODULE_FRAGMENT_MAX_CHARS, ASSEMBLE_TOTAL_MAX_CHARS - used));
    const chunk = [
      `===== 模块 ${i + 1}/${batch.modules.length}：${m.moduleId}（${nameOf(m.moduleId)}）=====`,
      responsibilityOf(m.moduleId) ? `职责：${responsibilityOf(m.moduleId)}` : "",
      `摘要：${m.summary}`,
      "```html",
      m.html || "（这个模块没有 HTML 片段）",
      "```",
      "```css",
      m.css || "（这个模块没有 CSS 片段）",
      "```",
      "```js",
      m.js || "（这个模块没有 JS 片段）",
      "```",
      "",
    ]
      .filter((line) => line !== "")
      .join("\n");

    const clipped = clip(chunk, room);
    used += clipped.length;
    parts.push(clipped);
  });

  /*
    失败的模块也要说出来：模型看不见失败清单，会照着完整功能把缺的那块编出来，
    于是产物看起来完整、其中一整块是无中生有，这比明确少一块糟得多。
  */
  if (batch.failed.length > 0) {
    parts.push(
      "⚠️ 下面这几个模块**构建失败**了，产物里不会有它们的代码：",
      ...batch.failed.map((f) => `  · ${f.moduleId}（${nameOf(f.moduleId)}）：${f.message}`),
      "请不要替它们编造实现 —— 缺的功能宁可在界面上如实少一块，也不要假装做完了。",
      "",
    );
  }

  parts.push(
    "装配要求：",
    "1. 产出一个**完整、可直接运行**的自包含单文件 HTML（CSS 与 JS 全部内联，不引用任何外部资源）",
    "2. 每个模块的那段 `data-module=\"模块id\"` 标记**原样保留**：它是「这段代码真的进了产物」的唯一凭据",
    "3. 各模块的 CSS 汇总进同一个 <style>，JS 汇总进同一个 <script>；同名函数/变量要重新命名，不要互相覆盖",
    "4. 骨架（<html>/<head>/<body>、公共布局、页面标题）由你补，模块片段里没有的那部分才算你的活儿",
    "5. 界面文字用简体中文，数据用 localStorage 持久化",
    "6. 不要写任何解释文字，只输出 HTML 代码（用 ```html 代码块包住）",
  );

  return parts.join("\n");
}

/**
 * 把 BuildBatch 压成可持久化的摘要，kind:"modules" 事件的载荷。
 * 模块名从 arch 查而不是自己编：这里只是把它带进事件，好让投影层显示人话标题，
 * 而 from-run.ts 仍然以 arch 事件为准。
 */
export function summarizeBatch(batch: BuildBatch, arch: ArchSpec): BuildBatchSummary {
  const nameOf = (id: string): string => arch.modules.find((m) => m.id === id)?.name ?? id;

  return {
    modules: batch.modules.map((m) => ({
      moduleId: m.moduleId,
      name: nameOf(m.moduleId),
      summary: m.summary,
      costCny: m.costCny,
    })),
    failed: batch.failed.map((f) => ({
      moduleId: f.moduleId,
      name: nameOf(f.moduleId),
      message: f.message,
      costCny: f.costCny,
    })),
    concurrency: batch.concurrency,
    totalCostCny: batch.totalCostCny,
    peakInFlight: batch.peakInFlight,
  };
}

/** 界面与日志用的一句话 */
export function summarizeBuildBatch(batch: BuildBatch): string {
  const total = batch.modules.length + batch.failed.length;
  const base =
    `${total} 个模块 · 并发 ${batch.concurrency}` +
    `（实际同时在飞 ${batch.peakInFlight}）· 成功 ${batch.modules.length}`;
  if (batch.failed.length === 0) return base;
  return `${base} · 失败 ${batch.failed.length}（${batch.failed.map((f) => f.moduleId).join("、")}）`;
}