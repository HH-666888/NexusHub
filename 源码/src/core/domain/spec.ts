/**
 * 应用规格（spec）
 * ============================================================
 * 六道工序的第一道：把一句人话变成一份**可机器校验的验收依据**。
 *
 * ── 为什么这一阶段必须存在 ──
 *   没有它，最后一步「验收」就没有判定依据，只能让模型自己说
 *   「我觉得做好了」—— 那不叫验收，那叫自评。
 *   整条流水线的闭环靠的就是：①产出验收标准，⑥拿它逐条对。
 *
 * ── 为什么把「追问」做成一等公民 ──
 *   用户说「做一个任务看板」，这里面的空白比字面多得多：
 *   给谁用？单机还是多人？要不要登录？
 *   直接往下走的话，模型会替你猜，而猜错要等到最后一步才暴露 ——
 *   那时已经花完钱了。
 *   所以规格化阶段允许**停下来问**，而且问之前不进入下一道工序。
 *
 * ── 为什么是纯函数 ──
 *   这一整套判断（够不够格往下走、模型给的 JSON 合不合法）
 *   不该依赖网络。抽出来之后可以用几十条单测把所有边界钉死，
 *   包括「模型返回了一坨不是 JSON 的东西」这种情况。
 */

/* ============================================================
   类型
   ============================================================ */

/** 一条验收标准 */
export interface AcceptanceCriterion {
  /** 稳定标识，供后续阶段与验收报告引用 */
  id: string;
  /** 用一句可判断真假的话说清楚「做到什么算做到」 */
  statement: string;
  /** 怎么验证它。必须是可执行的，不能是「看起来对」 */
  verifyBy: string;
  /**
   * 必需 / 期望。
   * 区分这两档是为了让验收能给出「通过但有保留」，
   * 而不是非黑即白 —— 现实里的交付大多是前者。
   */
  level: "must" | "should";
}

/** 清晰的边界：明确不做什么 */
export interface SpecScope {
  inScope: string[];
  outOfScope: string[];
}

export interface AppSpec {
  /** 用户原始那一句话，一字不改地留着 */
  prompt: string;
  /** 归一化后的目标陈述 */
  goal: string;
  /** 给谁用 */
  audience: string;
  /** 核心使用场景，按重要性排序 */
  scenarios: string[];
  acceptance: AcceptanceCriterion[];
  scope: SpecScope;
  /**
   * 需要向用户确认的疑点。
   * **非空时这道工序不能算完成** —— 见下面 isSpecReady。
   */
  questions: string[];
  /** 产出这份规格的模型 */
  model: string;
  generatedAt: number;
}

/* ============================================================
   提示词
   ============================================================ */

export const SPEC_SYSTEM_PROMPT = `你是一位需求分析师。用户会用一句话描述他想做的软件，
你的任务是把这句话变成一份可执行的规格。

只输出一个 JSON 对象，不要有任何解释文字、不要包代码块围栏。

字段要求：
{
  "goal": "一句话说清这个东西是干什么的",
  "audience": "给谁用。若原文没提，写你从需求推断出的最可能人群，并在 questions 里确认",
  "scenarios": ["核心使用场景，2-4 条，按重要性排序"],
  "acceptance": [
    {
      "id": "ac-1",
      "statement": "用可判断真假的一句话描述做到什么算做到",
      "verifyBy": "怎么验证。要说具体动作，不能写「看起来对」",
      "level": "must 或 should"
    }
  ],
  "scope": {
    "inScope": ["明确要做的"],
    "outOfScope": ["明确不做的。这一项很重要，它防止后面无限扩张"]
  },
  "questions": ["必须向用户确认才能继续的疑点"]
}

硬性要求：
1. acceptance 至少 4 条，其中至少 2 条 level 为 must
2. statement 必须能被判定真假。"界面好看"不合格，"三个栏位可以拖拽排序"合格
3. verifyBy 必须是一个具体动作。"打开页面点一下按钮，卡片移动到目标栏位"合格
4. questions 只在**真的会影响实现**时才问。能从原文合理推断的不要问，
   但要在 goal 或 audience 里写出你的推断。问一堆无关紧要的问题比不问更糟
5. outOfScope 至少写 1 条。写不出不做的范围，通常说明需求本身还没想清楚`;

/** 把用户那句话包成用户消息 */
export function buildSpecPrompt(userInput: string): string {
  return `用户的一句话需求：\n\n${userInput.trim()}\n\n请产出规格 JSON。`;
}

/* ============================================================
   解析
   ------------------------------------------------------------
   模型返回的东西不可信：可能带代码块围栏、可能带前后解释、
   可能字段类型不对。这里逐层剥，剥不出来就明确失败，
   不做「尽力而为」的猜测 —— 猜错会一路错到最后一步。
   ============================================================ */

export type SpecParseResult =
  | { ok: true; spec: AppSpec }
  | { ok: false; reason: string; raw: string };

/** 从模型输出里抠出 JSON 文本 */
export function extractJsonText(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;

  // 先试整体就是 JSON 对象
  if (text.startsWith("{")) {
    const end = text.lastIndexOf("}");
    // 有闭合括号就截到那里
    if (end > 0) return text.slice(0, end + 1);
    /*
      起了头却没有闭合 —— 输出被截断了。
      这时候**不能返回 null**：那会让上层报「找不到 JSON」，
      而真实情况是「JSON 写坏了」，两者的排查方向完全不同。
      原样返回，让 JSON.parse 给出具体的语法错误位置。
    */
    return text;
  }

  // 顶层是数组：也要抠出来，好让上层给出「不是对象」这个准确结论
  if (text.startsWith("[")) {
    const end = text.lastIndexOf("]");
    if (end > 0) return text.slice(0, end + 1);
    return text;
  }

  // 再试 ```json ... ``` 围栏
  const fenced = /```(?:json)?\s*\n?([\s\S]*?)```/.exec(text);
  if (fenced) {
    const inner = fenced[1].trim();
    if (inner.startsWith("{") || inner.startsWith("[")) return inner;
  }

  // 最后试「第一个 { 到最后一个 }」
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return text.slice(start, end + 1);

  // 对象没有，数组也试试
  const arrStart = text.indexOf("[");
  const arrEnd = text.lastIndexOf("]");
  if (arrStart >= 0 && arrEnd > arrStart) return text.slice(arrStart, arrEnd + 1);

  return null;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === "string")
    .map((s) => s.trim())
    .filter(Boolean);
}

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * 解析模型输出。
 *
 * 注意这里**只做结构校验，不做质量判断** ——
 * 「验收标准够不够硬」由 validateSpec 负责，
 * 两者分开之后，失败时的报错能精确到是哪一类问题。
 */
export function parseSpec(
  raw: string,
  meta: { prompt: string; model: string; generatedAt: number },
): SpecParseResult {
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
  const scopeRaw =
    typeof o.scope === "object" && o.scope !== null
      ? (o.scope as Record<string, unknown>)
      : {};

  const acceptance: AcceptanceCriterion[] = Array.isArray(o.acceptance)
    ? o.acceptance
        .filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null)
        .map((x, i) => ({
          id: asString(x.id) || `ac-${i + 1}`,
          statement: asString(x.statement),
          verifyBy: asString(x.verifyBy),
          level: x.level === "must" ? ("must" as const) : ("should" as const),
        }))
        // 缺了 statement 的条目直接丢掉：留着它只会让验收阶段
        // 去校验一条根本没说清的标准
        .filter((x) => x.statement.length > 0)
    : [];

  const spec: AppSpec = {
    // 原文一字不改地留着 —— 后面所有阶段引用需求时都以它为准，
    // 而不是以模型改写过的 goal 为准
    prompt: meta.prompt,
    goal: asString(o.goal),
    audience: asString(o.audience),
    scenarios: asStringArray(o.scenarios),
    acceptance,
    scope: {
      inScope: asStringArray(scopeRaw.inScope),
      outOfScope: asStringArray(scopeRaw.outOfScope),
    },
    questions: asStringArray(o.questions),
    model: meta.model,
    generatedAt: meta.generatedAt,
  };

  return { ok: true, spec };
}

/* ============================================================
   校验
   ------------------------------------------------------------
   分成两档：blocking（拦下，不能往下走）与 advisory（提醒，但放行）。
   现实里的需求很少一次就完美，全拦下来会把用户卡死；
   但验收标准不过关是真不能往下走的 —— 那会让第六道工序失去依据。
   ============================================================ */

export interface SpecIssue {
  level: "blocking" | "advisory";
  message: string;
}

export const SPEC_MIN_ACCEPTANCE = 4;
export const SPEC_MIN_MUST = 2;

export function validateSpec(spec: AppSpec): SpecIssue[] {
  const issues: SpecIssue[] = [];

  if (!spec.goal) {
    issues.push({ level: "blocking", message: "缺少目标陈述" });
  }
  if (!spec.audience) {
    issues.push({ level: "advisory", message: "没有说明给谁用" });
  }
  if (spec.scenarios.length === 0) {
    issues.push({ level: "blocking", message: "没有列出任何使用场景" });
  }

  if (spec.acceptance.length < SPEC_MIN_ACCEPTANCE) {
    issues.push({
      level: "blocking",
      message: `验收标准只有 ${spec.acceptance.length} 条，至少要 ${SPEC_MIN_ACCEPTANCE} 条 —— 太少的话最后一步没有可验的东西`,
    });
  }

  const mustCount = spec.acceptance.filter((a) => a.level === "must").length;
  if (mustCount < SPEC_MIN_MUST) {
    issues.push({
      level: "blocking",
      message: `必需级验收标准只有 ${mustCount} 条，至少要 ${SPEC_MIN_MUST} 条 —— 全是「期望」的话，验收就没有底线`,
    });
  }

  // 逐条看验收标准本身能不能用
  for (const a of spec.acceptance) {
    if (!a.verifyBy) {
      issues.push({
        level: "blocking",
        message: `验收标准「${a.statement}」没有写怎么验证`,
      });
    }
    if (isVagueStatement(a.statement)) {
      issues.push({
        level: "advisory",
        message: `验收标准「${a.statement}」说得很含糊，验收时会产生分歧`,
      });
    }
  }

  if (spec.scope.outOfScope.length === 0) {
    issues.push({
      level: "advisory",
      message: "没有写明不做什么 —— 范围没有边界，后面容易无限扩张",
    });
  }

  return issues;
}

/**
 * 判断一条验收标准是不是「说了等于没说」。
 *
 * 这类词的问题不是不准确，而是**无法判定真假**：
 * 两个人看「界面美观」会得出两个结论，验收就变成了扯皮。
 */
const VAGUE_WORDS = [
  "美观",
  "好看",
  "漂亮",
  "友好",
  "流畅",
  "高性能",
  "用户体验好",
  "合理",
  "完善",
  "良好",
];

export function isVagueStatement(statement: string): boolean {
  return VAGUE_WORDS.some((w) => statement.includes(w));
}

/* ============================================================
   门禁
   ============================================================ */

export interface SpecGate {
  /** 能不能进入下一道工序 */
  pass: boolean;
  /** 拦下来的原因（blocking 的） */
  blocking: SpecIssue[];
  /** 提醒但不拦的 */
  advisory: SpecIssue[];
  /**
   * 需要用户回答的问题。
   * 有未回答的问题时**不能往下走** —— 这正是「人工门禁」的含义：
   * 全流程唯一需要人的地方。
   */
  pendingQuestions: string[];
  /** 给界面用的一句话结论 */
  summary: string;
}

export function reviewSpec(spec: AppSpec): SpecGate {
  const all = validateSpec(spec);
  const blocking = all.filter((i) => i.level === "blocking");
  const advisory = all.filter((i) => i.level === "advisory");
  const pendingQuestions = spec.questions;

  const pass = blocking.length === 0 && pendingQuestions.length === 0;

  let summary: string;
  if (blocking.length > 0) {
    summary = `规格还不能用：${blocking[0].message}`;
  } else if (pendingQuestions.length > 0) {
    summary = `需要你确认 ${pendingQuestions.length} 个问题后才能继续`;
  } else if (advisory.length > 0) {
    summary = `可以继续，但有 ${advisory.length} 处建议再看一眼`;
  } else {
    summary = "规格齐全，可以进入架构定型";
  }

  return { pass, blocking, advisory, pendingQuestions, summary };
}

/* ============================================================
   降级：模型没能给出可用规格时
   ------------------------------------------------------------
   与其让整条流水线失败，不如给出一份**诚实标注过的兜底规格**：
   验收标准只保留能自动判定的那几条，并明确写出「这份是兜底」。
   用户在界面上看得到差别，就不会把兜底当成真规格。
   ============================================================ */

export const FALLBACK_MARK = "（兜底规格：未能从模型获得结构化规格）";

export function fallbackSpec(meta: {
  prompt: string;
  model: string;
  generatedAt: number;
}): AppSpec {
  return {
    prompt: meta.prompt,
    goal: meta.prompt,
    audience: "未说明",
    scenarios: ["按用户原话实现"],
    acceptance: [
      {
        id: "ac-1",
        statement: "产物是一个可以直接打开的单文件页面",
        verifyBy: "下载产物并在浏览器打开，页面能正常渲染",
        level: "must",
      },
      {
        id: "ac-2",
        statement: "页面完全自包含，不依赖外部资源",
        verifyBy: "断网后重新打开，页面表现不变",
        level: "must",
      },
      {
        id: "ac-3",
        statement: "页面有可交互的控件",
        verifyBy: "点击页面上的按钮，有可见响应",
        level: "should",
      },
      {
        id: "ac-4",
        statement: "刷新后数据不丢",
        verifyBy: "操作后刷新页面，之前的状态仍在",
        level: "should",
      },
    ],
    scope: { inScope: ["按用户原话实现"], outOfScope: [] },
    questions: [],
    model: meta.model,
    generatedAt: meta.generatedAt,
  };
}

/** 兜底规格在界面上要显著区别于真规格 */
export function isFallbackSpec(spec: AppSpec): boolean {
  return spec.audience === "未说明" && spec.scope.inScope.length === 1;
}

/** 规格摘要，供界面与日志使用 */
export function summarizeSpec(spec: AppSpec): string {
  const must = spec.acceptance.filter((a) => a.level === "must").length;
  return `${spec.acceptance.length} 条验收标准（其中 ${must} 条必需）· ${spec.scenarios.length} 个场景 · ${spec.scope.outOfScope.length} 条不做`;
}