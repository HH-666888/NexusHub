/**
 * 六道工序在画布上的世界坐标布局：一行六个，纯函数。
 * 尺寸与 graph.ts 那套（给 React Flow 用）故意不同，两者不共用。
 */

import { HOME_WORLD } from "../canvas/viewport";

export interface CanvasPipelineGeometry {
  nodeW: number;
  nodeH: number;
  /** 节点之间的横向空隙 —— 连线走在这里 */
  gapX: number;
  /** 换行时两行之间的纵向空隙，必须装得下回退边那一段（FALLBACK_DROP） */
  gapY: number;
  /**
   * 一行放几道。必须能变：整页画布一行六个，嵌进 830 宽的面板后自动缩到 37%，字看不清；
   * 面板里按三列两行排，同样字号缩到 74%。
   */
  perRow: number;
  /** 节点行距画布核心格的垂直偏移 */
  rowOffsetY: number;
}

/** 尺寸与 graph.ts 那套故意不同：那边给 React Flow 用，这套给自己的画布 */
export const PIPELINE_GEOMETRY: CanvasPipelineGeometry = {
  nodeW: 240,
  nodeH: 156,
  gapX: 84,
  gapY: 136,
  perRow: 3,
  rowOffsetY: -78,
};

/** 整页画布用：一行六个 */
export const WIDE_GEOMETRY: CanvasPipelineGeometry = {
  ...PIPELINE_GEOMETRY,
  perRow: 6,
};

/** 面板里那一档，一行放不下就换行 */
export const PANEL_GEOMETRY: CanvasPipelineGeometry = PIPELINE_GEOMETRY;

/** 一个节点在世界坐标里的矩形 */
export interface NodeRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 一行放几道。至少 1，不然除零 */
function colsOf(g: CanvasPipelineGeometry): number {
  return Math.max(1, Math.floor(g.perRow));
}

/** 要几行 */
export function rowCount(total: number, g = PIPELINE_GEOMETRY): number {
  return Math.max(1, Math.ceil(total / colsOf(g)));
}

/** 第 index 道在第几列第几行（都从 0 起） */
export function slotOf(
  index: number,
  g = PIPELINE_GEOMETRY,
): { col: number; row: number } {
  const cols = colsOf(g);
  return { col: index % cols, row: Math.floor(index / cols) };
}

/** 总宽按最宽的那行算；按 total 算会多出空位，整条看起来偏左 */
export function pipelineWidth(total: number, g = PIPELINE_GEOMETRY): number {
  const cols = colsOf(g);
  const full = Math.min(total, cols);
  return full * g.nodeW + Math.max(0, full - 1) * g.gapX;
}

/** 整条流水线的总高 */
export function pipelineHeight(total: number, g = PIPELINE_GEOMETRY): number {
  const rows = rowCount(total, g);
  return rows * g.nodeH + Math.max(0, rows - 1) * g.gapY;
}

/** 整条以核心格 x 居中，打开画布即可看全整条，不必额外对准视口 */
export function nodeRect(
  index: number,
  total: number,
  g = PIPELINE_GEOMETRY,
): NodeRect {
  const { col, row } = slotOf(index, g);
  const left = HOME_WORLD.x - pipelineWidth(total, g) / 2;
  return {
    x: left + col * (g.nodeW + g.gapX),
    y: HOME_WORLD.y + g.rowOffsetY + row * (g.nodeH + g.gapY),
    w: g.nodeW,
    h: g.nodeH,
  };
}

/** 整条流水线占的世界范围，“缩放到全部”用 */
export function pipelineBounds(
  total: number,
  g = PIPELINE_GEOMETRY,
): { x: number; y: number; w: number; h: number } {
  if (total === 0) return { x: HOME_WORLD.x, y: HOME_WORLD.y, w: 0, h: 0 };
  const first = nodeRect(0, total, g);
  const last = nodeRect(total - 1, total, g);
  // 高度要算上回退边下绕那段，否则“缩放到全部”后回退边被切在屏幕外
  return {
    x: first.x,
    y: first.y,
    w: pipelineWidth(total, g),
    // 用最后一行节点底边算：最后一行没排满时 last 不一定在最右，但一定在最下
    h: last.y + last.h - first.y + FALLBACK_DROP,
  };
}

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
 * 顺序流转：右中点 → 左中点。换行那条走“下出上进”，
 * 照直画会从最右横穿整行，穿过几个节点就盖住几段正文。
 */
export function flowPath(from: NodeRect, to: NodeRect, g = PIPELINE_GEOMETRY): string {
  const pad = 10;

  // 换行：走“下出上进”
  if (to.y > from.y + from.h / 2) {
    const a = bottomOf(from);
    // 横走线摆在行间空隙里，但在回退弧线之上
    const busY = from.y + from.h + g.gapY * 0.34;
    const b = { x: to.x + to.w / 2, y: to.y };
    return `M ${a.x} ${a.y + pad} L ${a.x} ${busY} L ${b.x} ${busY} L ${b.x} ${b.y - pad}`;
  }

  // 同行走水平线，两端各缩进一点，否则箭头顶在节点边框上
  const a = rightOf(from);
  const b = leftOf(to);
  return `M ${a.x + pad} ${a.y} L ${b.x - pad} ${b.y}`;
}

/**
 * 失败回退：下边出去、下边回来，走二次贝塞尔。
 * 画直线会横穿中间几个节点，往下绕是从空白处走；弧线中段也比折线分得清。
 * 跨行走整条流水线左边的空白带，否则回升段会竖着穿过第二行的节点。
 * laneX 必须由调用方给：单个节点不知道“整条流水线左边在哪”。
 */
export function fallbackPath(
  from: NodeRect,
  to: NodeRect,
  /* 几何参数这里用不到，保留是为了调用方不必记哪个函数要传哪个 */
  _g = PIPELINE_GEOMETRY,
  laneX?: number,
): string {
  // 跨行：走左边空白带
  if (to.y < from.y - from.h / 2) {
    const a = leftOf(from);
    const b = leftOf(to);
    const lane = laneX ?? Math.min(from.x, to.x) - 32;
    return `M ${a.x - 6} ${a.y} L ${lane} ${a.y} L ${lane} ${b.y} L ${b.x - 6} ${b.y}`;
  }

  // 同一行或往下：走下面那条弧
  const a = bottomOf(from);
  const b = bottomOf(to);
  const drop = Math.max(a.y, b.y) + FALLBACK_DROP;
  return `M ${a.x} ${a.y + 6} Q ${a.x} ${drop} ${(a.x + b.x) / 2} ${drop} Q ${b.x} ${drop} ${b.x} ${b.y + 6}`;
}

/**
 * 回退边标签位置。stagger 给跨行边错位用：跨行边的中点算出来完全一样，
 * 不岔开会精确叠在一个点上。
 */
export function fallbackLabelAt(
  from: NodeRect,
  to: NodeRect,
  laneX?: number,
  stagger = 0,
) {
  // 跨行标签挂在左边竖线上，弧顶与线对不上
  if (to.y < from.y - from.h / 2) {
    const lane = laneX ?? Math.min(from.x, to.x) - 32;
    return { x: lane, y: (leftOf(from).y + leftOf(to).y) / 2 + stagger * 24 };
  }
  return {
    x: (bottomOf(from).x + bottomOf(to).x) / 2,
    y: bottomOf(from).y + FALLBACK_DROP,
  };
}

/** 跨行竖线的 x，调用方算一次共用；每条边各算会偏进节点范围 */
export function fallbackLaneX(total: number, g = PIPELINE_GEOMETRY): number {
  return HOME_WORLD.x - pipelineWidth(total, g) / 2 - 32;
}

/** 箭头单独画而不用 SVG marker：marker 跟线一起缩放，缩小糊成一团、放大成三角 */
export function flowArrowAt(from: NodeRect, to: NodeRect, g = PIPELINE_GEOMETRY) {
  // 换行：箭头在横走段中间
  if (to.y > from.y + from.h / 2) {
    const busY = from.y + from.h + g.gapY * 0.34;
    return {
      x: (from.x + from.w / 2 + to.x + to.w / 2) / 2,
      y: busY,
      dir: "right" as const,
      width: g.gapX,
    };
  }
  const a = rightOf(from);
  const b = leftOf(to);
  return { x: (a.x + b.x) / 2, y: a.y, dir: "right" as const, width: g.gapX };
}
