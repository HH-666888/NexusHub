/**
 * 架构规格（arch）
 * ============================================================
 * 六道工序的第二道：把**一份规格**变成**一张模块图**。
 *
 * ── 为什么这一阶段必须存在 ──
 *   `stages.ts:202-203` 把它称作「全流程技术含量最高的决策点」，
 *   理由是「模块怎么切，直接决定下一阶段的并行度与返工率」。
 *   规格回答的是「做什么」，架构回答的是「分成几块做、谁依赖谁」——
 *   没有后者，第四道「并行构建」就没有并行单元可切：
 *   它只能把一整句话当成一个任务丢给模型，那就不叫并行构建。
 *
 * ── 为什么输入要带上整份规格，而不是只带那句人话 ──
 *   架构不是凭空设计的，它必须**建立在真规格上** ——
 *   这正是第一道验收标准「规格里每条功能都能映射到至少一个模块」的由来。
 *   所以这一阶段的输入是 prompt + spec 两样，缺一不可：
 *   prompt 用它来理解语气与边界，spec 用它来确保**每条功能条目都有归属**。
 *
 * ── 为什么模块 id 是「小写字母数字连字符」这种死规矩 ──
 *   它会被拿去当任务点 id（`arch:<模块 id>`，见 planning/from-run.ts）——
 *   也就是画布上的节点 id、清单里的行 id、URL 里 `?focus=` 的值。
 *   允许空格、大写、斜杠的话，这三处会各自长出一套转义规则，
 *   而对不上的表现是「点一下没反应」，不报错。
 *   写死一个字符集，比事后统一便宜得多。
 *
 * ── 为什么这一层是纯函数 ──
 *   和 domain/spec.ts 同一条理由：解析与兜底不该依赖网络。
 *   抽出来之后，「模型返回了一坨不是 JSON 的东西」这种事
 *   可以在毫秒级的单测里钉死，不需要任何假 store。
 */

import { extractJsonText, type AppSpec } from "./spec";

/* ============================================================
   类型
   ============================================================ */

/**
 * 一个模块。
 *
 * 字段顺序就是它的重要性顺序：先能**被引用**（id），
 * 再能**被人读**（name / responsibility），最后才是它和别人的关系
 * （dependsOn / coversFeatures）—— 前两个错了后面全错。
 */
export interface ArchModule {
  /** 稳定标识（小写字母数字连字符），用于做任务点 id */
  id: string;
  /** 人可读 */
  name: string;
  /** 负责什么 */
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

/* ============================================================
   提示词
   ============================================================ */

/**
 * ⚠️ 第 4 条硬性要求是这个阶段最要紧的一句话：
 *   「拿不准就不要写进 packages」。
 *   因为本项目**没有联网核实包是否真实存在**（见 generate/arch-check.ts）——
 *   模型每多写一个它没把握的包名，用户就多一分拿到假依赖的风险。
 *   宁可让它把不确定的写成注释性质的话，也不要它编一个像模像样的名字。
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

/** 把用户原话与规格一起包成用户消息 */
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

/* ============================================================
   解析
   ------------------------------------------------------------
   和 parseSpec 同一条原则：只做结构校验，不做质量判断 ——
   「三条检查过不过」是 generate/arch-check.ts 的事。
   两者分开之后，失败时的报错能精确到是哪一类问题。
   ============================================================ */

export type ArchParseResult =
  | { ok: true; arch: ArchSpec }
  | { ok: false; reason: string; raw: string };

/** 模块 id 的合法形状：小写字母数字，可含连字符，但不许出现在首尾 */
const MODULE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isValidModuleId(id: string): boolean {
  return MODULE_ID.test(id);
}

/**
 * 把模型给的东西归一成一个合法模块 id。
 *
 * ── 为什么是归一而不是直接判不合法就丢掉 ──
 *   丢掉的后果比想象中严重：那个模块的 coversFeatures 会一起消失，
 *   于是第一道检查（无孤儿需求）莫名其妙地变红，而用户看到的
 *   是"某条功能没人管"——真正的原因（模型写了个带空格的 id）反而看不见了。
 *   归一之后，id 的错在这里就地被修掉，其余信息一条不丢。
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
      // 归一到空串，说明它连一个可用字符都没有 —— 这个模块进不了树
      if (!id) continue;
      /*
        同一个 id 出现两次：只认第一个。
        id 是"稳定标识"（任务点 id 就靠它），重复的那份要是也放进来，
        画布上会出现两个同名的节点，而"点清单跳到哪个"就说不清了。
      */
      if (seenIds.has(id)) continue;
      seenIds.add(id);

      modules.push({
        id,
        // 名字缺了就退回 id：宁可显示一个机器味的名字，也不要空白标题
        name: asString(m.name) || id,
        responsibility: asString(m.responsibility),
        // dependsOn 里的引用也用同一套归一 —— 否则 "Task Store" 和 "task-store"
        // 会被当成两个东西，第三条检查（无环）就会去追一个不存在的节点
        dependsOn: asStringArray(m.dependsOn)
          .map(normalizeModuleId)
          .filter(Boolean),
        /*
          coversFeatures **不归一**：那些 id 来自规格（AppSpec.acceptance[].id），
          是别人定的形状。在这里改它，等于把"模型写错了引用"这件事
          偷偷改成"引用对了"——第一道检查就再也发现不了真正的错位。
        */
        coversFeatures: asStringArray(m.coversFeatures),
      });
    }
  }

  /*
    一个模块都没有 → 明确失败，交给兜底。
    空架构是**不可用**的：它下面长不出任何任务点，第四道也就无从并行。
    这种时候说"解析成功"只会把一个空洞一路带到画布上。
  */
  if (modules.length === 0) {
    return { ok: false, reason: "架构里一个模块都没有（modules 为空或全都不带合法 id）", raw };
  }

  const packages: { name: string; why: string }[] = [];
  if (Array.isArray(o.packages)) {
    for (const rawPkg of o.packages) {
      // 模型偶尔会把依赖写成纯字符串。收下它，why 留空 ——
      // 丢弃的话，第二条检查就少了一个本来该被检查的包名
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

/* ============================================================
   降级：模型没能给出可用架构时
   ------------------------------------------------------------
   和 spec 的兜底同一个取舍：一次解析失败不该让整条流水线停下来。
   兜底架构**故意只有一个模块**，而且把规格里每一条验收标准都挂在它名下 ——
   这样「无孤儿需求」这条检查照样是绿的：它诚实地描述了"这一版没切分，
   所有功能都落在一个模块里"，而不是假装切好了。
   ============================================================ */

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
        /*
          每一条验收标准都挂上：兜底模块确实"负责全部"，
          所以这是实话，不是为了让检查变绿而凑数。
        */
        coversFeatures: meta.spec.acceptance.map((a) => a.id),
      },
    ],
    // 兜底不带任何第三方依赖：包名不是模型给的，就不该由兜底替它编
    packages: [],
  };
}

/** 兜底架构在界面上要显著区别于真架构 —— 和 isFallbackSpec 同一套做法 */
export function isFallbackArch(arch: ArchSpec): boolean {
  return arch.modules.some((m) => m.name.includes(ARCH_FALLBACK_MARK));
}

/** 架构摘要，供界面与日志使用 */
export function summarizeArch(arch: ArchSpec): string {
  const deps = arch.modules.reduce((n, m) => n + m.dependsOn.length, 0);
  return `${arch.modules.length} 个模块 · ${deps} 条模块依赖 · ${arch.packages.length} 个第三方包`;
}