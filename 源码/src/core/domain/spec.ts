/**
 * 应用规格（spec）：把一句话需求变成可机器校验的验收依据，含提示词、解析、校验与兜底。
 * 没有验收标准，最后一步就只能让模型自评；questions 非空时这道工序不算完成。
 */

export interface AcceptanceCriterion {
  /** 供后续阶段与验收报告引用 */
  id: string;
  /** 一句话说清做到什么算做到，且能判真假 */
  statement: string;
  /** 必须是可执行的动作，不能是看起来对 */
  verifyBy: string;
  /**
   * 分两档是为了让验收能给出通过但有保留，而不是非黑即白。
   */
  level: "must" | "should";
}

/** 明确不做什么 */
export interface SpecScope {
  inScope: string[];
  outOfScope: string[];
}

export interface AppSpec {
  /** 一字不改地留着 */
  prompt: string;
  /** 目标陈述 */
  goal: string;
  audience: string;
  /** 按重要性排序 */
  scenarios: string[];
  acceptance: AcceptanceCriterion[];
  scope: SpecScope;
  /** 非空时这道工序不算完成，见 reviewSpec */
  questions: string[];
  model: string;
  generatedAt: number;
}

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

/** 用户消息 */
export function buildSpecPrompt(userInput: string): string {
  return `用户的一句话需求：\n\n${userInput.trim()}\n\n请产出规格 JSON。`;
}

// 模型输出不可信：可能带围栏、带前后解释、字段类型不对。逐层剥，剥不出来就明确失败

export type SpecParseResult =
  | { ok: true; spec: AppSpec }
  | { ok: false; reason: string; raw: string };

/** 从输出里抠出 JSON 文本 */
export function extractJsonText(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;

  // 先试整体就是 JSON 对象
  if (text.startsWith("{")) {
    const end = text.lastIndexOf("}");
    if (end > 0) return escapeRawControlChars(text.slice(0, end + 1));
    /*
      起了头却没有闭合说明输出被截断。这里不能返回 null：上层会报找不到 JSON，
      而真实情况是 JSON 写坏了，两者的排查方向完全不同。
    */
    return escapeRawControlChars(text);
  }

  // 顶层是数组也抠出来，好让上层报出不是对象
  if (text.startsWith("[")) {
    const end = text.lastIndexOf("]");
    if (end > 0) return escapeRawControlChars(text.slice(0, end + 1));
    return escapeRawControlChars(text);
  }

  // 再试 ```json ... ``` 围栏
  const fenced = /```(?:json)?\s*\n?([\s\S]*?)```/.exec(text);
  if (fenced) {
    const inner = fenced[1].trim();
    if (inner.startsWith("{") || inner.startsWith("[")) return escapeRawControlChars(inner);
  }

  // 最后试第一个 { 到最后一个 }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return escapeRawControlChars(text.slice(start, end + 1));
  }

  // 对象没有，数组也试试
  const arrStart = text.indexOf("[");
  const arrEnd = text.lastIndexOf("]");
  if (arrStart >= 0 && arrEnd > arrStart) {
    return escapeRawControlChars(text.slice(arrStart, arrEnd + 1));
  }

  return null;
}

/**
 * 把 JSON 字符串内部的裸控制字符（U+0000–U+001F）转义掉。
 * 模型常在字符串里直接换行而不是写 \n，那不是合法 JSON，整个模块会被丢弃：
 * 钱花了、产物里少一整块功能，而它本可以救回来。
 * 只动字符串字面量内部：外面的缩进换行是合法 JSON，动了反而把好数据弄坏；
 * 已转义的（\n、\"、\\）原样保留。逐字符判断而不是正则：正则分不清带转义引号的串。
 */
export function escapeRawControlChars(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (!inString) {
      out += ch;
      if (ch === '"') inString = true;
      continue;
    }

    if (escaped) {
      // 已被反斜杠转义，原样放行
      out += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      out += ch;
      escaped = true;
      continue;
    }

    if (ch === '"') {
      out += ch;
      inString = false;
      continue;
    }

    const code = ch.charCodeAt(0);
    if (code < 0x20) {
      // 裸控制字符，转义成 \uXXXX
      out += `\\u${code.toString(16).padStart(4, "0")}`;
      continue;
    }

    out += ch;
  }

  return out;
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
 * 只做结构校验，不做质量判断：验收标准够不够硬由 validateSpec 负责。
 * 分开之后，失败时的报错能精确到是哪一类问题。
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
        // 缺 statement 的条目丢掉：留着只会让验收阶段去校验一条没说清的标准
        .filter((x) => x.statement.length > 0)
    : [];

  const spec: AppSpec = {
    // 原文一字不改：后面各阶段引用需求都以此为准，而不是模型改写过的 goal
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

// 分两档：blocking 拦下不能往下走，advisory 提醒但放行。
// 全拦下来会把用户卡死，但验收标准不过关确实不能往下走：第六道会失去依据。

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
 * 说了等于没说的验收标准。这类词的问题不是不准确，而是无法判定真假：
 * 两个人看界面美观这三个字会得出两个结论，验收就变成了扯皮。
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

export interface SpecGate {
  /** 能不能进入下一道工序 */
  pass: boolean;
  /** 拦下来的原因 */
  blocking: SpecIssue[];
  /** 提醒但不拦 */
  advisory: SpecIssue[];
  /**
   * 有未回答的问题时不能往下走，这是人工门禁的含义：全流程唯一需要人的地方。
   */
  pendingQuestions: string[];
  /** 界面用的一句话结论 */
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

// 兜底：与其让整条流水线失败，不如给一份明确标注过的兜底规格，
// 验收标准只留能自动判定的那几条，用户看得到差别就不会当成真规格。

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

/** 与真规格区分 */
export function isFallbackSpec(spec: AppSpec): boolean {
  return spec.audience === "未说明" && spec.scope.inScope.length === 1;
}

/** 摘要，供界面与日志使用 */
export function summarizeSpec(spec: AppSpec): string {
  const must = spec.acceptance.filter((a) => a.level === "must").length;
  return `${spec.acceptance.length} 条验收标准（其中 ${must} 条必需）· ${spec.scenarios.length} 个场景 · ${spec.scope.outOfScope.length} 条不做`;
}