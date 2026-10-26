/**
 * Nexus 六阶段流水线定义
 * ============================================================
 * 这是整个系统的「流程骨架」——确定性、纯代码、零 token。
 *
 * 三条设计判断（源自项目立项规划）：
 *   1. 流程由代码推进，不由 agent 决定。阶段顺序写在这里，不写进提示词。
 *   2. 每个阶段必须产出「结构化、可机器校验」的产物，否则层间信息必然丢失。
 *   3. 骨架线性，但每个阶段都声明失败可以退回到哪里，因此不是瀑布模型。
 *
 * 本文件位于 core/ 层：纯数据与纯类型，不依赖任何 IO。
 */

import {
  explainAuthority,
  requiredApproval,
  type AccessMode,
  type ActionScope,
  type ActorKind,
} from "./authority";

export type StageId =
  | "spec" // ① 规格化
  | "arch" // ② 架构定型
  | "ui" // ③ 界面设计
  | "build" // ④ 并行构建
  | "assemble" // ⑤ 集成装配
  | "verify"; // ⑥ 验收与交付

/**
 * 一个字符串是不是六道工序的 id。
 *
 * ── 为什么需要它，而不是到处 `as StageId` ──
 *   工序 id 从库里/从投影里出来的时候类型是 `string`（TaskPoint.id 就是 string）。
 *   而画布那边要的是 `StageId` 这个联合类型。中间的这段路只有两种走法：
 *     ① `as StageId` —— 一句谎话。写错的那天编译器一声不吭，
 *        表现是"聚焦到一个不存在的工序"，而视口只是没动，不报错；
 *     ② 真的判一次 —— 判定依据就是 STAGES 本身，
 *        于是以后加/改工序时这里自动跟着走，不会漂。
 *   选②。这也是 core 层该干的事：它拥有 StageId 的定义，就该负责回答
 *   "这个字符串算不算数"。
 *
 * ⚠️ 用 hasOwnProperty 而不是 `in`：`in` 会顺着原型链把 "constructor"
 *    这类键也认成合法工序 id（from-run.ts 里判 phase 时踩过同一个坑）。
 */
export function isStageId(value: string): value is StageId {
  return Object.prototype.hasOwnProperty.call(STAGE_MAP, value);
}

export type StageStatus =
  | "pending" // 未开始
  | "running" // 执行中
  | "passed" // 已通过机器验收
  | "failed" // 失败，等待归因与处置
  | "blocked" // 卡住，需要人
  | "skipped"; // 被判定为不需要（微小改动时的自动降级）

/** 失败归因四分类 —— 四类，四种完全不同的处置动作 */
export type FaultClass =
  | "environment" // 环境错：依赖缺失、端口占用、权限不足
  | "code" // 代码错：语法 / 类型 / 逻辑错误
  | "model" // 模型错：改错文件、幻觉接口、同一错修两次仍在
  | "spec"; // 规格错：需求矛盾或不可实现

/**
 * 阶段的实现状态
 * ------------------------------------------------------------
 * 这个字段存在的唯一理由：**不要在界面上把「规划中」显示成「已通过」**。
 *
 * 六阶段流水线是完整形态，但实现是逐步推进的。如果界面上无条件地把
 * 当前阶段之前的工序都标成「已通过」，就会造成一种很糟的情况 ——
 * 评委问「规格化阶段的产物给我看看」，而我们根本拿不出来。
 * 写着「已通过」但交不出产物，比直接写「未接入」严重得多。
 *
 *   wired   —— 真正按契约实现并有产物
 *   direct  —— 直通模式下的简化实现（做了这件事，但没走完整的契约链路）
 *   planned —— 还没接，界面上如实标注
 */
export type StageImplementation = "wired" | "direct" | "planned";

/**
 * 一个"数"。这一阶段的判断依据是什么。
 *
 * 参考图上每个角色底下都有一行小字：「流量 · 订单 · 上架」。
 * 那一行不是装饰 —— 它回答的是**"你凭什么做判断"**。
 * 一个不看数的角色等于一个凭感觉拍脑袋的人。
 *
 * 工序也一样：说不清自己看什么数的工序，多半只是"走个过场"。
 */
export interface StageMetric {
  label: string;
  /** 补充说明。可以没有 */
  hint?: string;
}

export interface StageDef {
  id: StageId;
  order: number;
  name: string;
  /** 这一阶段存在的唯一理由 —— 说不出来就该砍掉 */
  rationale: string;
  /** 本阶段必须产出的结构化产物（阶段契约） */
  artifact: string;
  /** 机器可判的验收标准：本阶段能不能自己判定「做完了」 */
  acceptance: string[];
  /** 失败时可退回的阶段（回退回路，使它不是瀑布） */
  fallbackTo: StageId[];

  /* ============================================================
     下面四个字段来自「研发团队运转图」那套纪律
     ============================================================
     它们本来是一个独立能力的产物 —— 一张画着"谁做、能改什么、
     谁点头、看什么数"的图。
     后来发现那是在**并排造第二套"工作怎么发生"的描述**：
     用户看完两张图还得自己猜什么关系。
     所以那张图整个删了，只把这四个维度留下，长到工序上。
     规则在 core/pipeline/authority.ts。
     ============================================================ */

  /** 谁在做这一阶段 */
  actor: ActorKind;
  /** 能不能改东西。见 authority.ts 里关于读写的说明 */
  access: AccessMode;
  /**
   * 碰什么。**不填就按保守的推**（见 resolveScope）：
   * 涉及写的按"对外"处理，于是需要人点头。
   */
  scope?: ActionScope;
  /** 这一阶段的判断依据 */
  watches: StageMetric[];

  /**
   * 强制设一道人工门禁 —— 在"算出来的权限"之上再加一道。
   *
   * ── 为什么需要一个"加码"的字段，而不是直接改 access/scope ──
   *   规格化这一阶段按规则算出来是"不用人批"（AI 写自己这边的产物）。
   *   但我们**故意**让它停下来问 —— 因为规格错了，后面五道全白做。
   *
   *   所以这里的语义是：**规则给出下限，这个字段可以抬高它。**
   *   反过来不行 —— 它不能用来把"必须人批"降成"不用批"。
   *   减少权限要走 access/scope，那两处改了会同时影响告警和界面徽章；
   *   一个只想加一道门的人不会顺手把权限也放开。
   */
  humanGate?: boolean;

  /** 当前实现到什么程度。见上面 StageImplementation 的说明 */
  implementation: StageImplementation;
}

export const STAGES: readonly StageDef[] = [
  {
    id: "spec",
    order: 1,
    name: "规格化",
    rationale:
      "验收标准必须从这里产生。没有它，整条流水线没有判定依据，最终验收无从谈起。",
    artifact: "spec.json",
    acceptance: [
      "每条功能条目都附带一句可判定的验收标准",
      "每条验收标准都能明确回答「做到没有」，不含主观描述",
      "排除项非空 —— 必须明确写出「不做什么」",
      "每条结论都带有用户原话依据，无依据的条目自动转为提问",
    ],
    fallbackTo: [],
    humanGate: true, // 全流程唯一需要人的地方

    /*
      ---------- 权限 ----------
      规格化是 AI 在写自己的产物（spec.json），按规则算出来
      "不用人批" —— 它改的是自己这边的东西。
      但上面 humanGate 故意加了一道门：**规格错了，后面五道全白做。**
      这正是"规则给下限、字段可抬高"那个设计的用处。
    */
    actor: "ai",
    access: "write",
    scope: "internal",
    /*
      看什么数：**用户的原话**。
      它不是从别处算出来的 —— 这一阶段的全部依据就是那句话本身。
      所以 acceptance 里那条「每条结论都带有用户原话依据」
      不是形式要求，而是这一阶段的定义。
    */
    watches: [{ label: "用户原话" }, { label: "含糊词", hint: "需要追问的" }],
    /*
      改为 wired：执行与门禁都接上了。

      执行：调用模型、解析、产出 spec.json。
      门禁：规格里出现「需要用户确认的问题」时**真的会停下**——
            置为 paused、结束事件流、界面上把疑问做成可填写的表单，
            答完落成 answers.json，再点生成才继续。

      这两条合起来才是这一阶段的完整形态，所以标 wired。
      之前标 direct 是因为门禁那段是空的 —— 会停但没有地方回答，
      那等于把人拦在门口又不给开门。
    */
    implementation: "wired",
  },
  {
    id: "arch",
    order: 2,
    name: "架构定型",
    rationale:
      "全流程技术含量最高的决策点：模块怎么切，直接决定下一阶段的并行度与返工率。",
    artifact: "arch.json",
    acceptance: [
      "规格里每条功能都能映射到至少一个模块（无孤儿需求）",
      "依赖清单里的包真实存在",
      "模块依赖图无环",
    ],
    fallbackTo: ["spec"],
    actor: "ai",
    access: "write",
    scope: "internal",
    // 看什么数：上一阶段的产物。数不出来就说明规格没写清
    watches: [{ label: "规格条目" }, { label: "依赖可用性" }],
    implementation: "planned",
  },
  {
    id: "ui",
    order: 3,
    name: "界面设计",
    rationale:
      "设计变量是并行开发时视觉一致性的唯一保障。没有它，N 个执行 Agent 会做出 N 种风格。",
    artifact: "ui-spec.json",
    acceptance: [
      "每条功能都有对应的页面或入口",
      "组件树引用的设计变量全部已定义（无悬空引用）",
      "页面用到的数据都能在接口契约里找到",
    ],
    fallbackTo: ["arch", "spec"],
    actor: "ai",
    access: "write",
    scope: "internal",
    watches: [{ label: "功能条目" }, { label: "设计变量引用" }],
    implementation: "planned",
  },
  {
    id: "build",
    order: 4,
    name: "并行构建",
    rationale:
      "并行的粒度是「模块」而不是「文件」。文件级并行会产生大量合并冲突，收益为负。",
    artifact: "modules/*.json",
    acceptance: [
      "每个模块的模块级自测通过",
      "编译通过",
      "导出的接口与架构契约一致",
    ],
    fallbackTo: ["arch", "ui"],
    actor: "ai",
    access: "write",
    scope: "internal",
    watches: [{ label: "编译错误" }, { label: "模块自测" }],
    // 直通模式下确实在生成代码，但没有经过①②③的契约输入
    implementation: "direct",
  },
  {
    id: "assemble",
    order: 5,
    name: "集成装配",
    rationale:
      "第一次看到完整的东西，也是上下文最重的一刻 —— 必须做上下文裁剪。",
    artifact: "manifest.json",
    acceptance: ["能启动", "端口可访问", "冒烟脚本能走通主流程"],
    fallbackTo: ["build", "arch"],
    actor: "ai",
    access: "write",
    scope: "internal",
    watches: [{ label: "启动" }, { label: "端口" }, { label: "冒烟" }],
    implementation: "planned",
  },
  {
    id: "verify",
    order: 6,
    name: "验收与交付",
    rationale:
      "把第①阶段产出的验收标准翻译成可执行断言。这一步是整条流水线闭环的证明。",
    artifact: "verdict.json",
    acceptance: [
      "覆盖率达标",
      "关键路径全绿",
      "裁决表里没有「无法判定」项",
      "敏感信息扫描通过（API 密钥不得出现在交付物中）",
    ],
    fallbackTo: ["assemble", "build", "ui", "arch", "spec"],

    /*
      ---------- 权限：这一道是**只读**的 ----------
      六道工序里只有它不写东西 —— 它只判断，不生产。

      这不是随便标的，是一条要守住的规矩：

        **判定者不参与生产。**

      验收如果也能改代码，"没过就顺手修一下"会变得极其自然，
      而它一旦开始修，就不再是独立检查了 ——
      自己修完自己判过，和"说做完就算完"没有区别，
      而后者正是这一阶段存在的理由（rationale）。

      所以 access 是 read，scope 是 observe：
      按规则算出来它**不需要人批**（只看不改，弄不坏东西），
      但那不是"没人管"，是"它本来就没有能造成后果的手"。

      有一条单测钉着这件事 —— 谁哪天把 access 改成 write，它会红。
    */
    actor: "ai",
    access: "read",
    scope: "observe",
    watches: [
      { label: "验收标准通过率" },
      { label: "无法判定项", hint: "必须为 0" },
      { label: "敏感信息扫描" },
    ],

    // 七项自检在跑，但断言不是从①的验收标准翻译来的 —— 是通用规则
    implementation: "direct",
  },
] as const;

/** 界面用的实现状态标签 */
export const IMPLEMENTATION_LABEL: Record<StageImplementation, string> = {
  wired: "已接入",
  direct: "直通",
  planned: "未接入",
};

/* ============================================================
   权限
   ============================================================ */

/**
 * 一道工序最终要不要人点头。
 *
 * **规则给下限，humanGate 可以抬高它。**
 * 反过来不行 —— 那个字段不能用来把"必须人批"降成"不用批"。
 * 减少权限要走 access/scope，那两处改了会同时影响告警和界面徽章；
 * 而一个只想加一道门的人，不会顺手把权限也放开。
 *
 * 这条"只能抬高不能降低"的性质有单测钉着（见 stages-authority.test.ts）。
 */
export function stageApproval(stage: StageDef): "none" | "human" {
  if (requiredApproval(stage) === "human") return "human";
  return stage.humanGate ? "human" : "none";
}

/** 一道工序的人类可读权限说明 */
export function stageAuthorityNote(stage: StageDef): string {
  const base = explainAuthority(stage);
  if (stageApproval(stage) === "human" && requiredApproval(stage) === "none") {
    // 规则说不用批，是 humanGate 加上去的 —— 得说清楚为什么
    return `${base}；但这一步**故意**加了一道人工门禁：它的产物决定后面每一道怎么做`;
  }
  return base;
}

export const STAGE_MAP: Record<StageId, StageDef> = Object.fromEntries(
  STAGES.map((s) => [s.id, s]),
) as Record<StageId, StageDef>;

/** 阶段顺序索引，供状态机做前后比较 */
export const STAGE_ORDER: Record<StageId, number> = Object.fromEntries(
  STAGES.map((s) => [s.id, s.order]),
) as Record<StageId, number>;

/** 中文标签（界面用） */
export const FAULT_LABEL: Record<FaultClass, string> = {
  environment: "环境错",
  code: "代码错",
  model: "模型错",
  spec: "规格错",
};

/** 四类失败对应的处置动作 —— 这就是「归因分流」的全部含义 */
export const FAULT_ACTION: Record<FaultClass, string> = {
  environment: "不调用模型，直接修环境后重跑本节点",
  code: "只给出错文件与报错，最小上下文定位修复",
  model: "升级模型档位，并重写任务描述",
  spec: "停止自动执行，转人工确认",
};