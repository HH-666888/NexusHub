/**
 * 从真实运行事件投影出规划日志
 * ============================================================
 * 这个文件是两套模型之间的**单向翻译层**：
 *
 *     真实运行事件（GenerateEvent / run-event）  ──投影──▶  规划事件（PlanningEvent）
 *
 * ── 为什么非要这一层 ──
 *   两套事件流长得像（都带 seq），回答的却是两个不同的问题：
 *     · 运行事件回答「机器刚才做了什么」—— 吐了几个字、花了多少钱、哪七项检查过了。
 *       它是**过程**：token 级，一次运行几万条，落库是为了回放。
 *     · 规划事件回答「这件事的计划走到哪一步了」—— 有几个任务点、谁干完了。
 *       它是**计划**：任务点级，一次运行几十条，投影出来是为了画树和左侧清单。
 *   把运行事件直接挂到画布上，画布会浮出一堆「正文片段」这种根本不是任务点的东西；
 *   把规划日志拿去回放，也放不出「模型当时写了什么」。
 *   所以这里做一次显式的、可单测的翻译，而不是让某一层去猜另一层的意思。
 *
 * ── 到点生成：bornAtSeq 取真实事件的 seq ──
 *   执行任务点不是提前排好的，是**到点才生成**的：
 *   第 30 个事件（一次 check）到达之前，七个检查项在树里**根本不存在** ——
 *   不是「存在但隐藏」。这条性质在数据结构里就成立（见 task-point.ts 开头那段），
 *   这里只负责把真实事件的 seq 如实填进 bornAtSeq。
 *   一个事实只有一个来源：点的出生时刻由**带来它的那条真实事件**给出，
 *   不另算一个序号（理由同 planning-log.ts 的 appendBorn）。
 *
 * ── 诚实底线（这个文件最要紧的一条）──
 *   没有真实事件的工序，必须停在 pending。
 *
 *   界面上写着「已通过」却拿不出产物，比直接写「未接入」严重得多 ——
 *   评委问一句「架构定型的产物给我看看」就会当场穿帮。
 *   所以这里绝不做「run 都结束了，那六道肯定都跑完了吧」这种推断：
 *   一道工序只有在**留下过真实痕迹**（有归属于它的 phase，或有它名下的执行点）时，
 *   才配拥有 running / done / failed；否则一律 pending，无论 run 是什么状态。
 *
 *   这条规则不是这里独有的，它和 core/pipeline/progress.ts 里那行
 *   `if (s.implementation === "planned") return [s.id, "pending"];`
 *   是同一条，连防的错误都一样：
 *     progress.ts 防「按当前阶段往前推，把没跑过的工序推成已通过」；
 *     这里防「run 结束了就顺手把六道全标完成」。
 *
 * ── 边界 ──
 *   纯函数、零 IO：不 import store / adapter / react，不读数据库、不写文件。
 *   输入是一次运行的事件数组，输出是一段能交给 projectAt 的日志。
 *   因此它能被单测在毫秒级跑完，也不需要造任何假 store。
 */

import type { GeneratePhase } from "../generate/service";
import { appendBorn, appendStatus, type PlanningEvent } from "./planning-log";
import type { TaskPoint } from "./task-point";

/**
 * 一级 Agent 的节点 id。
 *
 * 抽成常量导出而不是在各处写字符串字面量：界面要靠它认出「这棵树只有一个根」，
 * 测试要靠它断言根节点确实生成了。写歪一个字符的后果是画布上多出第二个根，
 * 而那种错不会抛异常，只会让布局莫名其妙。
 */
export const PLANNING_ROOT_ID = "agent-root";

/** 根节点的标题。规则里写死了这四个字 */
const PLANNING_ROOT_TITLE = "一级 Agent";

/* ============================================================
   输入
   ============================================================ */

export interface PlanningSource {
  /** 六道工序，顺序即一级任务点顺序。用项目现成的 StageId / STAGES */
  stages: readonly { id: string; name: string }[];
  /** 真实运行事件（按 seq 升序） */
  events: readonly { seq: number; kind: string; payload: unknown }[];
  /** 可选：这次运行的整体状态 */
  runStatus?: "running" | "done" | "failed";
}

/* ============================================================
   phase → 工序
   ------------------------------------------------------------
   下面这张表里**每一条都是从代码里读出来的**，没有一条是猜的。
   归属的依据写在每条注释里（文件名 + 行号），
   因为「这个 phase 到底算哪道工序」是这一层唯一真正需要判断的事，
   判断依据必须能被下一个人复核 —— 复核不了的话，
   改天有人把 saving 挪到别的工序，谁也说不出对不对。
   ============================================================ */

/** 一条 phase 事件归属于哪道工序；或者它根本不属于任何工序，只是一个终局标记 */
type PhaseOwner =
  | { kind: "stage"; stageId: string }
  | { kind: "terminal"; end: "done" | "failed" };

/**
 * 完整的 Record，不是 Partial。
 *
 * 和 task-point.ts 里 STATUS_TONE 的写法同一个理由：
 * GeneratePhase 将来多一个值时，**编译器会在这里报错**，
 * 逼着人当场决定它属于哪道工序、还是它只是个终局标记。
 * 写成 Partial<Record<...>> 的话，新 phase 会被静默跳过 ——
 * 于是「有一道工序在跑，画布上却一片白」这种错只能靠肉眼发现。
 */
const PHASE_OWNER: Record<GeneratePhase, PhaseOwner> = {
  /*
    spec 是规格化工序自己的 phase：
      · spec-stage.ts:43   `| { kind: "phase"; phase: "spec"; label: string }`
        —— SpecStageEvent 的类型定义，phase 取值被钉死成 "spec"；
      · spec-stage.ts:112  `yield { kind: "phase", phase: "spec", label: "正在把你的需求整理成规格" };`
      · spec-stage.ts:181  `stage: "spec"` —— 这一阶段的记账也记在 spec 名下。
    三处同指一道工序，归属没有歧义。
  */
  spec: { kind: "stage", stageId: "spec" },

  /*
    arch 是架构定型自己的 phase：
      · arch-stage.ts  `| { kind: "phase"; phase: "arch"; label: string }`
        —— ArchStageEvent 的类型定义，phase 取值被钉死成 "arch"；
      · arch-stage.ts  `yield { kind: "phase", phase: "arch", label: "正在把规格切分成模块" };`
      · arch-stage.ts  `stage: "arch"` —— 这一阶段的记账也记在 arch 名下。
    三处同指第二道工序，归属没有歧义。
  */
  arch: { kind: "stage", stageId: "arch" },

  /*
    ui 是界面设计自己的 phase：
      · ui-stage.ts    `| { kind: "phase"; phase: "ui"; label: string }`
        —— UiStageEvent 的类型定义，phase 取值被钉死成 "ui"；
      · ui-stage.ts    `yield { kind: "phase", phase: "ui", label: "正在把架构变成页面与设计变量" };`
      · ui-stage.ts    `stage: "ui"` —— 这一阶段的记账也记在 ui 名下。
    三处同指第三道工序，归属没有歧义。
  */
  ui: { kind: "stage", stageId: "ui" },

  /*
    awaiting 是规格化的**人工门禁**，不是新的一道工序：
      · route.ts:286  `const policy = resolveGatePolicy("spec", env.run.specGate);`
        —— 问的是 spec 这道工序要不要人点头；
      · route.ts:288-293  `if (decision.pause && policy.active) { ... yield { kind: "phase", phase: "awaiting", ... }; return; }`
        紧接着就结束这条流，等用户回答规格里的疑问。
      · stages.ts:145  `humanGate: true, // 全流程唯一需要人的地方`
    所以它算在 spec 头上：停下来等的正是规格化。

    一处有意的留白：TaskPointStatus 里其实有更贴切的 `waiting`（卡在等人），
    但这一期的规则是「有 phase → running」，这里不自行加码。
    真要改，应该连着 runStatus 一起改（现在它没有 paused 这个取值），
    否则一道工序显示「在等人」而整条运行显示「在跑」，两处对不上。
  */
  awaiting: { kind: "stage", stageId: "spec" },

  /*
    generating 是并行构建在写代码：
      · service.ts:154  `await runs.update(input.runId, { stage: "build", status: "running" });`
        —— 紧接着的 155-159 行就 yield 了 `phase: "generating"`，
        这两行是紧挨着的：先把自己登记成 build，再喊「正在生成」；
      · service.ts:219  `stage: "build"` —— 生成这次调用的花费记在 build 名下；
      · route.ts:315  `// ---------- 第四道：并行构建（当前是直通模式） ----------`
        然后才 `yield* generateApp(...)`。
  */
  generating: { kind: "stage", stageId: "build" },

  /*
    checking 是验收与交付在做七项自检：
      · service.ts:255  `yield { kind: "phase", phase: "checking", label: "正在检查产物" };`
        紧接着 256-259 行就是 inspectArtifact → `yield { kind: "check", results, summary }`，
        也就是说这条 phase 报的正是那七项检查这件事本身；
      · 而七项检查属于 verify 是项目已经定死的：
        forest.ts:138-139  `id: \`verify:${r.name}\`, stage: "verify" as StageId,`
      · stages.ts:295-296 verify 的 implementation 说明写着
        「七项自检在跑，但断言不是从①的验收标准翻译来的 —— 是通用规则」。
    检查项挂在 verify 下面，宣布这件事的 phase 自然也归 verify。
  */
  checking: { kind: "stage", stageId: "verify" },

  /*
    saving 是保存**并行构建的产物**，仍算 build —— 这一条和「checking 归 verify」
    不一样，值得把判断依据摊开说：
      · service.ts:262  落盘的是 `${runId}/index.html`，那是生成出来的那个页面，
        也就是 build 这道工序的产物（stages.ts:234-235 说 build 在直通模式下
        「确实在生成代码，但没有经过①②③的契约输入」）；
      · 落盘期间 run 的阶段**一直是 build**：service.ts:154 登记成 build 之后，
        直到 287 行才更新（`stage: ok ? "verify" : "build"`）；
      · 落盘失败时 service.ts:274 只改 status 不改 stage：
        `await runs.update(input.runId, { status: "failed" });`
        —— 也就是说「保存失败」在系统自己的记录里就是**一次 build 的失败**。
    按 run 自己的记录走，投影出来的失败工序才和 run.stage 对得上；
    把 saving 划给 verify 的话，一次「产物写盘失败」会被显示成验收环节出了问题。
  */
  saving: { kind: "stage", stageId: "build" },

  /*
    done / failed 是**整条运行的终局标记**，不属于任何一道工序：
      · service.ts:291-297  `phase: ok ? "done" : "failed"` —— 说的是这次运行，
        而不是某道工序；
      · route.ts:140-146    已经有成品时也发 `phase: "done"`，那时一个工序都没跑。
    它们仍然要进这张表：进了表，就要显式回答「这算谁的」，
    而答案「谁也不算，它只是终局」必须写下来 —— 不然下一个人会以为漏配了。
  */
  done: { kind: "terminal", end: "done" },
  failed: { kind: "terminal", end: "failed" },
};

/** 工序 id 字面量。用常量是为了和 phase 表里的取值保持一个来源 */
const SPEC_STAGE_ID = "spec";
const ARCH_STAGE_ID = "arch";
const UI_STAGE_ID = "ui";
const VERIFY_STAGE_ID = "verify";

/**
 * 产出类事件归属于哪道工序。
 *
 * 这些事件不宣布「正在做什么」，而是直接交出一个产物；产物是谁的，
 * 这道工序此刻就还在动 —— 所以它们要能把之前的一次失败**重新盖回 running**。
 * 为什么需要这个：这个代码库里 kind:"error" 大量用于**可降级**的场合，
 * 见下面 FAILURE 那段。
 */
const PRODUCT_STAGE: Record<string, string> = {
  spec: SPEC_STAGE_ID,
  arch: ARCH_STAGE_ID,
  ui: UI_STAGE_ID,
  check: VERIFY_STAGE_ID,
};

/* ============================================================
   载荷收窄
   ------------------------------------------------------------
   事件是从数据库那行 JSON 还原出来的（run-event.ts:42 parseRunEvent），
   所以到了这一层 payload 就是 unknown：它可能是任何东西，包括残缺的。
   下面三个函数只做收窄，不做「尽力而为」的猜测 ——
   猜错会一路错到画布上，而且不会有任何东西变红。
   ============================================================ */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * 判断一个字符串是不是 GeneratePhase 里的取值。
 *
 * 用 PHASE_OWNER 的**自有键**来判定，而不是另抄一份 phase 名单：
 * 抄一份就多一个会和 GeneratePhase 漂开的地方，而漂开的后果是新 phase 被静默忽略。
 *
 * 用 hasOwnProperty 而不是 `in`：`in` 会顺着原型链把 "constructor" 这类键也认成合法取值，
 * 于是一条脏数据会被当成一条真的 phase 事件。
 */
function isGeneratePhase(value: string): value is GeneratePhase {
  return Object.prototype.hasOwnProperty.call(PHASE_OWNER, value);
}

/* ============================================================
   执行任务点的派生
   ============================================================ */

/**
 * 七项检查 → 七个执行任务点。
 *
 * id 用 `verify:${名字}`：这不是这里新发明的约定，
 * forest.ts:138 早就在用同一个写法（`id: \`verify:${r.name}\``），
 * 那边的理由是「用下标做 id 的话，检查项顺序一变，React 会把通过那个方块
 * 复用到失败那一项上」。两条路径共用一个 id 约定，画布和清单才对得上同一张卡。
 *
 * 状态是**出生时就定下的**：检查结果是 check 事件一起带来的，
 * 一项检查没有「先出生、再慢慢跑完」的过程 —— 它出生那一刻就已经过了或没过。
 */
function checkPoints(payload: Record<string, unknown> | null, seq: number): TaskPoint[] {
  const results = payload?.results;
  if (!Array.isArray(results)) return [];

  const points: TaskPoint[] = [];
  for (const raw of results) {
    const result = asRecord(raw);
    const name = asString(result?.name);
    // 没有名字就没有稳定 id。宁可不要这个点，也不要拿下标凑一个 ——
    // 凑出来的 id 会在下一次顺序变化时指向另一项检查
    if (!name) continue;

    points.push({
      id: `verify:${name}`,
      parentId: VERIFY_STAGE_ID,
      depth: 2,
      kind: "exec",
      title: name,
      /*
        缺 pass 字段时按「没通过」处理。
        保守的方向是**不能反的**：把一项没过的检查显示成通过了，
        用户会拿着一个残缺的产物去交差；反过来显示成没过，最多是他多看一眼。
      */
      status: result?.pass ? "done" : "failed",
      bornAtSeq: seq,
    });
  }
  return points;
}

/**
 * 规格产物 → 功能条目点。
 *
 * ⚠️ 字段名是**读出来的**，不是猜的 —— AppSpec（core/domain/spec.ts:50-69）里
 *   根本没有任何叫 features 的字段。它带的数组只有两个：
 *     · scenarios: string[]                 （spec.ts:58）纯字符串，没有标识；
 *     · acceptance: AcceptanceCriterion[]   （spec.ts:59）每项带
 *         id        —— spec.ts:31「稳定标识，供后续阶段与验收报告引用」
 *         statement —— spec.ts:33「用一句可判断真假的话说清楚做到什么算做到」
 *   能同时给出「条目标识」和「条目名」的只有 acceptance，所以功能条目数组就是它。
 *   换成 scenarios 的话 id 只能退化成本次运行内的下标，而下标做 id 的后果
 *   forest.ts:133-137 已经写清楚了（顺序一变，卡片就串位）。
 *
 * 状态给 pending，不是 done：
 *   这条验收标准此刻只是**被写下来了**，它要等到第六道工序才被逐条判定。
 *   TaskPointStatus.pending 的定义正是「计划里有它，但还没轮到」（task-point.ts:35）——
 *   它在规格落地的那一瞬出生，随后一直等着验收来判它。
 *   出生就写 done 的话，画布上会出现一片蓝色的「验收标准已通过」，
 *   而那时候一次验收都还没跑过。
 */
function specPoints(payload: Record<string, unknown> | null, seq: number): TaskPoint[] {
  const spec = asRecord(payload?.spec);
  const acceptance = spec?.acceptance;
  if (!Array.isArray(acceptance)) return [];

  const points: TaskPoint[] = [];
  for (const raw of acceptance) {
    const item = asRecord(raw);
    const id = asString(item?.id);
    if (!id) continue;

    points.push({
      id: `spec:${id}`,
      parentId: SPEC_STAGE_ID,
      depth: 2,
      kind: "exec",
      // 标题取 statement：那是这条标准里唯一一句人话，id 是给机器引用的
      title: asString(item?.statement),
      status: "pending",
      bornAtSeq: seq,
    });
  }
  return points;
}

/**
 * ★ 架构产物 → 模块任务点（左侧清单的二级子树就是从这儿长出来的）★
 *
 * ── 为什么一个模块配得上一个任务点 ──
 *   `stages.ts:241-243` 写着并行构建的粒度：「并行的粒度是「模块」而不是「文件」。
 *   文件级并行会产生大量合并冲突，收益为负。」
 *   也就是说**模块就是第四道工序要并行去做的那些活儿** ——
 *   它们不是"架构里的一个名词"，而是将来真会被派给执行 Agent 的任务单元。
 *   所以它们该进树、该有自己的点：清单里「架构定型」下面列出几个模块，
 *   回答的正是"接下来会并行做几件事"。
 *
 *   ⚠️ 顺带守住了那条诚实底线：**没有 arch 事件的运行，这里一个点都长不出来。**
 *      清单上「架构定型」那一道下面是「待规划」占位行 —— 不是"模块待定"，
 *      而是"这道工序这次根本没跑过"。
 *
 * ── 状态口径（★ 这里是本期最需要写清楚的一个判断）★ ──
 *   模块自己**没有"执行"过** —— 真正去实现它的是第四道并行构建，
 *   而那时候还没有发生。所以：
 *     · **不给 running**：那会显示成"正在做"，而这一刻没有任何人在做它。
 *       这是最容易顺手写错的一档（"架构阶段在跑，那它的子点也在跑吧"），
 *       而它撒谎的方向最坏：用户会坐着等一件没人开始的事。
 *     · 三条本地检查**全过** → `done`：
 *       我们确实知道的事情是"这个模块被架构定型接受了"——
 *       它覆盖了规格里的功能、依赖合法、依赖图无环。
 *     · **有不过的** → `failed`：
 *       一个没过检查的架构产出的模块，不该显示成"已就绪"。
 *       保守的方向不能反 —— 显示成没过，用户最多多看一眼；
 *       显示成过了，他会拿着一个没验证过的模块划分往下走。
 *
 *   这两档都是**出生时就定下的**（理由同 checkPoints）：检查结果是
 *   跟着 arch 事件一起来的，模块没有"先出生、再慢慢被判定"的过程。
 *
 * ── 读不到检查结果时为什么按 failed ──
 *   事件是从数据库那行 JSON 还原出来的，payload 残缺是可能的。
 *   读不出"三条都过了"就说"过了"，等于替一个来路不明的产物背书。
 *   宁可让清单红着 —— 那一抹红恰好会把人的注意力引到该看的地方。
 */
function archPoints(payload: Record<string, unknown> | null, seq: number): TaskPoint[] {
  const arch = asRecord(payload?.arch);
  const modules = arch?.modules;
  if (!Array.isArray(modules)) return [];

  const allPassed = didAllChecksPass(payload);

  const points: TaskPoint[] = [];
  for (const raw of modules) {
    /*
      ⚠️ 变量叫 item 不叫 module：`module` 是 Node 的保留标识符，
         eslint（@next/next/no-assign-module-variable）会直接报错 ——
         而报错的原因和这一段的逻辑毫无关系，改个名字比加一行 disable 干净。
    */
    const item = asRecord(raw);
    /*
      id 是稳定标识，也是这个点的身份（`arch:<模块id>`）。
      没有它就凑不出一个不会漂的 id —— 拿下标凑的话，
      模块顺序一变，清单里那一行指向的就是另一个模块了
      （和 checkPoints 里"宁可不要这个点"是同一条理由）。
    */
    const id = asString(item?.id);
    if (!id) continue;

    points.push({
      id: `arch:${id}`,
      parentId: ARCH_STAGE_ID,
      depth: 2,
      kind: "exec",
      // 标题取模块名：那是这个模块里唯一一句人话，id 是给机器引用的
      title: asString(item?.name) || id,
      status: allPassed ? "done" : "failed",
      bornAtSeq: seq,
    });
  }
  return points;
}

/**
 * 产出事件里那三条本地检查是不是全过了（arch 与 ui 两道共用这一个判据）。
 *
 * 逐项读 `pass === true`，而不是读汇总的 `passed === total`：
 * 汇总数字是**算出来的**，逐项才是原始事实；两者万一不一致
 * （比如有人手写了一条夹具），以逐项为准更接近"到底发生了什么"。
 *
 * 缺 results、results 为空、pass 字段缺失，一律算**没过** ——
 * 理由见 archPoints 里那段：读不出来就说"过了"，是在替产物背书。
 */
function didAllChecksPass(payload: Record<string, unknown> | null): boolean {
  const results = asRecord(payload?.check)?.results;
  if (!Array.isArray(results) || results.length === 0) return false;
  return results.every((r) => asRecord(r)?.pass === true);
}

/**
 * ★ 界面设计产物 → 页面任务点（左侧清单的又一层二级子树从这儿长出来）★
 *
 * ── 为什么一个页面配得上一个任务点 ──
 *   理由与模块**逐字相同**（见 archPoints）：页面不是"设计稿里的一个名词"，
 *   它是第三道交给第四道的活儿 —— 一个页面就是一块要做的界面。
 *   清单里「界面设计」下面列出几个页面，回答的是"这次要做几个界面"。
 *
 *   ⚠️ 顺带守住了那条诚实底线：**没有 ui 事件的运行，这里一个点都长不出来。**
 *      清单上「界面设计」那一道下面是「待规划」占位行 —— 不是"页面待定"，
 *      而是"这道工序这次根本没跑过"。
 *
 * ── 状态口径（★ 与模块同一档，理由也同一档）★ ──
 *   页面自己**没有"执行"过** —— 真正去把它做出来的是第四道并行构建，
 *   而那时候还没有发生。所以：
 *     · **不给 running**：那会显示成"正在做"，而这一刻没有任何人在做它。
 *       这是最容易顺手写错的一档（"界面设计阶段在跑，那它的页面也在跑吧"），
 *       而它撒谎的方向最坏：用户会坐着等一件没人开始的事。
 *     · 三条本地检查**全过** → `done`：
 *       我们确实知道的事情是"这个页面被界面设计接受了"——
 *       它有功能归属、它引用的变量全都定义过、它要的数据指得到模块。
 *     · **有不过的** → `failed`：
 *       一份没过检查的界面设计产出的页面，不该显示成"已就绪"。
 *       保守的方向不能反 —— 显示成没过，用户最多多看一眼；
 *       显示成过了，他会拿着一个没验证过的页面划分往下走。
 *
 *   这两档都是**出生时就定下的**（理由同 checkPoints / archPoints）：
 *   检查结果是跟着 ui 事件一起来的，页面没有"先出生、再慢慢被判定"的过程。
 */
function uiPoints(payload: Record<string, unknown> | null, seq: number): TaskPoint[] {
  const ui = asRecord(payload?.ui);
  const pages = ui?.pages;
  if (!Array.isArray(pages)) return [];

  const allPassed = didAllChecksPass(payload);

  const points: TaskPoint[] = [];
  for (const raw of pages) {
    const page = asRecord(raw);
    /*
      id 是稳定标识，也是这个点的身份（`ui:<页面id>`）。
      没有它就凑不出一个不会漂的 id —— 拿下标凑的话，
      页面顺序一变，清单里那一行指向的就是另一个页面了
      （和 checkPoints / archPoints 里"宁可不要这个点"是同一条理由）。
    */
    const id = asString(page?.id);
    if (!id) continue;

    points.push({
      id: `ui:${id}`,
      parentId: UI_STAGE_ID,
      depth: 2,
      kind: "exec",
      // 标题取页面名：那是这个页面里唯一一句人话，id 是给机器引用的
      title: asString(page?.name) || id,
      status: allPassed ? "done" : "failed",
      bornAtSeq: seq,
    });
  }
  return points;
}

/* ============================================================
   投影
   ============================================================ */

/**
 * 把真实运行事件投影成规划日志。
 * ⚠️ 只认真实存在的事件 —— 没有事件的工序必须停在 pending，绝不许编造。
 */
export function planningFromRun(src: PlanningSource): PlanningEvent[] {
  const stageIds = new Set(src.stages.map((s) => s.id));

  /* ---------- ① 骨架：一级 Agent + 六道工序，一次全生成在 seq 0 ---------- */
  /*
    骨架是「计划」，不是「产出」：不管这次运行跑到哪，六道工序和它们的顺序
    都是确定的（stages.ts 里写死的那六道）。所以它们不像执行点那样到点生成，
    而是在 seq 0 一次性全建出来 —— 用户在还没开始跑的时候就该看见整条流水线。
    hasOrphans 也正是靠这一点成立：根和六道工序都在场，后面长出来的点才有爹可认。
  */
  let log: PlanningEvent[] = [];

  log = appendBorn(log, {
    id: PLANNING_ROOT_ID,
    parentId: null,
    depth: 0,
    kind: "control",
    title: PLANNING_ROOT_TITLE,
    // 先按 pending 出生，真正的状态在末尾由这次运行的状态补上（见 ③）
    status: "pending",
    bornAtSeq: 0,
  });

  for (const stage of src.stages) {
    log = appendBorn(log, {
      id: stage.id,
      parentId: PLANNING_ROOT_ID,
      depth: 1,
      kind: "control",
      title: stage.name,
      // 出生时一律 pending：此刻还没有任何一条事件能证明这道工序动过
      status: "pending",
      bornAtSeq: 0,
    });
  }

  /* ---------- ② 到点生成：按 seq 走一遍真实事件 ---------- */

  /*
    先按 seq 升序排一遍。
    调用方本来就该按 seq 升序传（RunEvent.seq 是「同一次运行内的序号，从 0 开始且连续」，
    见 run-event.ts:30），但这一层不打算依赖它：
    乱序的输入如果被照单全收，「谁先动的手」就会算错，
    而算错的后果是失败被记到另一道工序头上 —— 这种错不会抛异常。
    Array.sort 从 ES2019 起保证稳定，所以同 seq 的事件仍然保持传进来的先后。
  */
  const ordered = [...src.events].sort((a, b) => a.seq - b.seq);

  /**
   * 工序最后一次「还在动 / 交了产物」的处理序号。
   * 用遍历下标而不是 seq 做比较键：同 seq 上的先后只有下标分得开，
   * 而「先失败还是先恢复」恰恰是同 seq 时才最容易算错。
   */
  const lastAliveAt = new Map<string, number>();
  /**
   * 工序最后一次「失败信号」的处理序号。
   *
   * 为什么要记序号而不是直接定生死：这个代码库里 kind:"error" 大量用于
   * **可降级**的场合 ——
   *   · spec-stage.ts:227  规格解析失败 → 降级成兜底规格，然后**照样产出** spec；
   *   · spec-stage.ts:232  输出被截断 → 只提醒，继续往下走；
   *   · spec-stage.ts:250  规格写盘失败 → 注释里写明「写盘失败不降级」；
   *   · service.ts:247     生成输出被截断 → 只提醒。
   * 这些 error 之后流水线继续跑并成功产出。见到 error 就一锤定音判失败，
   * 会把「降级后照样跑通」误报成失败 —— 那是**另一种撒谎**，
   * 而这个文件存在的全部理由就是不撒这种谎。
   * 所以失败是可以被后面的真实痕迹盖掉的：一道工序后来又动了、又交了产物，
   * 就说明它没有停在失败上。
   */
  const lastFailAt = new Map<string, number>();

  /** 最后一个有归属的工序 —— 也就是「当前工序」，失败要算在它头上 */
  let currentStage: string | null = null;
  /** 事件流里出现过的终局标记（调用方没传 runStatus 时靠它判断运行结束） */
  let sawTerminal: "done" | "failed" | null = null;
  /** 所有事件里最大的 seq。终局状态写在这一点上，它就是「现在」 */
  let lastSeq = 0;

  const markAlive = (stageId: string, at: number): void => {
    lastAliveAt.set(stageId, at);
  };

  ordered.forEach((event, cursor) => {
    if (event.seq > lastSeq) lastSeq = event.seq;
    const payload = asRecord(event.payload);

    /* ---- phase：唯一能确定「工序在动」的证据 ---- */
    if (event.kind === "phase") {
      const phase = asString(payload?.phase);
      if (!isGeneratePhase(phase)) return; // 认不出的 phase：跳过，不猜

      const owner = PHASE_OWNER[phase];
      if (owner.kind === "terminal") {
        sawTerminal = owner.end;
        if (owner.end === "failed" && currentStage) {
          // 「当前工序失败了」—— 规则里的 phase:"failed" 分支。
          // 记在 currentStage 上，而不是某一固定工序：说实话的前提是知道是谁失败了
          lastFailAt.set(currentStage, cursor);
          if (stageIds.has(currentStage)) {
            log = appendStatus(log, currentStage, "failed", event.seq);
          }
        }
        return;
      }

      // 有归属的 phase：这道工序此刻在动。当前工序随之移动
      currentStage = owner.stageId;
      markAlive(owner.stageId, cursor);
      if (stageIds.has(owner.stageId)) {
        log = appendStatus(log, owner.stageId, "running", event.seq);
      }
      return;
    }

    /* ---- error：失败信号，但可以被后面的事件盖掉（理由见 lastFailAt） ---- */
    if (event.kind === "error") {
      if (currentStage) {
        lastFailAt.set(currentStage, cursor);
        if (stageIds.has(currentStage)) {
          log = appendStatus(log, currentStage, "failed", event.seq);
        }
      }
      return;
    }

    /* ---- 产出类：到点生成执行任务点，同时证明这道工序还在动 ---- */
    const ownerStage = PRODUCT_STAGE[event.kind];
    if (!ownerStage) return; // text / reasoning / usage / artifact …：交给画布，不进计划

    markAlive(ownerStage, cursor);
    currentStage = ownerStage;
    if (stageIds.has(ownerStage)) {
      log = appendStatus(log, ownerStage, "running", event.seq);
    }

    /*
      产出归属的工序如果不在这次传入的工序表里，就**不生成**这些点。
      直接生成的话，它们的 parentId 会指向一个不在场的节点 —— 也就是孤儿。
      而孤儿正是 hasOrphans 要喊出来的那件事（布局会把它们摆到原点或者干脆丢掉，
      两种表现都不抛错）。宁可少一张卡，也不要一棵接不上的子树。
    */
    if (!stageIds.has(ownerStage)) return;

    /*
      产出 → 它名下的执行点。四种产出各有一套派生规则：
        · check → 七个检查项（verify 名下）
        · arch  → 每个模块一个点（arch 名下）  —— 清单的二级子树从这儿长出来
        · ui    → 每个页面一个点（ui 名下）    —— 清单再多一层二级子树
        · spec  → 每条验收标准一个点（spec 名下）
      规则分开写而不是合并成一个"万能函数"：四者的字段名、id 约定、
      状态口径都不一样（pending / done|failed / done|failed / done|failed，
      而且 arch 读的是 modules、ui 读的是 pages），
      硬凑成一个只会让每条规则都变得难读、也难改。
    */
    const born =
      event.kind === "check"
        ? checkPoints(payload, event.seq)
        : event.kind === "arch"
          ? archPoints(payload, event.seq)
          : event.kind === "ui"
            ? uiPoints(payload, event.seq)
            : specPoints(payload, event.seq);
    for (const point of born) {
      log = appendBorn(log, point);
    }

    /*
      artifact 事件**刻意不造任务点**（规则里写明的那条）。
      产物是**结果**，不是任务点：它没有「还没做 / 正在做 / 做完了」这个过程，
      它出现的那一刻就已经在那儿了。给产物建任务点会让清单里多出一串
      「index.html」这种不是活儿的东西，而用户要看的活儿是上面那些检查项。
      它的意义由所属工序的状态承担（落盘成功说明那道工序还在动）。
    */
  });

  /* ---------- ③ 终局：run 结束了才谈得上「完成」 ---------- */

  /*
    这次运行到底是什么状态，三个来源按可信度排：
      ① 调用方显式传的 runStatus —— 它是对整条运行的直接声明，最可信；
      ② 事件流里的终局 phase（done / failed）——
         从库里读出来的历史事件往往就停在这一条上（service.ts:291 收尾时发它），
         而那时候调用方不一定还知道 runStatus，所以必须自己认；
      ③ 都没有 —— 那就是还在跑。
    ①②矛盾时（比如 runStatus 说 done，流里却躺着一条 phase:"failed"）：
    运行状态听①（调用方说了算），但**那道工序的失败照样保留**——
    具体事件是事实，汇总状态是摘要，事实不该被摘要抹掉。
  */
  const runState: "running" | "done" | "failed" =
    src.runStatus ?? sawTerminal ?? "running";

  /**
   * 某道工序最终的失败序号；没失败过就是 undefined。
   *
   * 第二条分支对应规则里的「runStatus 为 failed 时，当前工序置 failed」：
   * 调用方说这次运行失败了，但事件流里没留下具体的失败信号
   * （历史事件可能只存了阶段，没存 error）。这时候把失败算在「当前工序」头上，
   * 其余工序照旧 —— 不知道是谁失败的时候，只说知道的那部分。
   */
  const failureAt = (stageId: string): number | undefined => {
    const explicit = lastFailAt.get(stageId);
    if (explicit !== undefined) return explicit;
    if (runState === "failed" && stageId === currentStage) {
      return Number.MAX_SAFE_INTEGER; // 排在所有真实痕迹之后：这就是终局
    }
    return undefined;
  };

  for (const stage of src.stages) {
    const alive = lastAliveAt.get(stage.id);

    /*
      ★ 诚实底线 ★
      没有任何归属于它的真实痕迹（既没有 phase，也没有它名下的执行点）
      → 保持 pending，什么都不写。

      注意这里**不看 runState**：这正是「没有产出的工序始终 pending，
      无论 run 什么状态」那一条。一道没接入的工序在 run 成功结束时
      最容易被顺手标成 done —— 而它其实一行代码都没跑过。
      这段代码是这条底线唯一的实现，改动它之前请先看文件头那段。
    */
    if (alive === undefined) continue;

    const failAt = failureAt(stage.id);
    if (failAt !== undefined && failAt >= alive) {
      // 最后一次痕迹就是失败（或者说，之后再没有恢复的痕迹）
      log = appendStatus(log, stage.id, "failed", lastSeq);
      continue;
    }

    if (runState === "done" || runState === "failed") {
      /*
        运行已经结束，而这道工序确实动过（有 phase 或名下的执行点）
        → 它做完了。这里给的是 done，不是「因为运行成功所以全绿」：
        上面已经把所有没有痕迹的工序挡在门外了。
      */
      log = appendStatus(log, stage.id, "done", lastSeq);
    }
    // runState 是 running：阶段状态就停在前面写的 running 上，不再动它
  }

  /*
    根节点的状态 = 这次运行的状态。
    一级 Agent 代表的就是整条运行本身，它不替任何一道工序表态；
    而六道工序各自的状态上面已经按证据算过了。
    它出生时是 pending，这里在 lastSeq 上写下最终状态 ——
    同一个 seq 上后追加的赢（见 projectAt 的规则），所以这一条总能落到最后。
  */
  log = appendStatus(
    log,
    PLANNING_ROOT_ID,
    runState === "done" ? "done" : runState === "failed" ? "failed" : "running",
    lastSeq,
  );

  return log;
}