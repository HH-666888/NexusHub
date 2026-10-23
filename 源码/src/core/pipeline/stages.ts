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

export type StageId =
  | "spec" // ① 规格化
  | "arch" // ② 架构定型
  | "ui" // ③ 界面设计
  | "build" // ④ 并行构建
  | "assemble" // ⑤ 集成装配
  | "verify"; // ⑥ 验收与交付

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
  /** 是否设人工门禁 */
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