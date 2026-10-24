/**
 * 流水线图：把「阶段定义 + 运行状态」变成一张可渲染的图
 * ============================================================
 * 纯函数、零 IO —— 因此可以用单元测试钉死布局与连边规则，
 * 而不必去截图看它对不对。
 *
 * ── 为什么要把布局也算在这里，而不是交给画布组件 ──
 *   节点的位置是**由数据决定的**，不是随手摆的：
 *   第 N 道工序就该在第 N 列。把它写成一个纯函数，
 *   同一份数据永远得到同一张图，也就意味着「图长什么样」这件事可测。
 *
 * ── 图上放什么，有一条硬约束 ──
 *   只放**真实存在**的东西。
 *   没接入的工序照样画出来，但状态如实标成「未接入」且不参与进度推算；
 *   没有产物就不显示产物大小，没有耗时就不显示耗时。
 *   图比列表更容易让人相信「这里真的有东西」，所以更不能画假的。
 */

import {
  STAGES,
  STAGE_MAP,
  stageApproval,
  type StageId,
  type StageMetric,
  type StageStatus,
} from "./stages";
import type { AccessMode, ActorKind, Approver } from "./authority";
import { resolveGatePolicy, type GateOverride } from "./gate-policy";
import { computeStageStatuses } from "./progress";
import type { RunProgressInput } from "./progress";
import { costOf, type CostByStage } from "../domain/stage-cost";

/* ============================================================
   类型
   ============================================================ */

export interface PipelineNode {
  /** 节点 id，直接用阶段 id —— 少一层映射少一处出错 */
  id: StageId;
  order: number;
  name: string;
  /** 本阶段必须产出的结构化产物 */
  artifact: string;
  /** 这一阶段存在的唯一理由，作为节点上的副标题 */
  rationale: string;
  implementation: "wired" | "direct" | "planned";
  status: StageStatus;
  /** 该阶段累计花费（元）。未接入的阶段恒为 0 */
  costCny: number;

  /* ============================================================
     权限四件套
     ============================================================
     这几个字段来自「研发团队运转图」那套纪律 —— 它本来是一个
     独立的能力，有一张自己的图和一套模型。后来发现那是在
     并排造第二套"工作怎么发生"的描述，所以整张图删了，
     只把四个维度留下来，长到工序上，在这里露出来。

     定义在 stages.ts，规则在 authority.ts。
     ============================================================ */

  /** 谁在做这一阶段 */
  actor: ActorKind;
  /** 能不能改东西 */
  access: AccessMode;
  /** 要不要人点头。**是算出来的**（规则给下限，humanGate 可以抬高） */
  approval: Approver;
  /**
   * 门禁**实际会不会停**。
   *
   * 和 approval 的区别正是「声明」与「实际」的区别：
   *   approval === "human" && gateActive === false
   *     → 声明要人点头，但运行时被覆盖成放行了。
   *       这是图上必须标出来的状态（见 BuildGraphInput.gateOverride）。
   */
  gateActive: boolean;
  /** 这一阶段的判断依据 —— 「你凭什么说做完了」 */
  watches: StageMetric[];

  /** 布局坐标 */
  x: number;
  y: number;
}

export interface PipelineEdge {
  id: string;
  source: StageId;
  target: StageId;
  kind: "flow" | "fallback";
  label?: string;
}

export interface PipelineGraph {
  nodes: PipelineNode[];
  edges: PipelineEdge[];
  /** 图的实际尺寸，供「适应窗口」用 */
  width: number;
  height: number;
}

/* ============================================================
   布局常量
   ------------------------------------------------------------
   抽成常量而不是散在代码里：将来要做多布局时，
   它们是「层次布局」这一种的参数，换布局就是换一组参数。
   ============================================================ */

export const LAYOUT = {
  /** 节点尺寸 */
  nodeWidth: 208,
  /**
   * 节点高度。
   *
   * ── 为什么从 96 涨到 136 ──
   *   长了权限那两行（「谁做 + 要不要人点头」和「看什么数」）之后，
   *   96 装不下：头部 16 + 名字 16 + 产物名 12 + 权限 16 + 看什么 14
   *   + 指标 16 + 内边距 20 ≈ 110，还没算行距取整。
   *
   *   布局里写死高度是必须的 —— 边要从节点的边出发，
   *   而"量 DOM"会带来首帧闪动、窗口变化要重算、测试也没法测。
   *   所以内容长了就得把这个常数一起改，不然会溢出。
   */
  nodeHeight: 136,
  /** 横向间距（列距 = nodeWidth + gapX） */
  gapX: 64,
  /**
   * 纵向行距。
   * 节点变高之后这个也要跟着涨 —— 它管的是**回退边从下方绕过去**的空间，
   * 留窄了回退边会和下一行节点的顶边叠在一起。
   */
  gapY: 172,
  /**
   * 每行放几道工序。
   *
   * 一开始是六道排一行 —— 结果是 1632px 宽，而工作台中间那栏只有 830px，
   * 适应窗口之后缩放掉到 0.5，节点上的字根本读不出来。
   * 排成两行三列之后宽度降到 752px，缩放接近 1.0，字是清楚的。
   *
   * 三这个数字不是随便定的：再少一列会让图更高、在面板里上下留白；
   * 再多一列又开始缩得看不清。
   */
  perRow: 3,
} as const;

/** 第 index 道工序在网格里的行列 */
export function gridSlot(index: number): { row: number; col: number } {
  return { row: Math.floor(index / LAYOUT.perRow), col: index % LAYOUT.perRow };
}

/** 第 index 道工序的左上角坐标 */
export function columnPosition(index: number): { x: number; y: number } {
  const { row, col } = gridSlot(index);
  return {
    x: col * (LAYOUT.nodeWidth + LAYOUT.gapX),
    y: row * (LAYOUT.nodeHeight + LAYOUT.gapY),
  };
}

/** 图一共占几行 */
export function rowCount(total: number): number {
  return Math.ceil(total / LAYOUT.perRow);
}

/* ============================================================
   构图
   ============================================================ */

export interface BuildGraphInput {
  /** 选中的运行。null 表示还没选中任何记录 */
  run: RunProgressInput | null;
  /**
   * 各阶段的花费，由 cost_records 按 stage 归集而来。
   *
   * 这里直接收 CostByStage 而不是一个「阶段 → 数字」的映射：
   * 归集结果里还有调用次数、输出 token、计价档位，
   * 只传一个数字的话，节点上就永远只能显示金额，
   * 想加「这一步为什么贵」就得再改一次签名。
   */
  costByStage?: CostByStage;
  /**
   * 人工门禁的运行时覆盖。
   *
   * ── 为什么图要知道这件事 ──
   *   图上写「要人点头」，而运行时不真的停 —— 这是比没有门禁更糟的状态：
   *   用户会以为有人把关过了。
   *
   *   所以覆盖必须**在图上也看得见**，不能只出现在事件流里
   *   （事件流是跑的时候才有的，而图是随时都挂在那儿的）。
   *
   * 不传就是 "declared"（按工序自己的权限模型来），也就是默认没有覆盖。
   */
  gateOverride?: GateOverride;
}

/**
 * 依据阶段定义与运行状态构图。
 *
 * 连边有两个来源，都是**真实数据**：
 *   ① 顺序流转：第 N 道 → 第 N+1 道。骨架本来就是线性的。
 *   ② 失败回退：来自每道工序自己声明的 fallbackTo。
 *      这是别家画不出来的东西 —— 他们的流程里没定义失败退回到哪。
 */
export function buildPipelineGraph(input: BuildGraphInput): PipelineGraph {
  const statuses = computeStageStatuses(input.run);
  const gateOverride: GateOverride = input.gateOverride ?? "declared";
  const costByStage = input.costByStage ?? {};

  const nodes: PipelineNode[] = STAGES.map((s, i) => {
    const pos = columnPosition(i);
    return {
      id: s.id,
      order: s.order,
      name: s.name,
      artifact: s.artifact,
      rationale: s.rationale,
      implementation: s.implementation,
      status: statuses[s.id],
      // 未接入的工序不会有花费。这里再兜一次底：
      // 即使上游传了值也不认，避免界面上出现「未接入但花了钱」这种矛盾
      costCny: s.implementation === "planned" ? 0 : costOf(s.id, costByStage),

      /*
        权限四件套直接取自工序定义。
        approval 是**算出来的**而不是另存一份字段 ——
        存两份的话，改了 access 而忘了改 approval，
        界面上就会出现"标着只读、却要人点头"这种自相矛盾。
      */
      actor: s.actor,
      access: s.access,
      approval: stageApproval(s),
      /*
        门禁实际会不会停。
        不传覆盖就是"按声明来"，那时 gateActive === (approval === "human")。
      */
      gateActive: resolveGatePolicy(s.id, gateOverride).active,
      watches: s.watches,

      x: pos.x,
      y: pos.y,
    };
  });

  const edges: PipelineEdge[] = [];

  // ① 顺序流转
  for (let i = 0; i < STAGES.length - 1; i++) {
    const from = STAGES[i];
    const to = STAGES[i + 1];
    edges.push({
      id: `${from.id}->${to.id}`,
      source: from.id,
      target: to.id,
      kind: "flow",
    });
  }

  // ② 失败回退：从每道工序声明的 fallbackTo 展开。
  // 回退边可能跨越好几道工序（比如验收能一路退回规格化），
  // 全画出来会让图糊成一团 —— 所以只连**最近的一跳**，
  // 也就是 fallbackTo 列表里的第一个。完整列表在节点详情里看。
  for (const s of STAGES) {
    const nearest = s.fallbackTo[0];
    if (!nearest) continue;
    edges.push({
      id: `${s.id}=>${nearest}`,
      source: s.id,
      target: nearest,
      kind: "fallback",
      label: "失败退回",
    });
  }

  return {
    nodes,
    edges,
    width:
      Math.min(STAGES.length, LAYOUT.perRow) * LAYOUT.nodeWidth +
      (Math.min(STAGES.length, LAYOUT.perRow) - 1) * LAYOUT.gapX,
    height:
      rowCount(STAGES.length) * LAYOUT.nodeHeight +
      (rowCount(STAGES.length) - 1) * LAYOUT.gapY,
  };
}

/* ============================================================
   节点上的显示文案
   ------------------------------------------------------------
   这些是纯函数，所以「界面上会不会出现自相矛盾的说法」也能被测试。
   ============================================================ */

export type NodeTone = "planned" | "pending" | "running" | "passed" | "failed" | "blocked";

/** 节点该用什么色调。planned 优先 —— 没接入就永远是灰的 */
export function nodeTone(node: PipelineNode): NodeTone {
  if (node.implementation === "planned") return "planned";
  if (node.status === "running") return "running";
  if (node.status === "passed") return "passed";
  if (node.status === "failed") return "failed";
  if (node.status === "blocked") return "blocked";
  return "pending";
}

/** 节点右上角的状态标签 */
export function nodeStatusLabel(node: PipelineNode): string {
  if (node.implementation === "planned") return "未接入";
  if (node.implementation === "direct") {
    // 直通模式下确实在干活，但没走完整契约链路，得说清楚
    if (node.status === "running") return "运行中 · 直通";
    if (node.status === "passed") return "已通过 · 直通";
  }
  switch (node.status) {
    case "running":
      return "运行中";
    case "passed":
      return "已通过";
    case "failed":
      return "失败";
    case "blocked":
      return "需人工";
    case "skipped":
      return "已跳过";
    default:
      return "待执行";
  }
}

/**
 * 节点下方那行数据。
 *
 * 只输出**真的有值**的项 —— 没有耗时就不写「0 秒」，
 * 没有产物就不写「0 KB」。界面上摆一排零等于什么都没说。
 */
export function nodeMetrics(node: PipelineNode): Array<{ label: string; value: string }> {
  if (node.implementation === "planned") return [];
  const out: Array<{ label: string; value: string }> = [];
  if (node.costCny > 0) {
    out.push({ label: "花费", value: `¥${node.costCny.toFixed(4)}` });
  }
  return out;
}

/** 能否点开看详情。未接入的工序也能点 —— 点了会说明为什么没有产物 */
export function isNodeInteractive(node: PipelineNode): boolean {
  return node.implementation !== "planned" || node.status === "pending";
}

/** 供界面显示：这个阶段当前的产物文件到底有没有 */
export function artifactExists(
  stageId: StageId,
  artifacts: ReadonlySet<string>,
): boolean {
  return artifacts.has(STAGE_MAP[stageId].artifact);
}

/* ============================================================
   花费归属
   ------------------------------------------------------------
   把「整次运行花了多少」摊到具体工序上，图上才不会出现
   「总花费 ¥0.0256，但每个节点都是 ¥0.0000」这种自相矛盾。

   ⚠️ 这里有一个必须说清楚的近似：
     当前只有一次模型调用（整份 HTML 一次性生成），
     它实际发生在「并行构建」这道工序上。
     所以整次运行的花费都归给它，而**不是**归给运行记录上
     当前停在的那道工序 —— 生成跑完之后阶段会走到「验收」，
     但那笔钱不是验收花的。

   六阶段内核上线后，每个阶段各自记账，这个函数应当改成
   从 cost_records 按阶段读取。在那之前，宁可只有一个阶段有数字，
   也不要把钱摊到没花钱的工序上。
   ============================================================ */

/** 当前唯一会真正调用模型、因而产生花费的工序 */
export const SPENDING_STAGE: StageId = "build";

export function attributeCost(
  totalCostCny: number,
): Partial<Record<StageId, number>> {
  if (!(totalCostCny > 0)) return {};
  return { [SPENDING_STAGE]: totalCostCny };
}

/* ============================================================
   路径追踪
   ------------------------------------------------------------
   点一个节点，回答两个问题：
     · 它是怎么来的（上游链）
     · 它之后还会去哪（下游链）

   追问「这个产物是怎么来的」是这套界面最该能回答的问题，
   而一堆线里根本看不清哪几根是连着的。

   ── 只在顺序流转边上追溯，不跟回退边 ──
     回退边是「失败了会退回哪」，不是正常流转。
     把它也算进路径的话，任何节点都能顺着一路退回起点，
     于是「上游」永远等于全部六道工序，追踪就没意义了。
     回退边单独列出来给用户看，不混进主链。
   ============================================================ */

export interface PathTrace {
  /** 聚焦的那个工序本身 */
  focus: StageId;
  /** 主链上的全部工序（含聚焦点） */
  chain: Set<StageId>;
  /** 聚焦点的上游（不含它自己），按从近到远 */
  upstream: StageId[];
  /** 聚焦点的下游（不含它自己），按从近到远 */
  downstream: StageId[];
  /** 属于主链的顺序流转边 */
  edges: Set<string>;
  /** 聚焦点自己失败时会退回到哪 —— 单独给，不混进主链 */
  fallbackFromMe: StageId | null;
  /** 主链上任意一道工序失败会退回到哪 */
  fallbacksIntoChain: Array<{ from: StageId; to: StageId }>;
}

export function tracePath(graph: PipelineGraph, from: StageId): PathTrace {
  const flowEdges = graph.edges.filter((e) => e.kind === "flow");
  const fallbackEdges = graph.edges.filter((e) => e.kind === "fallback");

  const forward = new Map<StageId, StageId[]>();
  const backward = new Map<StageId, StageId[]>();
  for (const e of flowEdges) {
    forward.set(e.source, [...(forward.get(e.source) ?? []), e.target]);
    backward.set(e.target, [...(backward.get(e.target) ?? []), e.source]);
  }

  /** 从起点按给定方向走，返回按距离分层的结果 */
  function walk(start: StageId, adj: Map<StageId, StageId[]>): StageId[] {
    const seen = new Set<StageId>([start]);
    const out: StageId[] = [];
    let frontier = [start];
    while (frontier.length) {
      const next: StageId[] = [];
      for (const cur of frontier) {
        for (const nx of adj.get(cur) ?? []) {
          if (seen.has(nx)) continue;
          seen.add(nx);
          out.push(nx);
          next.push(nx);
        }
      }
      frontier = next;
    }
    return out;
  }

  const upstream = walk(from, backward);
  const downstream = walk(from, forward);
  const chain = new Set<StageId>([from, ...upstream, ...downstream]);

  return {
    focus: from,
    chain,
    upstream,
    downstream,
    edges: new Set(
      flowEdges
        .filter((e) => chain.has(e.source) && chain.has(e.target))
        .map((e) => e.id),
    ),
    fallbackFromMe: fallbackEdges.find((e) => e.source === from)?.target ?? null,
    fallbacksIntoChain: fallbackEdges
      .filter((e) => chain.has(e.source))
      .map((e) => ({ from: e.source, to: e.target })),
  };
}

/** 一句话说清这条链，给节点小结用 */
export function describeTrace(trace: PathTrace, nameOf: (id: StageId) => string): string {
  const parts: string[] = [];
  if (trace.upstream.length) {
    parts.push(`上游 ${trace.upstream.map(nameOf).join(" → ")}`);
  } else {
    parts.push("它是整条流水线的起点");
  }
  if (trace.downstream.length) {
    parts.push(`下游 ${trace.downstream.map(nameOf).join(" → ")}`);
  } else {
    parts.push("它是终点，之后没有工序");
  }
  if (trace.fallbackFromMe) {
    parts.push(`这一道失败会退回「${nameOf(trace.fallbackFromMe)}」`);
  }
  return parts.join("；");
}