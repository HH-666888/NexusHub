/**
 * 六阶段流水线定义：纯数据与纯类型，流程由代码推进，不由 agent 决定。
 * 每阶段声明结构化产物、可机器校验的验收标准，以及失败可退回哪里。
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
 * 判定字符串是否为工序 id。不用 `as StageId`：写错时编译器不吭声，只表现成聚焦失效。
 * 用 hasOwnProperty 而非 in，后者会把原型链上的键也认成合法 id。
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

/** 失败归因四分类，对应四种不同的处置动作 */
export type FaultClass =
  | "environment" // 环境错：依赖缺失、端口占用、权限不足
  | "code" // 代码错：语法 / 类型 / 逻辑错误
  | "model" // 模型错：改错文件、幻觉接口、同一错修两次仍在
  | "spec"; // 规格错：需求矛盾或不可实现

/**
 * 实现状态。存在只为不把「规划中」显示成「已通过」：
 * wired 按契约实现且有产物，direct 是简化实现，planned 未接入。
 */
export type StageImplementation = "wired" | "direct" | "planned";

/** 一个「数」：这一阶段的判断依据是什么 */
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

  // 以下四个字段是权限维度，规则在 core/pipeline/authority.ts

  /** 谁在做这一阶段 */
  actor: ActorKind;
  /** 能不能改东西。见 authority.ts 里关于读写的说明 */
  access: AccessMode;
  /** 碰什么；不填按保守推（见 resolveScope），涉写的按对外处理 */
  scope?: ActionScope;
  /** 这一阶段的判断依据 */
  watches: StageMetric[];

  /**
   * 强制加一道人工门禁。语义是规则给出下限、此字段可抬高，反过来不行。
   * 降权限要走 access/scope，那两处改了会同时影响告警与界面徽章。
   */
  humanGate?: boolean;

  /** 当前实现到什么程度。见上面 StageImplementation 的说明 */
  implementation: StageImplementation;

  /** 为什么还没接入；仅对 planned 工序有意义 */
  blockedBy?: string;
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

    // 规格化改的是自己的产物，按规则不需人批；但规格错了后面五道全白做，故加门
    actor: "ai",
    access: "write",
    scope: "internal",
    // 看什么数：用户的原话。这一阶段的全部依据就是那句话本身
    watches: [{ label: "用户原话" }, { label: "含糊词", hint: "需要追问的" }],
    // wired：执行（调模型、解析、落 spec.json）与门禁都接上了，
    // 门禁会真的停下等人回答，答完落 answers.json 再续跑。
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
    /*
      wired：执行与三条本地检查都接上了，结果随 arch 事件发出。
      第二条只做包名语法检查，不联网核实，检查名里已写明这个边界。
    */
    implementation: "wired",
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
    /*
      wired：执行与三条本地检查都接上了。变量表必须在并行开工前定下来，
      否则几个模块会各写各的配色（route.ts 第三道那一段）。
      第三条只按模块 id/名称做字面匹配，检查名里已写明未核实接口契约。
    */
    implementation: "wired",
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
    /*
      标 planned 的原因：这三条验收要真把应用跑起来 —— 起进程、占端口、拿脚本点它。
      当前产物是单文件 HTML，没有服务可启动，也没有沙箱能跑别人的应用。
    */
    blockedBy: `需要沙箱与多文件产物：当前的产物是单文件 HTML，没有服务器也没有端口，
所以「能启动 / 端口可访问 / 冒烟脚本能走通主流程」这三条无法如实检查`,
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
      只读：判定者不参与生产。验收一旦能改代码，「没过就顺手修一下」会变得自然，
      自己修完自己判过就不再是独立检查。所以 access = read、scope = observe。
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


/**
 * 一道工序最终要不要人点头：规则给下限，humanGate 只能抬高不能降低。
 * 这条性质有单测钉着（stages-authority.test.ts）。
 */
export function stageApproval(stage: StageDef): "none" | "human" {
  if (requiredApproval(stage) === "human") return "human";
  return stage.humanGate ? "human" : "none";
}

/** 一道工序的人类可读权限说明 */
export function stageAuthorityNote(stage: StageDef): string {
  const base = explainAuthority(stage);
  if (stageApproval(stage) === "human" && requiredApproval(stage) === "none") {
    // 规则说不用批，是 humanGate 加的，得说清为什么
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