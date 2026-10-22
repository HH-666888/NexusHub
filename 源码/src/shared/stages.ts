/**
 * Nexus 六阶段流水线定义
 * ============================================================
 * 这是整个系统的「流程骨架」——确定性、纯代码、零 token。
 *
 * 设计原则（对应项目立项规划里的三条判断）：
 *   1. 流程由代码推进，不由 agent 决定。阶段之间的先后关系写在这里，不写进提示词。
 *   2. 每个阶段必须产出一个「结构化、可机器校验」的产物，否则层间信息必然丢失。
 *   3. 骨架线性，但每个阶段都声明「失败可以退回到哪里」，因此不是瀑布模型。
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
  | "failed" // 失败（等待归因与处置）
  | "blocked" // 卡住，需要人
  | "skipped"; // 被判定为不需要（例如微小改动时的降级）

/** 失败归因的四分类——四类，四种完全不同的处置动作 */
export type FaultClass =
  | "environment" // 环境错：依赖缺失、端口占用、权限不足 → 不进模型，直接修环境
  | "code" // 代码错：语法/类型/逻辑错误 → 最小上下文定位修复
  | "model" // 模型错：改错文件、幻觉接口、同错两次 → 升级档位 + 重写任务描述
  | "spec"; // 规格错：需求矛盾或不可实现 → 停下，转人工

export interface StageDef {
  id: StageId;
  order: number;
  name: string;
  /** 这一阶段存在的唯一理由——如果说不出来，就该砍掉 */
  rationale: string;
  /** 本阶段必须产出的结构化产物（阶段契约） */
  artifact: string;
  /** 机器可判的验收标准：本阶段能不能自己判定「做完了」 */
  acceptance: string[];
  /** 失败时可以退回到哪些阶段（回退回路，使它不是瀑布） */
  fallbackTo: StageId[];
  /** 是否设人工门禁 */
  humanGate?: boolean;
}

export const STAGES: StageDef[] = [
  {
    id: "spec",
    order: 1,
    name: "规格化",
    rationale:
      "验收标准必须从这里产生。没有它，整条流水线没有判定依据，最终验收无从谈起。",
    artifact: "spec.json",
    acceptance: [
      "每条功能条目都附带一句可判定的验收标准",
      "没有「待定」「都可以」这类不可判定的措辞",
      "排除项非空——必须明确写出「不做什么」",
      "每条结论都带有用户原话依据，无依据的条目自动转为提问",
    ],
    fallbackTo: [],
    humanGate: true, // 全流程唯一需要人的地方
  },
  {
    id: "arch",
    order: 2,
    name: "架构定型",
    rationale:
      "全流程技术含量最高的决策点：模块怎么切，直接决定下一阶段的并行度和返工率。",
    artifact: "arch.json",
    acceptance: [
      "规格里每条功能都能映射到至少一个模块（无孤儿需求）",
      "依赖清单里的包真实存在",
      "模块依赖图无环",
    ],
    fallbackTo: ["spec"],
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
  },
  {
    id: "assemble",
    order: 5,
    name: "集成装配",
    rationale:
      "第一次看到完整的东西，也是上下文最重的一刻——必须做上下文裁剪。",
    artifact: "manifest.json",
    acceptance: [
      "能启动",
      "端口可访问",
      "冒烟脚本能走通主流程",
    ],
    fallbackTo: ["build", "arch"],
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
  },
];

export const STAGE_MAP: Record<StageId, StageDef> = Object.fromEntries(
  STAGES.map((s) => [s.id, s]),
) as Record<StageId, StageDef>;

/** 中文标签：给界面用 */
export const FAULT_LABEL: Record<FaultClass, string> = {
  environment: "环境错",
  code: "代码错",
  model: "模型错",
  spec: "规格错",
};

/** 四类失败对应的处置动作——这就是「归因分流」的全部含义 */
export const FAULT_ACTION: Record<FaultClass, string> = {
  environment: "不调用模型，直接修环境后重跑本节点",
  code: "只给出错文件与报错，最小上下文定位修复",
  model: "升级模型档位，并重写任务描述",
  spec: "停止自动执行，转人工确认",
};