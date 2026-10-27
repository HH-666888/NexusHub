/**
 * 模块构建产物（module-build）
 * ============================================================
 * 六道工序的第四道「并行构建」的产物模型。
 *
 * ── 为什么这一层必须存在，而不是"跑完就扔" ──
 *   `stages.ts` 给第四道写的理由是「并行的粒度是**模块**而不是文件」，
 *   它的 artifact 声明是 `modules/*.json`、验收标准是
 *   「每个模块的模块级自测通过 / 编译通过 / 导出的接口与架构契约一致」。
 *   也就是说：**这一道的产物是"每个模块各一份实现"，不是"一整页 HTML"**。
 *
 *   在这个文件之前，那个产物没有任何类型能表示 —— 于是"并行构建"
 *   只能是"一次调用写一整页"。有了 ModuleBuild + BuildBatch 之后，
 *   「N 个模块各写各的」这件事才有了形状，也才谈得上把它**喂给**装配。
 *
 *   ★ 本文件里最要紧的一条不是类型，而是最后那句：
 *     每个模块的产出会被真的拼进装配提示词，并且真的出现在最终 HTML 里。★
 *
 * ── 为什么解析与特征提取都放在 domain 层（纯函数） ──
 *   和 spec.ts / arch.ts / ui-spec.ts 同一条理由：
 *   「模型返回了一坨不是 JSON 的东西」「这段代码的特征片段是什么」
 *   这类判断不该依赖网络，抽出来就能在毫秒级的单测里钉死。
 *
 * ── 为什么"失败"是一等公民 ──
 *   并行的代价就是**部分失败会变成常态**：3 个模块里 1 个超时，
 *   是很正常的一次运行。把它抹掉（丢掉那个模块、假装只有 2 个）
 *   会造成两种谎：
 *     · 用户以为 3 个模块都做完了 —— 而产物里少了一整块功能；
 *     · 账上少了那次失败调用的钱 —— 失败的那次调用**也是花了钱的**。
 *   所以 BuildBatch 里"失败的模块"是一栏必填的字段，而不是可选备注。
 */

import { extractJsonText, type AppSpec } from "./spec";
import type { ArchModule, ArchSpec } from "./arch";
import type { TokenUsage } from "../ports/model";

/* ============================================================
   类型
   ============================================================ */

/** 并行构建的默认并发上限（`concurrency` 未给或 <=0 时用它） */
export const DEFAULT_BUILD_CONCURRENCY = 3;

/**
 * 单个模块每次调用的输出预算。
 *
 * 一个模块产出的只是**一块**片段（一段 HTML + 一段 CSS + 一段 JS），
 * 不是整页。但这个预算里不只装那块片段 —— 它还装着**思考**，
 * 所以它比"一块片段值多少 token"大得多，最终和整页那一道取齐了（32768）。
 *
 * ── 这个数被真实运行推翻过两次，两次都记在这里 ──
 *   前提：并行构建开着思考（GENERATE_DEFAULT_EFFORT = "high"），
 *   而**思考 token 计入 max_tokens**（适配器文件头第 ① 条）。
 *   于是预算里留给代码的只有「预算 减去 这一次思考了多少」，
 *   而这一道的思考长度**极不稳定** —— 同一条提示词跑出来的实测：
 *
 *     运行 bf665a20（预算 6000）
 *       timer-core        2659 /     0  ✅
 *       app-bootstrap     5796 /  3205  ✅
 *       state-store       6000 /  6000  ❌ 思考占满，正文一个字没吐出来
 *       timer-ui          6000 /  6000  ❌ 同上
 *
 *     运行 6c0f8312（预算 16384）
 *       timer-core        3178 /     0  ✅
 *       timer-persistence 2166 /     0  ✅
 *       timer-ui          1911 /     0  ✅
 *       static-shell      5640 /  3792  ✅
 *
 *     运行 4f7ffbf2（预算 16384）
 *       timer-core        2675 /     0  ✅
 *       clock-ui         10355 /  7260  ✅
 *       storage-sync     16384 / 13997  ❌ 又顶满了，正文被挤没
 *
 *   三次的教训是同一个：**"留一点余量"这个思路本身就是错的**。
 *   storage-sync 那次证明了这一道的思考能到 14k —— 和装配那一道一样。
 *   所以两次抬预算都不是"再加一点"，而是改成按最坏观测值定：
 *   4000 → 6000（估的，被证伪）→ 16384（还是被证伪）→ 32768。
 *
 *   32768 的依据：最坏观测思考 13997 + 一块模块片段（实测 2k~6k）+ 余量。
 *   上限不用担心：实测这个接入点接受 max_tokens 到 131072。
 *
 * ── 预算给大不是"放宽判据" ──
 *   只有真用掉的 token 才计费；截断的那次是"钱花了、代码没拿到"，
 *   那才是真的贵（storage-sync 那次白花 ¥0.066，还少装一个模块）。
 *   至于"预算大了模型会顺手把别的模块也写了"这个顾虑：
 *   它由提示词里那句"你只负责"约束，并由产物检查第 8 项（模块代码
 *   确实进入了产物）逐个模块盯着；而截断是当场就丢一块功能。
 *
 *   ⚠️ 改这个数之前，先去真实运行的 cost_records 里看一眼
 *   reasoning_tokens 的实际分布。这一道已经因为"凭感觉估"栽过两次。
 */
export const MODULE_MAX_OUTPUT_TOKENS = 32768;

/** 一个模块的产出 */
export interface ModuleBuild {
  /** 对应 ArchModule.id —— 装配与任务点都靠它认领 */
  moduleId: string;
  /** 一句话说明这个模块做了什么 */
  summary: string;
  /** 该模块的 HTML 片段（不含 <html>/<head>/<body>） */
  html: string;
  /** 该模块的 CSS 片段 */
  css: string;
  /** 该模块的 JS 片段 */
  js: string;
  /** 这一次调用折算人民币 */
  costCny: number;
  /* ---------- 下面几个字段只为"如实记账"存在 ---------- */
  /** 这一次调用的 token 用量，记进成本流水 */
  usage: TokenUsage;
  /** 实际使用的模型名 */
  model: string;
  /** 计价档位 */
  priceTier: "peak" | "offPeak";
  /** 这一次调用的耗时 */
  latencyMs: number;
  /** 输出被长度上限截断 —— 片段可能不完整 */
  truncated: boolean;
  /**
   * 这一次调用模型想的东西（complete() 一次性返回，可能很长）。
   *
   * ── 为什么它必须跟着结果走出来 ──
   *   和 spec / arch / ui 那三道是同一个道理（修法 2）：并行构建开着思考，
   *   真实运行里单个模块的思考量到过 12706 tokens ——
   *   而它原先丢在 ModelResult 里没人取，于是界面上并行构建那一步的
   *   「思考」tab 永远写着"这一步没有返回思考内容"，模型其实想了很多。
   *   一个不显示思考的构建步骤，配上"思考"这个页签，是不自洽的。
   *
   *   并行调用没有"谁先谁后"的时序可言，所以编排层是按 arch 顺序
   *   逐条发出去的（每条前面标出模块 id）—— 那是**归属**，不是时序。
   */
  reasoning: string;
}

/**
 * 一个失败的模块。
 *
 * 字段比 ModuleBuild 少，但**必须有**：少了它，"部分失败"就只能
 * 靠"模块数不对"去猜，而用户看到的是一棵凭空少了几根枝的树。
 */
export interface ModuleBuildFailure {
  moduleId: string;
  /** 失败原因（人可读，会直接显示） */
  message: string;
  /**
   * 这一次失败调用的花费。
   * 调用本身抛错时是 0（钱没花出去），但"调用成功、解析失败"
   * 那一类是**真的花了钱**的 —— 不记就是糊涂账。
   */
  costCny: number;
  usage: TokenUsage;
  /** 没走到拿到模型名就失败了时为 null */
  model: string | null;
  /** 计价档位。调用没成功时为 null（而不是随手写一个档位糊弄账本） */
  priceTier: "peak" | "offPeak" | null;
  latencyMs: number;
  /**
   * 失败那次调用模型想的东西。
   *
   * 解析失败的那一类**照样要带**：截断的模块往往正是想得最多的那些
   * （实测有一次思考 13997 把预算吃光、正文一个字没吐出来）。
   * 把它们想的内容藏起来，用户就只看到"这个模块失败了"，
   * 不知道为什么失败，也看不到它其实认真想过。
   * 调用直接抛错时没有思考，给空串。
   */
  reasoning: string;
}

/** 一次并行构建的全貌 */
export interface BuildBatch {
  /** 成功的模块（顺序与 arch.modules 一致，便于对账） */
  modules: ModuleBuild[];
  /** 失败的模块（部分失败是允许的，必须如实记录） */
  failed: ModuleBuildFailure[];
  /** 这一次实际使用的并发上限（>=1） */
  concurrency: number;
  /** 所有模块调用（含失败的那几次）折算的总花费 */
  totalCostCny: number;
  /** 所有模块调用的 token 合计 */
  totalUsage: TokenUsage;
  /**
   * 墙钟耗时（毫秒）。
   *
   * ⚠️ 它**不是**各次调用耗时之和：并发跑的时候把它们相加是一个
   * 没有意义的数（3 个各 10 秒的调用并行跑完只过了 10 秒）。
   * 记墙钟才是用户真实等待的时间。
   */
  wallClockMs: number;
  /**
   * 同时在飞的最大调用数。
   *
   * ★ 这个数字是"真的并行了"的可核实证据 ——
   *   它由工作池自己数出来，在生产环境里也成立，
   *   而不只是单测里那个假端口说了算。
   * 恒定满足 `peakInFlight <= concurrency`；串行实现会恒等于 1（或 0）。
   */
  peakInFlight: number;
  /**
   * 这一批里**因为输出被截断而加倍预算重试过**的模块 id（按 arch 顺序）。
   *
   * 为什么要有它：重试是编排层必须说出口的一件事。
   * 不说的话，用户只看到一个慢了一倍的模块，不知道它第一次顶满了预算 ——
   * 而"顶满预算"正是该让他看见的信号（它意味着这个模块比预想的大）。
   * 空数组 = 这一批没有任何模块重试过（绝大多数情况）。
   */
  retriedModules: string[];
}

/**
 * 持久化 / 投影用的摘要 —— `kind:"modules"` 事件装的就是它。
 *
 * ── 为什么事件里不带代码片段 ──
 *   代码片段是**产物**，它们的归宿是最终 HTML（以及那次装配的提示词）。
 *   把它们塞进事件里，会让每次运行的事件表多出几十 KB
 *   （事件是要逐条落库、要回放的），而回放时没有任何一处要读它们。
 *   事件要回答的是**计划层**的问题：这次并行切了几个模块、谁成了、谁没成。
 *   代码有没有真的进去，由产物检查（inspectArtifact 里那条探针）回答。
 */
export interface ModuleBuildSummary {
  moduleId: string;
  /** 人可读的模块名 —— 从 arch 查（见 summarizeBatch） */
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
  /** 同时在飞的最大调用数 —— 界面上用它说明"这次真的是并行的" */
  peakInFlight: number;
}

/**
 * 空的 token 用量。用来给"调用没成功、拿不到用量"的那几笔填空。
 *
 * 冻结起来：它是**共享**的一个对象（很多地方会把它塞进自己的字段），
 * 谁哪天顺手改了它一下，所有"没花钱"的记录都会跟着变 ——
 * 而那种错在账本上表现为"某几次调用凭空有了用量"，极难追。
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

/* ============================================================
   提示词
   ============================================================ */

/**
 * 单模块构建的系统提示词。
 *
 * ── 三条硬性要求各自的用处（不是格式洁癖）──
 *   ① `data-module="<模块 id>"`：装配与**产物检查**都靠它认领。
 *      检查那条探针要回答"这个模块的代码到底进没进最终产物"，
 *      而"一段中文文案在不在"这种判据太软（模型随手就会写同样的词）。
 *      一个不会碰巧出现的标记，才是可判真假的判据。
 *   ② 具名函数（名字里带模块 id 的驼峰）：光有标记还不够 ——
 *      标记可能被装配时当成注释留下。函数名是**代码真的在跑**的证据，
 *      而且它是第二条特征片段（标记丢了还有它）。
 *   ③ 只写自己这一块：否则模型会顺手把别的模块也写了，
 *      几个模块的产出会互相覆盖 —— 那正是"文件级并行"的合并冲突，
 *      只不过发生在提示词里。
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
  /** 它覆盖的功能条目（从 spec 里查到的人话） */
  features: { id: string; statement: string; level: "must" | "should" }[];
  /** 它依赖的模块（人可读） */
  dependencies: { id: string; name: string; responsibility: string }[];
}

/**
 * 把架构里的一条模块记录，配上规格与依赖，变成一份"派工单"。
 *
 * ── 为什么每一条都要带上 ──
 *   · 用户原话：它决定语气与边界，少了它模型会开始自由发挥；
 *   · **该模块自己的职责**：这是并行能成立的前提 —— 派工单上写不清
 *     "你只管这一块"，N 个模块就会各自写一个完整应用；
 *   · 它覆盖的功能条目：把职责落到可判定的条目上（方案里说的
 *     "每条功能都有归属"在这一步兑现）；
 *   · 它依赖的模块：依赖不是"可以晚点再说"的东西 ——
 *     被依赖方已经先跑完了（同一批里并行跑，靠职责边界对齐），
 *     写清楚才知道自己能用什么、不该重造什么。
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

/** 把派工单拼成用户消息（用户原话 + 职责 + 功能条目 + 依赖） */
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
    `你在这一批 ${total} 个模块里负责第 ${index} 个：`,
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

/* ============================================================
   解析
   ------------------------------------------------------------
   和 parseArch / parseUi 同一条原则：只做结构校验，不做质量判断。
   「这个模块写得好不好」是另一件事，这里只回答"能不能用"。
   ============================================================ */

export type ModuleParseResult =
  | {
      ok: true;
      /*
        parseModuleBuild 只解析模型给的 JSON 正文，所以它拿不到
        「这一次调用的账与思考」—— costCny / usage / model / priceTier /
        latencyMs / truncated / reasoning 都由调用方补上（见 build-modules.ts）。
        reasoning 必须留在这个 Omit 里：它来自 ModelResult，不在正文里。
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
 * 解析一次模块构建的输出。
 *
 * ⚠️ 三块片段**一块都没有**才算失败：只要有一段可用，这个模块就该进装配。
 *    多收一段无用的代码，代价是提示词长一点；
 *    少收一个模块，代价是最终产物里少一整块功能 —— 两者不对等。
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
      // summary 缺了就退回一句实话，而不是编一句"已完成"
      summary: asString(o.summary) || "（模块没有给出摘要）",
      html,
      css,
      js,
    },
  };
}

/* ============================================================
   特征片段：产物检查那条探针的全部依据
   ------------------------------------------------------------
   ★ 这是本期最要紧的一个纯函数 ★

   它回答的是：「这个模块的代码有没有真的进入最终产物？」
   判据必须**可判真假**，而且**不能恒真**：
     · 恒真的判据（比如"产物里有 <html>"）等于没检查；
     · 太软的判据（比如"产物里有中文"）会让"表演式并行"照样变绿 ——
       而表演式并行（跑 N 次、结果扔掉、最后照旧单次生成）正是
       这一期要防的那件事。
   ============================================================ */

/**
 * 一个模块的特征片段候选（按可信度从高到低）。
 *
 * 为什么要**一组**候选而不是一个：
 *   装配那一步是模型在写，它可能把双引号改成单引号、可能把类名归一化。
 *   只认一个片段的话，这些无害的改写会让检查变红，
 *   而红的原因看起来像"模块代码没进去"—— 那是**另一种谎**。
 *   一组候选、命中任意一条就算过，方向是"宁可放过，不要冤枉"。
 *
 * 但候选本身必须**硬**：标记 / 函数名 / 类选择器 / id，
 * 全是不会碰巧出现的字符串。
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
    ① 认领标记。这是模块构建提示词里**强制要求**的那一个，
       也是装配提示词里要求原样保留的那一个。
       两种引号都收：模型换引号不该让检查变红。
  */
  push(m.html.includes(`data-module="${m.moduleId}"`) ? `data-module="${m.moduleId}"` : null);
  push(m.html.includes(`data-module='${m.moduleId}'`) ? `data-module='${m.moduleId}'` : null);

  /*
    ② js 里的具名函数 / 类 / 常量。
       标记可能被装配时当成注释留下，函数名是**代码真的在跑**的证据。
  */
  push(firstIdentifier(m.js));
  /* ③ css 里的类选择器 / id 选择器 */
  push(firstSelector(m.css));
  /* ④ html 里的 id（最后的兜底：至少证明这一块标记进过产物） */
  push(/id="([A-Za-z][\w-]{3,})"/.exec(m.html)?.[1] ?? null);

  return out.slice(0, 4);
}

/** js 里第一个像样的具名函数/类/常量名 */
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

/** css 里第一个类选择器或 id 选择器（取整个选择器，不是只取名） */
function firstSelector(css: string): string | null {
  const hit = /(^|[\s,{}])([.#][A-Za-z][\w-]{2,})/.exec(css)?.[2];
  return hit ?? null;
}

/**
 * 一个模块的**首选**特征片段（界面上、报错里用它来指认是哪个模块）。
 * 提不出任何候选时返回 null —— 那意味着"无法判断"，
 * 而无法判断**不能算通过**（见 prompt.ts 里那条检查）。
 */
export function moduleSignature(m: {
  moduleId: string;
  html: string;
  css: string;
  js: string;
}): string | null {
  return moduleSignatureCandidates(m)[0] ?? null;
}

/* ============================================================
   装配提示词：★ 模块产出真的喂给最终产物的那一处 ★
   ------------------------------------------------------------
   这一段是整个特性的兑现点。前面几步（并行调用、解析、记账）
   都只是准备工作；**只有把这些片段真的拼进装配那一次调用的提示词里**，
   "并行构建"才不是表演。
   ============================================================ */

/**
 * 每个模块的片段最多带多少字符。
 *
 * ── 为什么必须截断 ──
 *   6 个模块 × 每模块上万字符 = 一次十几万字符的输入，
 *   token 成本会盖过"并行省下来的时间"。所以要有上限。
 *
 * ── 为什么截断是**掐尾**而不是掐头 ──
 *   特征片段（data-module 标记、函数名）都在片段的**开头**。
 *   掐头会把它们切掉，于是产物检查那条探针会因为"提示词里没给"
 *   而变红 —— 那等于自己制造了一个假故障。掐尾则只丢细节，不丢身份。
 */
export const MODULE_FRAGMENT_MAX_CHARS = 4000;

/** 所有模块片段合起来的上限（防止模块多的时候提示词失控） */
export const ASSEMBLE_TOTAL_MAX_CHARS = 24000;

/** 掐尾并留下"这里被截断了"的痕迹 —— 静默丢内容是最难查的一类问题 */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n/* …（片段过长，已截断 ${text.length - max} 字符）*/`;
}

/**
 * 装配那一次调用的用户消息。
 *
 * 结构（顺序是有意的）：
 *   ① 用户原话，**一字不改**地放最前面 —— 它是这次运行的起点，
 *      也是模型判断"到底要做什么"的唯一依据；
 *   ② 每个模块的片段，逐块标明 id / 名字 / 职责 / 摘要；
 *   ③ 失败的模块**也要写出来**（见下面那段）；
 *   ④ 装配要求：保留 data-module 标记、拼成一个自包含单文件。
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
    失败的模块也要说出来。

    ── 为什么不能只报成功的 ──
      模型看不见失败清单的话，它会照着"用户要的完整功能"把缺的那块**编出来** ——
      于是产物看起来是完整的，而其中一整块是无中生有。
      用户拿到的会是一个"看起来做完了、其实某块是假的"成品，
      这比明确少一块糟得多。所以这里把失败摊开，并要求模型
      **不要替它编**：缺的功能宁可留一句"这块没做成"的说明。
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

/* ============================================================
   汇总
   ============================================================ */

/**
 * 把 BuildBatch 压成可以持久化的摘要（`kind:"modules"` 事件的载荷）。
 *
 * ⚠️ 模块名从 **arch** 查（不从这里自己编）：
 *   它是架构那一阶段定下来的东西，这里只是把它带到事件里，
 *   好让投影层不必回头再翻一遍 arch 事件也能显示人话标题
 *   （from-run.ts 仍然会以 arch 事件为准，见那里 modulePoints 的说明）。
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

/** 一句话描述这批构建的结果（界面与日志用） */
export function summarizeBuildBatch(batch: BuildBatch): string {
  const total = batch.modules.length + batch.failed.length;
  const base =
    `${total} 个模块 · 并发 ${batch.concurrency}` +
    `（实际同时在飞 ${batch.peakInFlight}）· 成功 ${batch.modules.length}`;
  if (batch.failed.length === 0) return base;
  return `${base} · 失败 ${batch.failed.length}（${batch.failed.map((f) => f.moduleId).join("、")}）`;
}