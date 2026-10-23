/**
 * 研发团队运转图 —— 闭环模型
 * ============================================================
 * 描述的是「这支团队每天转的那一圈」：几步、每步谁做、
 * 做什么、**为什么这么设计**，以及中间那个角色在管什么。
 *
 * ── 和 org.ts 的分工 ──
 *   org.ts   回答「谁是谁」（静态的组织结构，一棵树）
 *   loop.ts  回答「怎么转」（动态的流程，一个圈）
 *   两者互相引用的是**角色的名字**，不是对象 —— 同一个人
 *   在树上和圈上出现时，不必是同一个数据结构。
 *
 * ── 这个文件里最要紧的一个字段：rationale ──
 *   参考图上每一步底下都有一条黄标签的「原理」：
 *     01  AI 看不到的，它判断不了；拿不到就直说，不估
 *     02  只看不碰店铺：看错了，最多写错一句话
 *     03  带着理由，店主才判断得了对错
 *     04  上新、下架、对外回复，只有人能点头
 *     05  只接批过的活；真动店铺前，再问店主一次
 *     06  说做完不算，查过才算；不过就返工
 *     07  圈每转一次，店就多一分有数
 *
 *   那一条**不是装饰**。它回答的是"为什么这么分工"，
 *   而一张只有名字和箭头的流程图，看的人只会问
 *   "凭什么这么设计"。所以它是必填，且由校验强制。
 */

import type { ActorKind, Metric } from "./org";

/**
 * 一个角色对数据的权限。
 *
 * 参考图上的徽章分四档：程序自动收 / AI·只读 / AI·干活 / 人。
 * 把 actor 和 mode 拆成两个字段而不是揉成一个枚举，
 * 是因为它们回答两个不同的问题：
 *   actor  谁在做
 *   mode   能不能改东西
 * 「AI 看数」和「AI 动手」是同一个 actor 的两种模式，
 * 而它们的风险差了一个数量级 —— 02 和 05 的区别全在这里。
 */
export type AccessMode = "read" | "write";

/**
 * 这一步**碰什么**。
 *
 * ── 为什么单独一个字段，不能从 actor/mode 推 ──
 *   「写代码」和「上线发布」都是 ai + write，
 *   但一个改的是自己这边的工作区，一个动的是外面看得见的东西。
 *   风险差着量级，而 actor 和 mode 都表达不了这件事。
 *   参考图上「上新、下架、对外回复，只有人能点头」这句原理，
 *   说的正是这一档 —— 所以它必须能单独写出来。
 *
 * 三档的含义见 authority.ts。
 */
export type ActionScope = "observe" | "internal" | "outward";

export interface LoopStep {
  id: string;
  /** 序号。参考图左上角那个 01 / 02 / …。从 1 开始 */
  order: number;
  /** 名字。「接数据」「看数」「给建议」 */
  name: string;
  actor: ActorKind;
  /** 能不能改东西。程序和人可以不填，AI 必填 */
  mode?: AccessMode;
  /**
   * 碰什么。**可以不填，但缺省是保守推出来的**（见 authority.ts 的 resolveScope）：
   * 涉及写的步骤一律按「对外」处理，于是需要人点头。
   * 宁可多问一次，也不要让一个漏填的字段把线上动作放过去。
   */
  scope?: ActionScope;
  /** 做什么。一句话，越具体越好 */
  duty: string;
  /**
   * 原理 —— **为什么这么设计**。
   * 必填。缺了这一步，整张图就退化成一张普通的流程图。
   */
  rationale: string;
  /** 这一步看什么数。有的步骤不看数（比如"动手"），可以没有 */
  watches?: Metric[];
}

/**
 * 中心那个角色。
 *
 * ── 它为什么不是一个普通的步骤 ──
 *   参考图上，中间那块不属于 01–07 里的任何一步，
 *   但几乎每条线都从它出发或回到它。
 *   它自己不产生数据、不写代码，它做的是**在步骤之间搬东西**：
 *   汇总（多条并一条）、派活（把批过的交出去）、验收（查完才算完）。
 *
 *   把它画成第 8 步是错的 —— 它不是流程里的一站，
 *   它站在流程边上。所以单独建模。
 */
export interface LoopHub {
  id: string;
  /** 角色名。「CEO Agent」「编排 Agent」 */
  role: string;
  /** 一句话说明它在干嘛 */
  note?: string;
  /**
   * 它干的几件事。参考图上是三块小标签：
   *   汇总  几条建议合成一份，每天按点报店主
   *   派活  店主点了头，再交给干活的 AI
   *   验收  干完对着要求查，就是 06 这一站
   */
  duties: Array<{ label: string; detail: string }>;
}

/** 一条转换。from / to 可以是步骤 id，也可以是中心的 id */
export interface LoopTransition {
  from: string;
  to: string;
  /**
   * 线上写的那行小字。
   * 参考图上：「建议先交 CEO」「汇总报店主」「派活」「做完交 CEO」。
   * 这些小字是这套图区别于普通流程图的关键 —— 它们说明**这一跳在干嘛**。
   */
  label: string;
  /** 视觉方向。用来决定线条往上画还是往下画 */
  direction?: "down" | "up" | "across";
}

/** 闭环说明：最后一步怎么回到第一步 */
export interface LoopClosure {
  /** 「一周后的数据，回到起点」 */
  label: string;
  hint?: string;
}

export interface Loop {
  /** 标题。「一家电商店铺的 AI 闭环：7 步转一圈」 */
  title: string;
  /** 副标题。「建议先交 CEO，再到店主」 */
  hint?: string;
  hub: LoopHub;
  /** 按 order 排好的步骤。构造函数负责排序，调用方不用操心 */
  steps: LoopStep[];
  transitions: LoopTransition[];
  /** 有没有闭合。没有的话「闭环」这两个字就不成立 */
  closure?: LoopClosure;
}

/** 中心节点的保留 id。步骤不许用这个 id，由校验挡住 */
export const HUB_ID = "hub";

/* ============================================================
   遍历与查询
   ============================================================ */

/** 按 order 排好。输入乱序也照排 —— 生成出来的东西不该要求顺序正确 */
export function sortSteps(steps: readonly LoopStep[]): LoopStep[] {
  return [...steps].sort((a, b) => a.order - b.order);
}

export function findStep(loop: Loop, id: string): LoopStep | null {
  return loop.steps.find((s) => s.id === id) ?? null;
}

/** 某个角色的转换：从它出发、或回到它 */
export function transitionsOf(loop: Loop, id: string): LoopTransition[] {
  return loop.transitions.filter((t) => t.from === id || t.to === id);
}

/**
 * 这个圈是不是真的闭上了。
 *
 * ── 判据为什么是这两条 ──
 *   一、有 closure 说明（作者明确说了"回到起点"）
 *   二、最后一步（order 最大的那条）确实有一条线回到第一步
 *
 *   只看第一条不够：说明可以随便写，而图上没有那条线。
 *   只看第二条也不够：回到起点的线可能压根没标"这是一圈的结束"。
 *   两条都要，「闭环」才不是一个自封的说法。
 */
export function isClosed(loop: Loop): boolean {
  if (!loop.closure) return false;
  const sorted = sortSteps(loop.steps);
  if (sorted.length < 2) return false;

  const first = sorted[0].id;
  const last = sorted[sorted.length - 1].id;

  /*
    直接连回来，或者经过中心中转回来，都算。
    括号是显式加的：`&&` 比 `||` 优先级高，不写括号虽然结果一样，
    但读的人得在脑子里过一遍优先级才敢确认 —— 这种地方不该让人猜。
  */
  const direct = loop.transitions.some((t) => t.from === last && t.to === first);
  const viaHub =
    loop.transitions.some((t) => t.from === last && t.to === HUB_ID) &&
    loop.transitions.some((t) => t.from === HUB_ID && t.to === first);

  return direct || viaHub;
}

/* ============================================================
   统计
   ============================================================ */

export interface LoopStats {
  /** 步骤数。参考图上是 7 */
  steps: number;
  byActor: Record<ActorKind, number>;
  /** 只读的步骤数。这个数越大，这套流程越安全 */
  readOnly: number;
  /**
   * 需要人点头的步骤数。
   *
   * 参考图上只有一步（04 店主拍板）。
   * 这个数**不是越大越好**：人管得越多，圈转得越慢。
   * 它该刚好覆盖"对外动作"—— 那才是只有人能负责的部分。
   */
  humanGated: number;
  closed: boolean;
}

export function loopStats(loop: Loop): LoopStats {
  const byActor: Record<ActorKind, number> = { human: 0, ai: 0, program: 0 };
  let readOnly = 0;
  let humanGated = 0;

  for (const s of loop.steps) {
    byActor[s.actor]++;
    if (s.mode === "read") readOnly++;
    // 人不一定是"点头"那一步，但在这套模型里，人出现的步骤就是要人负责的步骤
    if (s.actor === "human") humanGated++;
  }

  return {
    steps: loop.steps.length,
    byActor,
    readOnly,
    humanGated,
    closed: isClosed(loop),
  };
}

/**
 * 一步的徽章文字。界面上那一小块：「AI · 只读」「程序自动收」「人」。
 *
 * 放在核心层而不是组件里，是因为**它是规则的表达**：
 * AI 必须说清是读还是写，人不分读写，程序统一叫"自动"。
 * 这条规则不该散在界面代码里。
 */
export function actorBadge(step: Pick<LoopStep, "actor" | "mode">): string {
  if (step.actor === "human") return "人";
  if (step.actor === "program") return "程序自动";
  // AI 一律带上模式。不写模式的话，「看数」和「上架」会显示成同一个徽章，
  // 而这两件事的风险差了一个数量级
  return step.mode === "read" ? "AI · 只读" : "AI · 干活";
}