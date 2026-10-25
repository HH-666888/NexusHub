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
  /**
   * 换行时两行之间的纵向空隙。
   *
   * ⚠️ 它**必须装得下回退边往下绕的那一段**（FALLBACK_DROP）。
   *    装不下的话，上一行的回退弧线会横穿下一行的节点 ——
   *    和"回退边不画直线"是同一个毛病，只是换了个方向。
   */
  gapY: number;
  /**
   * 一行放几道。
   *
   * ── 为什么这个必须能变 ──
   *   一开始写死一行六个。整页画布（1440 宽）上很好看。
   *   但嵌进工作台的面板（830×330）之后，自动适应把它缩到了 **37%** ——
   *   六个节点确实全看见了，可**字看不清**，等于白看。
   *
   *   一行放不下就该换行，这是排版最基本的一件事。
   *   面板里放三列两行，同样的字号下缩到 74%，读得清。
   */
  perRow: number;
  /** 节点行距画布核心格的垂直偏移 */
  rowOffsetY: number;
}

/**
 * ⚠️ 尺寸和 core/pipeline/graph.ts 里那套**故意不一样**。
 *
 * 那边是给 React Flow 用的（208×136、一行三个）；这一套给自己的画布用。
 * 等 React Flow 卸掉之后，那边那套会跟着删掉，留下的是这一套。
 */
export const PIPELINE_GEOMETRY: CanvasPipelineGeometry = {
  nodeW: 240,
  nodeH: 156,
  gapX: 84,
  gapY: 136,
  perRow: 3,
  rowOffsetY: -78,
};

/** 整页画布上用的：屏幕宽，一行摆得下六个 */
export const WIDE_GEOMETRY: CanvasPipelineGeometry = {
  ...PIPELINE_GEOMETRY,
  perRow: 6,
};

/** 一行放不下时换行。这个几何是"面板里"那一档 */
export const PANEL_GEOMETRY: CanvasPipelineGeometry = PIPELINE_GEOMETRY;

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

/** 一行放几道。至少 1，不然除零 */
function colsOf(g: CanvasPipelineGeometry): number {
  return Math.max(1, Math.floor(g.perRow));
}

/** 要几行 */
export function rowCount(total: number, g = PIPELINE_GEOMETRY): number {
  return Math.max(1, Math.ceil(total / colsOf(g)));
}

/** 第 index 道在第几列第几行（都从 0 起） */
export function slotOf(index: number, g = PIPELINE_GEOMETRY): { col: number; row: number } {
  const cols = colsOf(g);
  return { col: index % cols, row: Math.floor(index / cols) };
}

/**
 * 整条流水线的总宽 —— **按最宽的那一行算**。
 *
 * 最后一行可能没排满（六道、一行四个的话，第二行只有两个）。
 * 按 total 算宽度的话会多出两个空位，于是整条看起来偏左。
 */
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

/**
 * 第 index 个节点的位置（世界坐标，左上角）。
 *
 * ── 为什么整条以核心格的 x 居中 ──
 *   画布打开时视口对准的是核心格（见 viewport.ts 的 homeViewport）。
 *   流水线以它的 x 居中，于是"打开画布就看到整条流水线"这件事
 *   不需要额外调视口 —— 一个常量对齐比一段额外的对准逻辑可靠。
 */
export function nodeRect(index: number, total: number, g = PIPELINE_GEOMETRY): NodeRect {
  const { col, row } = slotOf(index, g);
  const left = HOME_WORLD.x - pipelineWidth(total, g) / 2;
  return {
    x: left + col * (g.nodeW + g.gapX),
    y: HOME_WORLD.y + g.rowOffsetY + row * (g.nodeH + g.gapY),
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
    w: pipelineWidth(total, g),
    // 用最后一行节点的底边算，不用 last.y + last.h ——
    // 最后一行没排满时 last 不一定在最右边，但一定在最下一行
    h: last.y + last.h - first.y + FALLBACK_DROP,
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
 * 顺序流转：从右边中点到下一道的左边中点。
 *
 * ── 换行那一条要特别处理 ──
 *   一行排满之后，"下一道"跳到了下一行的**开头**（在最左边）。
 *   照直画的话，线会从最右边一路往左横穿整行 ——
 *   穿过几个节点就盖住几段正文。
 *
 *   所以换行那条走"下进上出"：从当前节点**底边**出去，
 *   在行间空隙里横走，再从目标节点**顶边**进来。
 *   行间空隙本来就是空的（那里只放得下回退弧线，而弧线更靠下）。
 */
export function flowPath(from: NodeRect, to: NodeRect, g = PIPELINE_GEOMETRY): string {
  const pad = 10;

  // 换行：目标在下一行（y 明显更大），走"下出上进"
  if (to.y > from.y + from.h / 2) {
    const a = bottomOf(from);
    // 横走的那条线摆在行间空隙里，但要在回退弧线之上
    const busY = from.y + from.h + g.gapY * 0.34;
    const b = { x: to.x + to.w / 2, y: to.y };
    return `M ${a.x} ${a.y + pad} L ${a.x} ${busY} L ${b.x} ${busY} L ${b.x} ${b.y - pad}`;
  }

  // 同一行：一条水平线，两端各缩进来一点 ——
  // 不缩的话箭头顶在节点边框上，看起来像"线和框黏在一起"
  const a = rightOf(from);
  const b = leftOf(to);
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
 *
 * ── 跨行的回退边要另走一条路 ──
 *   换行之后，有一条回退是"第二行的某道 → 第一行的某道"。
 *   还走下面那条弧的话：弧的下半段在第二行下面 ✓，
 *   可它**回升到第一行**的那一段会竖着穿过第二行正中间那个节点。
 *   竖直方向也会穿透，和水平方向一样。
 *
 *   所以跨行的改走**整条流水线左边那条空白带**：
 *   从左边出去、沿着空白带竖着走、再从目标的左边进来。
 *
 *   ⚠️ 那条竖线的位置必须由**调用方**给（laneX），不能按源节点的左边算。
 *      第一版写的是 `from.x - 32` —— 对"第二行第一道"是对的，
 *      但对"第二行第二道"就偏了整整一个列宽，
 *      于是那条竖线落进了节点范围里，照样竖穿过去。
 *      一个自己算、一个由外面给，差别就在这里：
 *      "整条流水线左边在哪"是**布局整体**的事，单个节点不知道。
 */
export function fallbackPath(
  from: NodeRect,
  to: NodeRect,
  /*
    几何参数这里其实用不到 —— 两条路都只看节点的矩形。
    留着它是为了让调用方不用记"哪个函数要传哪个不要"：
    flowPath 要、fallbackPath 不要的话，两处调用会长得不一样，
    而那种不一致在改动时最容易漏掉一个。
  */
  _g = PIPELINE_GEOMETRY,
  laneX?: number,
): string {
  /* ---------- 跨行：走左边的空白带 ---------- */
  if (to.y < from.y - from.h / 2) {
    const a = leftOf(from);
    const b = leftOf(to);
    const lane = laneX ?? Math.min(from.x, to.x) - 32;
    return `M ${a.x - 6} ${a.y} L ${lane} ${a.y} L ${lane} ${b.y} L ${b.x - 6} ${b.y}`;
  }

  /* ---------- 同一行（或往下）：走下面那条弧 ---------- */
  const a = bottomOf(from);
  const b = bottomOf(to);
  const drop = Math.max(a.y, b.y) + FALLBACK_DROP;
  return `M ${a.x} ${a.y + 6} Q ${a.x} ${drop} ${(a.x + b.x) / 2} ${drop} Q ${b.x} ${drop} ${b.x} ${b.y + 6}`;
}

/**
 * 回退边标签的位置。用来放「失败可退回」
 *
 * `stagger` 是给跨行用的错位量 —— 同一条竖线上可能挂着好几条跨行的回退边
 * （第二行每一道都可能退到第一行的某一道），而它们的中点**算出来一模一样**：
 * 起点都在第二行的中线、终点都在第一行的中线。
 * 不岔开的话几个标签会精确地叠在一个点上，看起来只有一个。
 * 调用方把源节点的序号传进来当错位量。
 */
export function fallbackLabelAt(from: NodeRect, to: NodeRect, laneX?: number, stagger = 0) {
  // 跨行的标签挂在左边那条竖线上，不放弧顶 ——
  // 弧顶在第二行下面，而线是从左边绕上去的，两者对不上
  if (to.y < from.y - from.h / 2) {
    const lane = laneX ?? Math.min(from.x, to.x) - 32;
    return { x: lane, y: (leftOf(from).y + leftOf(to).y) / 2 + stagger * 24 };
  }
  return { x: (bottomOf(from).x + bottomOf(to).x) / 2, y: bottomOf(from).y + FALLBACK_DROP };
}

/**
 * 跨行回退边那条竖线该放在哪 —— 整条流水线的左边再往左一点。
 *
 * 调用方算一次、所有跨行边共用。**不能每条边各算各的**：
 * 各算各的话，第二行第二道算出来的竖线会比第一道偏一个列宽，
 * 于是落进节点范围里，照样竖穿。
 */
export function fallbackLaneX(total: number, g = PIPELINE_GEOMETRY): number {
  return HOME_WORLD.x - pipelineWidth(total, g) / 2 - 32;
}

/**
 * 顺序流转的箭头该放在哪、指哪个方向。
 *
 * 箭头单独画而不是用 SVG marker：
 *   marker 会跟着线的粗细一起缩放，缩小时箭头糊成一团、
 *   放大时又变成一个巨大的三角。手画一个小三角可以按需夹紧。
 */
export function flowArrowAt(from: NodeRect, to: NodeRect, g = PIPELINE_GEOMETRY) {
  // 换行那条：箭头在横走那一段的中间，方向向右
  if (to.y > from.y + from.h / 2) {
    const busY = from.y + from.h + g.gapY * 0.34;
    return { x: (from.x + from.w / 2 + to.x + to.w / 2) / 2, y: busY, dir: "right" as const, width: g.gapX };
  }
  const a = rightOf(from);
  const b = leftOf(to);
  return { x: (a.x + b.x) / 2, y: a.y, dir: "right" as const, width: g.gapX };
}