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
  type StageId,
  type StageStatus,
} from "./stages";
import { computeStageStatuses } from "./progress";
import type { RunProgressInput } from "./progress";

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
  nodeHeight: 96,
  /** 横向间距（列距 = nodeWidth + gapX） */
  gapX: 64,
  /** 纵向行距 */
  gapY: 132,
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
  /** 各阶段的累计花费。缺省视为 0 */
  costByStage?: Partial<Record<StageId, number>>;
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
      costCny: s.implementation === "planned" ? 0 : (costByStage[s.id] ?? 0),
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