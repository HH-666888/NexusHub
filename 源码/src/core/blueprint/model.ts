/**
 * 研发团队运转图 —— 聚合模型
 * ============================================================
 * 把三块东西拼成一次生成要交付的完整产物：
 *   org          组织结构（谁是谁）
 *   loop         闭环（每天怎么转）
 *   walkthrough  走通的例子（拿一个具体活儿把整圈跑一遍）
 *
 * ── walkthrough 为什么也在这里，而不是等到渲染那一步再说 ──
 *   因为它是**校验要管的东西**：一个例子如果漏了某一步，
 *   那张图就会缺一块，而缺的那一块从画面上看不出来 ——
 *   只能靠"每一步都有对应内容"这条规则挡住。
 *   类型定义在校验之前，校验才写得出来。
 */

import type { OrgTree } from "./org";
import type { Loop } from "./loop";

/**
 * 拿一个具体活儿把整圈走一遍。
 *
 * 参考图上的「例子二 上新品，完整走一圈」就是它：
 * 同一个圈，每步填入具体内容。左图讲"这套流程长什么样"，
 * 这一块讲"它跑起来是什么样" —— 少了它，前面两张图都是抽象的。
 */
export interface Walkthrough {
  /** 标题。「上新品，完整走一圈」 */
  title: string;
  /** 副标题。「同一个圈，这次走上新这条路」 */
  hint?: string;
  /**
   * 每一步在这个例子里具体是什么。
   * stepId 必须对得上 loop.steps 里的某一步 —— 由校验保证。
   */
  beats: WalkthroughBeat[];
  /**
   * 这一步之后留下的东西（底部那条流程链）。
   * 参考图上写的是「建议 → CEO 汇总 → 店主批了 → CEO 派活 → 草稿
   * → 问过才上架 → CEO 验收 ✓ → 一周后」。
   * 它不是步骤名，是**这一步做完之后手上多了什么**。
   */
  artifacts?: Array<{ name: string; hint?: string }>;
}

export interface WalkthroughBeat {
  stepId: string;
  /** 那一步在这个例子里具体做什么。一句话 */
  content: string;
  /**
   * 走完这一步的里程碑。参考图上那些小标签：
   * 「柑橘卖得最好」「两款上架了」「一周后的数据，回到起点」。
   * 可以没有 —— 不是每一步都留下一个值得单独说的节点。
   */
  milestone?: string;
}

/** 一次生成交付的完整产物 */
export interface Blueprint {
  org: OrgTree;
  loop: Loop;
  /**
   * 可以没有。
   * 阶段 1 先只做渲染时不会有它；生成阶段接上之后才有。
   * 但只要有，就必须是完整的（每一步都有对应内容）。
   */
  walkthrough?: Walkthrough;
}

/** 产物文件名。和 spec.json 并列放在同一次运行的产物目录里 */
export const BLUEPRINT_ARTIFACT_NAME = "blueprint.json";