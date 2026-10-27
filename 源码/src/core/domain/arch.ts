/**
 * 架构规格（arch）：把一份规格切成模块图，含提示词、解析与兜底。
 * 模块 id 会变成任务点 id（画布节点、清单行、URL 的 ?focus=），所以只允许小写字母数字连字符：
 * 允许空格大写斜杠的话三处各自要长一套转义规则，对不上的表现是点一下没反应且不报错。
 */

import { extractJsonText, type AppSpec } from "./spec";

/**
 * 一个模块。字段顺序即重要性：先能被引用（id），再能被人读，最后才是模块间关系。
 */
export interface ArchModule {
  /** 小写字母数字连字符，用于做任务点 id */
  id: string;
  name: string;
  responsibility: string;
  /** 依赖哪些模块（必须是本 arch 里其他模块的 id） */
  dependsOn: string[];
  /** 实现了规格里哪些条目 id（AppSpec.acceptance[].id） */
  coversFeatures: string[];
}

export interface ArchSpec {
  modules: ArchModule[];
  packages: { name: string; why: string }[];
}

/**
 * 第 4 条硬性要求最要紧：拿不准就不要写进 packages。
 * 本项目只校验包名合法性，不联网核实包是否存在（见 generate/arch-check.ts）。
 */
export const ARCH_SYSTEM_PROMPT = `你是一位软件架构师。用户会用一句话描述他想做的软件，
现在需求已经整理成了一份规格（含逐条验收标准）。你的任务是把这份规格切成模块。

只输出一个 JSON 对象，不要有任何解释文字、不要包代码块围栏。

字段要求：
{
  "modules": [
    {
      "id": "小写字母数字连字符，例如 task-store、board-ui。它会变成任务点的 id，必须稳定",
      "name": "人可读的模块名",
      "responsibility": "这个模块负责什么。一句话，具体到能判断边界",
      "dependsOn": ["它依赖的模块 id。必须是本数组里其它模块的 id，不能引用不存在的东西"],
      "coversFeatures": ["它实现了规格里哪些验收标准的 id，例如 ac-1"]
    }
  ],
  "packages": [
    { "name": "npm 包名，例如 dayjs；确实需要才写", "why": "为什么需要它。一句话" }
  ]
}

硬性要求：
1. modules 至少 2 个、至多 6 个。太少了没有可并行的东西，太多了切不动
2. **规格里每一条验收标准（acceptance[].id）都必须出现在某个模块的 coversFeatures 里**。
   有归属不了的条目，说明模块切得不对 —— 那是这一阶段最严重的错
3. dependsOn 只能指向本数组里真实存在的 id，而且**不许出现环**（A→B→A 这种）
4. packages 能空就空。"自包含单文件页面"这类目标通常一个依赖都不需要。
   拿不准就不要写进 packages —— 本项目只会做包名合法性检查，
   **不会联网核实它是否真实存在**，写错的代价由用户承担`;

/** 用户消息：原话 + 规格 */
export function buildArchPrompt(userInput: string, spec: AppSpec): string {
  const acceptance = spec.acceptance
    .map((a) => `  · ${a.id}｜${a.statement}（${a.level === "must" ? "必需" : "期望"}）`)
    .join("\n");

  return [
    "用户的一句话需求：",
    "",
    userInput.trim(),
    "",
    "已经整理好的规格：",
    `  · 目标：${spec.goal || "（未填写）"}`,
    `  · 给谁用：${spec.audience || "（未填写）"}`,
    `  · 使用场景：${spec.scenarios.join("；") || "（未填写）"}`,
    "  · 验收标准（每一条都要有模块承接）：",
    acceptance || "  （规格里没有验收标准）",
    `  · 不做：${spec.scope.outOfScope.join("；") || "（未填写）"}`,
    "",
    "请产出架构 JSON。",
  ].join("\n");
}

// 只做结构校验，不做质量判断；质量判断在 generate/arch-check.ts

export type ArchParseResult =
  | { ok: true; arch: ArchSpec }
  | { ok: false; reason: string; raw: string };

/** 小写字母数字，可含连字符，但不许出现在首尾 */
const MODULE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isValidModuleId(id: string): boolean {
  return MODULE_ID.test(id);
}

/**
 * 归一出合法模块 id。
 * 直接判不合法就丢弃会连带丢掉该模块的 coversFeatures，第一道检查随后变红，
 * 而真正的原因（模型写了个带空格的 id）反而看不见。
 */
export function normalizeModuleId(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
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

export function parseArch(raw: string): ArchParseResult {
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

  const modules: ArchModule[] = [];
  const seenIds = new Set<string>();

  if (Array.isArray(o.modules)) {
    for (const rawModule of o.modules) {
      if (typeof rawModule !== "object" || rawModule === null) continue;
      const m = rawModule as Record<string, unknown>;

      const id = normalizeModuleId(asString(m.id));
      // 归一到空串说明没有可用字符，这个模块进不了树
      if (!id) continue;
      /* 同一个 id 只认第一个：重复的会让画布上出现两个同名节点 */
      if (seenIds.has(id)) continue;
      seenIds.add(id);

      modules.push({
        id,
        // 缺名字退回 id，避免空白标题
        name: asString(m.name) || id,
        responsibility: asString(m.responsibility),
        // dependsOn 用同一套归一，否则 "Task Store" 与 "task-store" 会被当成两个模块
        dependsOn: asStringArray(m.dependsOn)
          .map(normalizeModuleId)
          .filter(Boolean),
        /*
          coversFeatures 不归一：那些 id 是规格定的形状，在这里改等于把
          引用错误改成引用正确，第一道检查就再也发现不了真正的错位。
        */
        coversFeatures: asStringArray(m.coversFeatures),
      });
    }
  }

  /*
    空架构不可用：它下面长不出任务点，第四道无从并行。
    这种时候说解析成功，只会把一个空洞一路带到画布上。
  */
  if (modules.length === 0) {
    return { ok: false, reason: "架构里一个模块都没有（modules 为空或全都不带合法 id）", raw };
  }

  const packages: { name: string; why: string }[] = [];
  if (Array.isArray(o.packages)) {
    for (const rawPkg of o.packages) {
      // 模型偶尔把依赖写成纯字符串：收下，why 留空，否则第二条检查少一个包名
      if (typeof rawPkg === "string") {
        const name = rawPkg.trim();
        if (name) packages.push({ name, why: "" });
        continue;
      }
      if (typeof rawPkg !== "object" || rawPkg === null) continue;
      const p = rawPkg as Record<string, unknown>;
      const name = asString(p.name);
      if (!name) continue;
      packages.push({ name, why: asString(p.why) });
    }
  }

  return { ok: true, arch: { modules, packages } };
}

// 兜底：解析失败不该让整条流水线停下。只给一个模块并承接全部验收标准，
// 让无孤儿需求这条检查照样是绿的，同时如实说明这一版没做切分。

export const ARCH_FALLBACK_MARK = "（兜底架构：未能从模型获得结构化架构）";

export function fallbackArch(meta: {
  spec: AppSpec;
  model: string;
  generatedAt: number;
}): ArchSpec {
  return {
    modules: [
      {
        id: "single-page-app",
        name: `单页应用${ARCH_FALLBACK_MARK}`,
        responsibility:
          "把规格里的全部功能实现在一个自包含页面里。这一版没有做模块切分 —— 兜底架构不冒充架构决策",
        dependsOn: [],
        // 兜底模块确实负责全部，所以每条都挂上：这是实话，不是凑绿检查
        coversFeatures: meta.spec.acceptance.map((a) => a.id),
      },
    ],
    // 包名不是模型给的，就不该由兜底替它编
    packages: [],
  };
}

/** 与真架构区分，做法同 isFallbackSpec */
export function isFallbackArch(arch: ArchSpec): boolean {
  return arch.modules.some((m) => m.name.includes(ARCH_FALLBACK_MARK));
}

/** 摘要，供界面与日志使用 */
export function summarizeArch(arch: ArchSpec): string {
  const deps = arch.modules.reduce((n, m) => n + m.dependsOn.length, 0);
  return `${arch.modules.length} 个模块 · ${deps} 条模块依赖 · ${arch.packages.length} 个第三方包`;
}