/**
 * 界面设计规格（ui-spec）
 * ============================================================
 * 六道工序的第三道：把**一张模块图**变成**一套设计变量 + 一棵页面/组件树**。
 *
 * ── 为什么这一阶段必须存在 ──
 *   `stages.ts:238-239` 把它存在的理由写死了：
 *   「设计变量是并行开发时视觉一致性的唯一保障。
 *     没有它，N 个执行 Agent 会做出 N 种风格。」
 *   第四道「并行构建」的粒度是**模块**：几个模块同时开工、互相看不见对方。
 *   如果颜色、间距、圆角是各写各的，最后拼起来就是几种风格硬凑在一页上 ——
 *   而这种错在装配之前完全看不出来，因为每个模块单独看都是对的。
 *   所以这一道的产物不是"好看的稿子"，是**一份所有并行单元都要遵守的变量表**。
 *
 * ── 为什么输入要带上规格和架构两样 ──
 *   这一道的三条验收标准正好一条对着一份输入：
 *     · 「每条功能都有对应的页面或入口」      → 要 spec（功能条目就是 acceptance）
 *     · 「组件树引用的设计变量全部已定义」    → 只要 ui 自己（自洽性）
 *     · 「页面用到的数据都能在接口契约里找到」→ 要 arch（数据由哪个模块提供）
 *   少一样，就有一条验收标准判不了。所以签名里 spec 与 arch 都是必填。
 *
 * ── 为什么页面/组件的 id 是「小写字母数字连字符」这种死规矩 ──
 *   理由和 `domain/arch.ts` 里那段**逐字相同**：页面 id 会变成任务点 id
 *   （`ui:<页面 id>`，见 planning/from-run.ts），也就是画布上的节点 id、
 *   清单里的行 id、URL 里 `?focus=` 的值。三处各自长出一套转义规则的话，
 *   对不上的表现是「点一下没反应」，不报错。
 *   所以这里**直接复用** arch 的归一实现，而不是抄一份长得差不多的 ——
 *   两份"差不多"的规则，总有一天会在某个字符上不一样。
 *
 * ── 为什么设计变量名要归一到 `--x` 形式 ──
 *   这一栏会被原样写进 CSS（`var(--color-surface)`），名字写错一个字符
 *   在浏览器里就是**静默失效**：样式不生效，控制台不报错。
 *   而模型对同一个变量的写法会有好几种（`color-surface` / `var(--color-surface)`
 *   / `--Color-Surface`）。与其让第二条检查去猜"这两个是不是同一个"，
 *   不如在解析时就归成唯一一种写法：**一个变量只有一个名字**。
 *
 * ── 为什么这一层是纯函数 ──
 *   和 domain/spec.ts、domain/arch.ts 同一条理由：解析与兜底不该依赖网络。
 *   抽出来之后，「模型返回了一坨不是 JSON 的东西」这种事可以在毫秒级的单测里钉死。
 */

import { normalizeModuleId, type ArchSpec } from "./arch";
import { extractJsonText, type AppSpec } from "./spec";

/* ============================================================
   类型
   ============================================================ */

/**
 * 一个设计变量（CSS 自定义属性）。
 *
 * 字段顺序就是它的重要性顺序：先能**被引用**（name），再是它的值（value）。
 * 名字错了，第二条检查（无悬空引用）就永远对不上；值错了，
 * 顶多是某个颜色不对 —— 前者会让整条并行构建失去统一口径。
 */
export interface DesignToken {
  /** 变量名，形如 --color-surface。一律以 -- 开头 */
  name: string;
  /** 变量的值，形如 #0f172a / 8px / system-ui, sans-serif */
  value: string;
}

/**
 * 一个页面。
 *
 * ⚠️ 它不是"路由表里的一行"，而是**第三道工序交给第四道的活儿**：
 *    from-run.ts 会为每个页面生成一个 `ui:<id>` 的任务点，
 *    左侧清单里「界面设计」那一道下面列出来的就是它们。
 *    所以 id 必须稳定（理由同 arch 的模块 id）。
 */
export interface UiPage {
  /** 稳定标识（小写字母数字连字符），用于做任务点 id */
  id: string;
  /** 人可读 */
  name: string;
  /** 路由，形如 / 或 /board —— 界面上要能显示"从哪儿进" */
  route: string;
  /** 这个页面实现了规格里哪些条目 id（AppSpec.acceptance[].id） */
  coversFeatures: string[];
  /**
   * 这个页面要用到的数据。
   *
   * 写的是**架构里模块的 id 或名称** —— 因为 ArchModule 现在没有
   * 「接口契约」这一栏（见 generate/ui-check.ts 里第三条检查的说明），
   * 能对上的东西只有模块本身。
   */
  dataNeeds: string[];
}

/**
 * 一个组件。
 *
 * `usesTokens` 是**引用列表**，不是定义列表：这些名字必须已经出现在
 * `ui.tokens` 里，否则就是"悬空引用"—— 那正是第二条验收标准要抓的东西。
 */
export interface UiComponent {
  /** 稳定标识（小写字母数字连字符） */
  id: string;
  /** 人可读 */
  name: string;
  /** 用在哪些页面上（页面 id） */
  usedOn: string[];
  /** 用到哪些设计变量。只写名字，例如 --color-surface（不写 var(...) 那一层） */
  usesTokens: string[];
}

export interface UiSpec {
  tokens: DesignToken[];
  pages: UiPage[];
  components: UiComponent[];
}

/* ============================================================
   提示词
   ============================================================ */

/**
 * ⚠️ 第 2 条与第 3 条是这一阶段最要紧的两句话：
 *   · 「用到的变量必须先在 tokens 里定义」—— 悬空引用在浏览器里是静默失效，
 *     只有在这里说清楚，模型才不会随手编一个变量名；
 *   · 「dataNeeds 只写架构里已经存在的模块 id」—— 第三条检查能对上的
 *     东西只有模块本身（没有接口契约这一栏），编一个模块名就是编一个查不到的东西。
 */
export const UI_SYSTEM_PROMPT = `你是一位界面设计师。用户会用一句话描述他想做的软件，
现在需求已经整理成规格（含逐条验收标准），技术方案也已经切成模块。
你的任务是把它们变成一套**所有并行开发者都要遵守**的界面设计：
一份设计变量表、若干页面、以及页面上用到的组件。

只输出一个 JSON 对象，不要有任何解释文字、不要包代码块围栏。

字段要求：
{
  "tokens": [
    { "name": "--color-surface", "value": "#0f172a" }
  ],
  "pages": [
    {
      "id": "小写字母数字连字符，例如 task-board。它会变成任务点的 id，必须稳定",
      "name": "人可读的页面名",
      "route": "/ 或 /xxx",
      "coversFeatures": ["这个页面实现了规格里哪些验收标准的 id，例如 ac-1"],
      "dataNeeds": ["这个页面要用到的数据由哪个模块提供。只写上面架构里已经存在的模块 id"]
    }
  ],
  "components": [
    {
      "id": "小写字母数字连字符，例如 task-card",
      "name": "人可读的组件名",
      "usedOn": ["它出现在哪些页面上。写页面 id"],
      "usesTokens": ["它用到了哪些设计变量。只写变量名，例如 --color-surface（不要写 var(...)）"]
    }
  ]
}

硬性要求：
1. **规格里每一条验收标准（acceptance[].id）都必须出现在某个页面的 coversFeatures 里**。
   有归属不了的条目，说明页面切得不对 —— 那是这一阶段最严重的错
2. **组件 usesTokens 里出现的每个变量都必须在 tokens 里定义过**。
   一个都不许悬空 —— 用了没定义的变量在浏览器里是**静默失效**，不报错
3. dataNeeds 只写上面架构里**真实存在**的模块 id，不要编造模块名
4. tokens 至少 4 个、至多 20 个；重点是颜色、间距、字号这几类**会被多处复用**的
5. pages 至少 1 个、至多 6 个；components 至少 1 个、至多 12 个`;

/** 把用户原话、规格与架构一起包成用户消息 */
export function buildUiPrompt(userInput: string, spec: AppSpec, arch: ArchSpec): string {
  const acceptance = spec.acceptance
    .map((a) => `  · ${a.id}｜${a.statement}（${a.level === "must" ? "必需" : "期望"}）`)
    .join("\n");

  /*
    架构这一段要把**模块 id** 明写出来：第三条检查（dataNeeds 对得上模块）
    判的就是这个字符串，让模型自己猜 id 的写法是没必要的损耗。
    责任与归属一起给出来，是为了让它知道"这份数据该找谁"。
  */
  const modules = arch.modules
    .map(
      (m) =>
        `  · ${m.id}｜${m.name}｜负责：${m.responsibility || "（未填写）"}` +
        `（承接条目：${m.coversFeatures.join("、") || "无"}）`,
    )
    .join("\n");

  return [
    "用户的一句话需求：",
    "",
    userInput.trim(),
    "",
    "已经整理好的规格：",
    `  · 目标：${spec.goal || "（未填写）"}`,
    `  · 给谁用：${spec.audience || "（未填写）"}`,
    "  · 验收标准（每一条都要有页面承接）：",
    acceptance || "  （规格里没有验收标准）",
    "",
    "已经定型的架构（dataNeeds 只能从这里挑模块 id）：",
    modules || "  （架构里没有模块）",
    "",
    "请产出界面设计 JSON。",
  ].join("\n");
}

/* ============================================================
   解析
   ------------------------------------------------------------
   和 parseSpec / parseArch 同一条原则：只做结构校验，不做质量判断 ——
   「三条检查过不过」是 generate/ui-check.ts 的事。
   两者分开之后，失败时的报错能精确到是哪一类问题。
   ============================================================ */

export type UiParseResult =
  | { ok: true; ui: UiSpec }
  | { ok: false; reason: string; raw: string };

/**
 * 页面 / 组件的 id 规矩与架构模块**逐字符一致**，所以直接复用它的实现。
 * 抄第二份的代价不是多几行代码，是两份规则将来会在某个字符上不一样 ——
 * 而那时候页面点不动、模块点得动，谁也说不清为什么。
 */
export const normalizeUiId = normalizeModuleId;

/**
 * 把一个设计变量名归一成唯一的写法。
 *
 * 收得下模型可能给出的几种写法：
 *   `--color-surface`            → `--color-surface`
 *   `color-surface`              → `--color-surface`
 *   `var(--color-surface)`       → `--color-surface`
 *   `var(--color-surface, #fff)` → `--color-surface`（兜底值不参与命名）
 *   `--Color Surface`            → `--color-surface`
 *
 * 归一之后返回的一定是 `--` 开头、只含小写字母数字与单个连字符的名字；
 * 一个可用字符都没有时返回空串，由调用方丢掉它。
 */
export function normalizeTokenName(raw: string): string {
  let s = raw.trim().toLowerCase();

  // 先把 var(...) 那一层剥掉 —— 定义里不该出现它
  const wrapped = /^var\(\s*(--[^,)\s]+)\s*(?:,[^)]*)?\)$/.exec(s);
  if (wrapped) s = wrapped[1];

  const body = s
    .replace(/^-+/, "") // 去掉开头的连字符，最后统一补 `--`
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");

  return body ? `--${body}` : "";
}

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === "string")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function parseUi(raw: string): UiParseResult {
  const jsonText = extractJsonText(raw);
  if (!jsonText) {
    return { ok: false, reason: "模型输出里找不到 JSON 对象", raw };
  }

  let obj: unknown;
  try {
    obj = JSON.parse(jsonText);
  } catch (e) {
    return {
      ok: false,
      reason: `JSON 解析失败：${e instanceof Error ? e.message : String(e)}`,
      raw,
    };
  }

  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    return { ok: false, reason: "JSON 顶层不是对象", raw };
  }

  const o = obj as Record<string, unknown>;

  /* ---------- 设计变量 ---------- */
  const tokens: DesignToken[] = [];
  const seenTokens = new Set<string>();

  if (Array.isArray(o.tokens)) {
    for (const rawToken of o.tokens) {
      if (typeof rawToken !== "object" || rawToken === null) continue;
      const t = rawToken as Record<string, unknown>;

      const name = normalizeTokenName(asString(t.name));
      // 归一到空串，说明它连一个可用字符都没有 —— 这个变量定义不了任何东西
      if (!name) continue;
      /*
        同一个变量名出现两次：**只认第一个**。
        后者覆盖的话，"这个变量到底等于什么"就没有答案了 ——
        而并行构建的几个模块会各自读到其中一个值，最后拼出来的界面自己不一致。
      */
      if (seenTokens.has(name)) continue;
      seenTokens.add(name);

      tokens.push({ name, value: asString(t.value) });
    }
  }

  /* ---------- 页面 ---------- */
  const pages: UiPage[] = [];
  const seenPages = new Set<string>();

  if (Array.isArray(o.pages)) {
    for (const rawPage of o.pages) {
      if (typeof rawPage !== "object" || rawPage === null) continue;
      const p = rawPage as Record<string, unknown>;

      const id = normalizeUiId(asString(p.id));
      if (!id) continue;
      if (seenPages.has(id)) continue;
      seenPages.add(id);

      pages.push({
        id,
        // 名字缺了就退回 id：宁可显示一个机器味的名字，也不要空白标题
        name: asString(p.name) || id,
        /*
          缺 route 时给 "/"：单页应用里的"页面"本来就是同一路径下切换的视图，
          这是**最保守**的一档，而且它不编造一个新路径。
        */
        route: asString(p.route) || "/",
        /*
          coversFeatures **不归一**：那些 id 来自规格（AppSpec.acceptance[].id），
          是别人定的形状。在这里改它，等于把"模型写错了引用"这件事偷偷改成
          "引用对了"——第一条检查（无孤儿功能）就再也发现不了真正的错位。
        */
        coversFeatures: asStringArray(p.coversFeatures),
        // dataNeeds 也不归一：它们要和架构里的模块 id / 名称逐字比对，
        // 在这里改写会让第三条检查去比一个模型从没写过的字符串
        dataNeeds: asStringArray(p.dataNeeds),
      });
    }
  }

  /*
    一个页面都没有 → 明确失败，交给兜底。
    空界面是**不可用**的：它下面长不出任何任务点（from-run.ts 的 ui 子树
    就是按页面长的），第四道也就不知道要做几个界面。
    这种时候说"解析成功"只会把一个空洞一路带到清单上。
  */
  if (pages.length === 0) {
    return {
      ok: false,
      reason: "界面里一个页面都没有（pages 为空或全都不带合法 id）",
      raw,
    };
  }

  /* ---------- 组件 ---------- */
  const components: UiComponent[] = [];
  const seenComponents = new Set<string>();

  if (Array.isArray(o.components)) {
    for (const rawComponent of o.components) {
      if (typeof rawComponent !== "object" || rawComponent === null) continue;
      const c = rawComponent as Record<string, unknown>;

      const id = normalizeUiId(asString(c.id));
      if (!id) continue;
      if (seenComponents.has(id)) continue;
      seenComponents.add(id);

      components.push({
        id,
        name: asString(c.name) || id,
        /*
          usedOn 里的页面引用也做同一套归一 —— 否则 "Task Board" 和 "task-board"
          会被当成两个页面，界面上就会出现一个查不到对应页面的组件。
          （这一条三条检查都不判，但形状不一致的产物会让第四道自己都读不懂。）
        */
        usedOn: asStringArray(c.usedOn).map(normalizeUiId).filter(Boolean),
        /*
          usesTokens 归一成 `--x` 形式：第二条检查（无悬空引用）比的正是这些名字，
          而模型对同一个变量会有好几种写法（见 normalizeTokenName）。
          不归一的话，`var(--color-surface)` 和定义里的 `--color-surface`
          会被判成两个东西，检查会**误报**一份其实自洽的产物。
        */
        usesTokens: asStringArray(c.usesTokens).map(normalizeTokenName).filter(Boolean),
      });
    }
  }

  return { ok: true, ui: { tokens, pages, components } };
}

/* ============================================================
   降级：模型没能给出可用界面设计时
   ------------------------------------------------------------
   和 spec / arch 的兜底同一个取舍：一次解析失败不该让整条流水线停下来。
   兜底界面**故意只有一个页面、一套最小变量**，而且：
     · 它承接规格里每一条验收标准；
     · 它只引用自己定义过的那几个变量；
     · 它声明需要架构里**每一个模块**提供的数据（单页应用把全部功能做在一起，
       确实要用到每个模块的数据 —— 这一句是实话，不是为了凑绿第一条检查）。
   于是三条本地检查在兜底产物上都是**诚实地**绿的：这一版确实没有切页面、
   没有做设计决策，检查说的正是这件事，而不是假装设计过了。
   ============================================================ */

export const UI_FALLBACK_MARK = "（兜底界面：未能从模型获得结构化界面设计）";

export function fallbackUi(meta: {
  spec: AppSpec;
  arch: ArchSpec;
  model: string;
  generatedAt: number;
}): UiSpec {
  const TOKENS: DesignToken[] = [
    { name: "--color-surface", value: "#0f172a" },
    { name: "--color-text", value: "#e2e8f0" },
    { name: "--space-1", value: "8px" },
    { name: "--radius-1", value: "6px" },
  ];

  return {
    tokens: TOKENS,
    pages: [
      {
        id: "home",
        name: `单页界面${UI_FALLBACK_MARK}`,
        route: "/",
        /*
          每一条验收标准都挂上：兜底页面确实"负责全部"，
          所以这是实话，不是为了让检查变绿而凑数。
        */
        coversFeatures: meta.spec.acceptance.map((a) => a.id),
        /*
          需要每个模块的数据 —— 单页应用把全部功能做在一个页面里，
          它确实要用到所有模块提供的数据。架构的兜底也是同一个口径：
          一个模块承接全部功能。
        */
        dataNeeds: meta.arch.modules.map((m) => m.id),
      },
    ],
    components: [
      {
        id: "app-shell",
        name: `页面外壳${UI_FALLBACK_MARK}`,
        usedOn: ["home"],
        // 只引用上面**定义过**的变量：兜底不制造悬空引用
        usesTokens: TOKENS.map((t) => t.name),
      },
    ],
  };
}

/** 兜底界面在界面上要显著区别于真界面 —— 和 isFallbackSpec / isFallbackArch 同一套做法 */
export function isFallbackUi(ui: UiSpec): boolean {
  return (
    ui.pages.some((p) => p.name.includes(UI_FALLBACK_MARK)) ||
    ui.components.some((c) => c.name.includes(UI_FALLBACK_MARK))
  );
}

/** 界面设计摘要，供界面与日志使用 */
export function summarizeUi(ui: UiSpec): string {
  const refs = ui.components.reduce((n, c) => n + c.usesTokens.length, 0);
  return `${ui.pages.length} 个页面 · ${ui.components.length} 个组件 · ${ui.tokens.length} 个设计变量（被引用 ${refs} 次）`;
}