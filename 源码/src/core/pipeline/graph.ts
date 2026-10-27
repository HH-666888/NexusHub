/**
 * 流水线图：把阶段定义与运行状态变成可渲染的图，纯函数零 IO。
 * 节点位置由数据决定（第 N 道在第 N 列），所以图长什么样也可测。
 * 图上只放真实存在的东西：未接入的工序照画，但标成未接入且不参与进度推算。
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


export interface PipelineNode {
  /** 直接用阶段 id，少一层映射 */
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

  // 权限四件套：定义在 stages.ts，规则在 authority.ts

  /** 谁在做这一阶段 */
  actor: ActorKind;
  /** 能不能改东西 */
  access: AccessMode;
  /** 要不要人点头；算出来的，不是另存字段 */
  approval: Approver;
  /** 门禁实际会不会停；approval 是声明，这一项是实际 */
  gateActive: boolean;
  /** 判断依据：凭什么说做完了 */
  watches: StageMetric[];
  /**
   * 失败可退回哪几道。边里已有一份，这份是给自绘画布算弧线用的；
   * 两份都来自 STAGES，不会漂。
   */
  fallbackTo: StageId[];

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

// 布局常量：换布局就是换一组参数

export const LAYOUT = {
  /** 节点尺寸 */
  nodeWidth: 208,
  /**
   * 节点高度。加了权限两行之后 96 装不下，内容约 110 再加行距取整。
   * 布局里必须写死高度：量 DOM 会有首帧闪动、窗口变化要重算，也没法测。
   */
  nodeHeight: 136,
  /** 横向间距（列距 = nodeWidth + gapX） */
  gapX: 64,
  /** 纵向行距，管回退边从下方绕过的空间；留窄了会和下一行顶边叠在一起 */
  gapY: 172,
  /**
   * 每行几道。六道一行 1632px，而工作台那栏只有 830px，缩到 0.5 字读不出；
   * 两行三列降到 752px，缩放接近 1.0。
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


export interface BuildGraphInput {
  /** 选中的运行；null 表示还没选中 */
  run: RunProgressInput | null;
  /** 按 stage 归集的成本；直接收 CostByStage，之后加指标不必改签名 */
  costByStage?: CostByStage;
  /**
   * 运行时门禁覆盖。图上写「要人点头」而实际不停，比没有门禁更糟，
   * 所以覆盖也必须在图上看得见。不传即 declared。
   */
  gateOverride?: GateOverride;
}

/**
 * 连边有两个来源：顺序流转（骨架线性）与 fallbackTo（失败回退）。
 * 回退是这套流程能闭环的地方，别家画不出来。
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
      // 未接入的工序再兜一次底，避免出现「未接入但花了钱」
      costCny: s.implementation === "planned" ? 0 : costOf(s.id, costByStage),

      /*
        approval 算出来而非另存，否则改了 access 忘改 approval 会自相矛盾。
      */
      actor: s.actor,
      access: s.access,
      approval: stageApproval(s),
      /* 门禁实际会不会停；不传覆盖时 gateActive 等于 approval === "human" */
      gateActive: resolveGatePolicy(s.id, gateOverride).active,
      watches: s.watches,
      fallbackTo: [...s.fallbackTo],

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

  // 失败回退只连最近一跳（fallbackTo[0]），全画出来会糊成一团；完整列表在节点详情里
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

// 节点显示文案：纯函数，所以界面上会不会自相矛盾也能测

export type NodeTone = "planned" | "pending" | "running" | "passed" | "failed" | "blocked";

/** planned 优先：没接入就永远是灰的 */
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
    // 直通确实在干活，但没走完整契约链路，要说清
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

/** 只输出真有值的项：没有耗时就不写 0 秒，一排零等于什么都没说 */
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

/*
  花费归属：当前只有一次模型调用（整份 HTML 一次性生成），它实际发生在并行构建上，
  所以整次花费都归给它，而不是运行记录当前停在的那道工序。
  六阶段各自记账之后，这个函数应改成从 cost_records 按阶段读取。
*/

/** 当前唯一会真正调用模型、因而产生花费的工序 */
export const SPENDING_STAGE: StageId = "build";

export function attributeCost(
  totalCostCny: number,
): Partial<Record<StageId, number>> {
  if (!(totalCostCny > 0)) return {};
  return { [SPENDING_STAGE]: totalCostCny };
}

/*
  路径追踪：点一个节点，回答它是怎么来的、之后还会去哪。
  只顺着顺序流转边追，不跟回退边 —— 否则任何节点都能退回起点，上游永远是全部六道。
*/

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