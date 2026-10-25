/**
 * 六道工序在画布上的世界坐标布局
 * ============================================================
 * 从 core/pipeline/graph.ts 里那套（给 React Flow 用的）搬过来，
 * 但**不是照抄** —— 那一套的约束这里没有了：
 *
 *   · React Flow 那边一行放三个，是因为它的画布要「一屏看得下」，
 *     两行三列最省地方。
 *   · 这里有无限画布、能平移能缩放，所以摆成**一行六个**：
 *     流水线本来就是一列往前走的，绕成两行反而看不出"下一步是哪个"。
 *
 * ── 为什么布局要是纯函数 ──
 *   和闭环图那边同一个理由：摆错一格在画面上不一定看得出来，
 *   但「第 3 道工序在 x = 1040」是可以断言的。
 *   而且连线要从节点的边出发，位置算错的话线会歪 ——
 *   歪一点点肉眼很难发现，看起来"就是这样设计的"。
 */

import { HOME_WORLD } from "../canvas/viewport";

export interface CanvasPipelineGeometry {
  nodeW: number;
  nodeH: number;
  /** 节点之间的横向空隙 —— 连线走在这里 */
  gapX: number;
  /** 节点行距画布核心格的垂直偏移。0 表示节点顶边就在核心格中心那条线上 */
  rowOffsetY: number;
}

/**
 * ⚠️ 尺寸和 core/pipeline/graph.ts 里那套**故意不一样**。
 *
 * 那边的节点是 208×136，因为 React Flow 的画布窄、要挤两行。
 * 这边一行六个、每个 240 宽 —— 总宽 1840，在 1440 的屏幕上
 * 缩放一次就能看全，而不用像两行那样上下找。
 *
 * 两套尺寸并存不是重复建设：等 React Flow 卸掉之后，
 * 那边那套会跟着删掉，留下的是这一套。
 */
export const PIPELINE_GEOMETRY: CanvasPipelineGeometry = {
  nodeW: 240,
  nodeH: 156,
  gapX: 84,
  rowOffsetY: -78,
};

/** 一个节点在世界坐标里的矩形 */
export interface NodeRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/* ============================================================
   摆放
   ============================================================ */

/**
 * 整条流水线的总宽。
 *
 * 注意是 `(n-1)` 个空隙而不是 `n` 个 —— 写错的话整条会偏半个空隙，
 * 而"偏一点"在画面上看不出来，只有拿两个节点的间距去量才发现。
 */
export function pipelineWidth(total: number, g = PIPELINE_GEOMETRY): number {
  return total * g.nodeW + Math.max(0, total - 1) * g.gapX;
}

/**
 * 第 index 个节点的位置（世界坐标，左上角）。
 *
 * ── 为什么整条以核心格的 x 居中 ──
 *   画布打开时视口对准的是核心格（见 viewport.ts 的 homeViewport）。
 *   流水线以它的 x 居中，于是"打开画布就看到整条流水线"这件事
 *   不需要额外调视口 —— 一个常量对齐比一段额外的对准逻辑可靠。
 */
export function nodeRect(index: number, total: number, g = PIPELINE_GEOMETRY): NodeRect {
  const left = HOME_WORLD.x - pipelineWidth(total, g) / 2;
  return {
    x: left + index * (g.nodeW + g.gapX),
    y: HOME_WORLD.y + g.rowOffsetY,
    w: g.nodeW,
    h: g.nodeH,
  };
}

/** 整条流水线占的世界范围。用来做「缩放到全部」 */
export function pipelineBounds(
  total: number,
  g = PIPELINE_GEOMETRY,
): { x: number; y: number; w: number; h: number } {
  if (total === 0) return { x: HOME_WORLD.x, y: HOME_WORLD.y, w: 0, h: 0 };
  const first = nodeRect(0, total, g);
  const last = nodeRect(total - 1, total, g);
  /*
    高度要算上回退边往下绕的那一段 —— 只算节点的话，
    「缩放到全部」之后回退边会被切在屏幕外，
    而它是这张图上最该被看见的东西之一（别家画不出来的那个）。
  */
  return {
    x: first.x,
    y: first.y,
    w: last.x + last.w - first.x,
    h: g.nodeH + FALLBACK_DROP,
  };
}

/* ============================================================
   连线
   ============================================================ */

/** 回退边从节点底边往下绕多远 */
export const FALLBACK_DROP = 96;

/** 节点右边中点（顺序流转的出口） */
export function rightOf(r: NodeRect) {
  return { x: r.x + r.w, y: r.y + r.h / 2 };
}

/** 节点左边中点（顺序流转的入口） */
export function leftOf(r: NodeRect) {
  return { x: r.x, y: r.y + r.h / 2 };
}

/** 节点下边中点（回退边的出口/入口） */
export function bottomOf(r: NodeRect) {
  return { x: r.x + r.w / 2, y: r.y + r.h };
}

/**
 * 顺序流转：一条直线，从右边中点到左边中点。
 *
 * 两端各留 10 像素不画 —— 不然箭头顶在节点的边框上，
 * 看起来像"线和框黏在一起"。
 */
export function flowPath(from: NodeRect, to: NodeRect): string {
  const a = rightOf(from);
  const b = leftOf(to);
  const pad = 10;
  return `M ${a.x + pad} ${a.y} L ${b.x - pad} ${b.y}`;
}

/**
 * 失败回退：从下边出去，从下边回来，走一条弧。
 *
 * ── 为什么不能也画直线 ──
 *   回退的目标通常在左边好几格（比如「验收」失败退回「规格化」）。
 *   画直线的话它会**横穿中间那几个节点** ——
 *   穿过多少个，就盖住多少个节点的正文。
 *
 *   往下绕则是从空白处走：节点行下面那一片本来就是空的。
 *
 * ── 为什么是二次贝塞尔而不是折线 ──
 *   折线（下去、横走、上来）在拐角处是直角，两条回退边并排时
 *   拐角会叠在一起分不清哪条是哪条。
 *   弧线的中段自然分开，而且"绕回去"这个动作用弧线表达更准。
 */
export function fallbackPath(from: NodeRect, to: NodeRect): string {
  const a = bottomOf(from);
  const b = bottomOf(to);
  const drop = Math.max(a.y, b.y) + FALLBACK_DROP;
  return `M ${a.x} ${a.y + 6} Q ${a.x} ${drop} ${(a.x + b.x) / 2} ${drop} Q ${b.x} ${drop} ${b.x} ${b.y + 6}`;
}

/** 回退边弧顶的位置。用来放标签 */
export function fallbackLabelAt(from: NodeRect, to: NodeRect) {
  return { x: (bottomOf(from).x + bottomOf(to).x) / 2, y: bottomOf(from).y + FALLBACK_DROP };
}

/**
 * 顺序流转的箭头该放在哪、指哪个方向。
 *
 * 箭头单独画而不是用 SVG marker：
 *   marker 会跟着线的粗细一起缩放，缩小时箭头糊成一团、
 *   放大时又变成一个巨大的三角。手画一个小三角可以按需夹紧。
 */
export function flowArrowAt(from: NodeRect, to: NodeRect, g = PIPELINE_GEOMETRY) {
  const a = rightOf(from);
  const b = leftOf(to);
  return { x: (a.x + b.x) / 2, y: a.y, dir: "right" as const, width: g.gapX };
}