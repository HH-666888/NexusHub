/**
 * 界面设计规格（ui-spec）：把模块图变成一套设计变量 + 页面/组件树。
 * 设计变量是并行构建时视觉一致性的唯一保障：几个模块同时开工、互相看不见对方，
 * 颜色间距各写各的就会拼出几种风格。id 规矩直接复用 arch 的归一，不抄第二份。
 */

import { normalizeModuleId, type ArchSpec } from "./arch";
import { extractJsonText, type AppSpec } from "./spec";

/**
 * 一个设计变量（CSS 自定义属性）。name 错了第二条检查永远对不上；
 * value 错了顶多是某个颜色不对。
 */
export interface DesignToken {
  /** 形如 --color-surface，一律以 -- 开头。会被原样写进 CSS，错一个字符就是静默失效 */
  name: string;
  /** 形如 #0f172a / 8px / system-ui, sans-serif */
  value: string;
}

/**
 * 一个页面。它不是路由表里的一行，而是第三道工序交给第四道的活儿：
 * from-run.ts 会为每个页面生成一个 ui:<id> 任务点，所以 id 必须稳定。
 */
export interface UiPage {
  /** 小写字母数字连字符，用于做任务点 id */
  id: string;
  name: string;
  /** 形如 / 或 /board，界面要能显示从哪儿进 */
  route: string;
  /** 规格里哪些条目 id（AppSpec.acceptance[].id） */
  coversFeatures: string[];
  /**
   * 这个页面要用到的数据，写架构里模块的 id 或名称：ArchModule 没有接口契约这一栏
   * （见 generate/ui-check.ts 第三条检查），能对上的只有模块本身。
   */
  dataNeeds: string[];
}

/**
 * 一个组件。usesTokens 是引用列表而非定义列表：名字必须已在 ui.tokens 里，
 * 否则就是悬空引用，正是第二条验收标准要抓的东西。
 */
export interface UiComponent {
  /** 小写字母数字连字符 */
  id: string;
  name: string;
  /** 页面 id */
  usedOn: string[];
  /** 只写变量名，例如 --color-surface（不写 var(...) 那一层） */
  usesTokens: string[];
}

export interface UiSpec {
  tokens: DesignToken[];
  pages: UiPage[];
  components: UiComponent[];
}

/**
 * 第 2、3 条最要紧：悬空引用在浏览器里是静默失效；dataNeeds 只能写架构里
 * 真实存在的模块 id，第三条检查能对上的只有模块本身。
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

/** 用户消息：原话 + 规格 + 架构 */
export function buildUiPrompt(
  userInput: string,
  spec: AppSpec,
  arch: ArchSpec,
): string {
  const acceptance = spec.acceptance
    .map(
      (a) => `  · ${a.id}｜${a.statement}（${a.level === "must" ? "必需" : "期望"}）`,
    )
    .join("\n");

  /*
    架构这段要明写模块 id：第三条检查判的就是这个字符串，让模型猜写法是没必要的损耗。
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

// 只做结构校验，不做质量判断；三条检查过不过由 generate/ui-check.ts 判

export type UiParseResult =
  { ok: true; ui: UiSpec } | { ok: false; reason: string; raw: string };

/**
 * 页面 / 组件 id 的规矩与架构模块逐字符一致，所以直接复用它的实现。
 * 抄第二份的代价是两份规则将来会在某个字符上不一样，那时页面点不动、模块点得动。
 */
const normalizeUiId = normalizeModuleId;

/**
 * 把设计变量名归一成唯一写法，收得下模型可能给出的几种：
 *   --color-surface / color-surface / var(--color-surface) / var(--x, #fff) / --Color Surface
 * 兜底值不参与命名。返回一定以 -- 开头；一个可用字符都没有时返回空串，由调用方丢掉。
 */
function normalizeTokenName(raw: string): string {
  let s = raw.trim().toLowerCase();

  // 先剥掉 var(...) 那一层，定义里不该出现它
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

  const tokens: DesignToken[] = [];
  const seenTokens = new Set<string>();

  if (Array.isArray(o.tokens)) {
    for (const rawToken of o.tokens) {
      if (typeof rawToken !== "object" || rawToken === null) continue;
      const t = rawToken as Record<string, unknown>;

      const name = normalizeTokenName(asString(t.name));
      // 归一到空串说明没有可用字符，定义不了任何东西
      if (!name) continue;
      /*
        同一个变量名只认第一个：后者覆盖的话，并行构建的几个模块会各自读到不同的值。
      */
      if (seenTokens.has(name)) continue;
      seenTokens.add(name);

      tokens.push({ name, value: asString(t.value) });
    }
  }

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
        // 缺名字退回 id，避免空白标题
        name: asString(p.name) || id,
        // 缺 route 给 "/"：单页应用的页面本来就是同一路径下切换的视图，不编造新路径
        route: asString(p.route) || "/",
        /*
          coversFeatures 不归一：那些 id 是规格定的形状，在这里改等于把引用错误
          改成引用正确，第一条检查就再也发现不了真正的错位。
        */
        coversFeatures: asStringArray(p.coversFeatures),
        // dataNeeds 也不归一：第三条检查要逐字比对架构里的模块 id / 名称
        dataNeeds: asStringArray(p.dataNeeds),
      });
    }
  }

  /*
    空界面不可用：from-run.ts 的 ui 子树按页面长，没有页面第四道就不知道做几个界面。
  */
  if (pages.length === 0) {
    return {
      ok: false,
      reason: "界面里一个页面都没有（pages 为空或全都不带合法 id）",
      raw,
    };
  }

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
          usedOn 也做同一套归一，否则 "Task Board" 与 "task-board" 会被当成两个页面，
          界面上就会出现一个查不到对应页面的组件。
        */
        usedOn: asStringArray(c.usedOn).map(normalizeUiId).filter(Boolean),
        /*
          usesTokens 归一成 --x 形式：不归一的话，var(--color-surface) 与定义里的
          --color-surface 会被判成两个东西，第二条检查会误报一份其实自洽的产物。
        */
        usesTokens: asStringArray(c.usesTokens).map(normalizeTokenName).filter(Boolean),
      });
    }
  }

  return { ok: true, ui: { tokens, pages, components } };
}

// 兜底：解析失败不该让整条流水线停下。故意只做一个页面、一套最小变量，
// 它承接全部验收标准、只引用自己定义过的变量、声明需要每个模块的数据，
// 于是三条本地检查在兜底产物上是诚实地绿的，而不是假装设计过了。

const UI_FALLBACK_MARK = "（兜底界面：未能从模型获得结构化界面设计）";

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
        // 兜底页面确实负责全部，所以每条都挂上
        coversFeatures: meta.spec.acceptance.map((a) => a.id),
        /*
          单页应用把全部功能做在一个页面里，确实要用到所有模块的数据；
          架构的兜底也是同一个口径：一个模块承接全部功能。
        */
        dataNeeds: meta.arch.modules.map((m) => m.id),
      },
    ],
    components: [
      {
        id: "app-shell",
        name: `页面外壳${UI_FALLBACK_MARK}`,
        usedOn: ["home"],
        // 只引用定义过的变量，不制造悬空引用
        usesTokens: TOKENS.map((t) => t.name),
      },
    ],
  };
}

/** 与真界面区分，做法同 isFallbackSpec */
export function isFallbackUi(ui: UiSpec): boolean {
  return (
    ui.pages.some((p) => p.name.includes(UI_FALLBACK_MARK)) ||
    ui.components.some((c) => c.name.includes(UI_FALLBACK_MARK))
  );
}

/** 摘要，供界面与日志使用 */
export function summarizeUi(ui: UiSpec): string {
  const refs = ui.components.reduce((n, c) => n + c.usesTokens.length, 0);
  return `${ui.pages.length} 个页面 · ${ui.components.length} 个组件 · ${ui.tokens.length} 个设计变量（被引用 ${refs} 次）`;
}
