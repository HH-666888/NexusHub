/**
 * 闭环主图的布局
 * ============================================================
 * 参考图上那七步的摆法看着不规则，其实是一条**环**：
 *
 *     03 ←── 04 ──→ 05
 *     ↑      hub      ↓
 *     02             06
 *     ↑               ↓
 *     01 ──────────→ 07
 *     └── 回流（沿底边回到 01）
 *
 * 3×3 共九格：**中间是 hub，七步走完外圈八格里的七格，
 * 正下方那一格空着。**
 *
 * ── 为什么把这个数学抽出来，而不是直接写死在组件里 ──
 *   一、它能被测。摆错一格在画面上不一定看得出来 ——
 *       而"01 在左下、03 在左上"这件事是可以断言的。
 *   二、阶段 3 搬上画布时还要用它。画布上的节点是绝对定位的，
 *       同样需要"第几步落在哪个格、格心在哪"。
 *       写死在组件里，到时候得抄第二遍。
 *
 * ── 为什么不做成通用的"N 步摆成圆环" ──
 *   参考图的形状是**这套方法论的形状**，不是随便一个环：
 *   往上走的是"看和判断"，往下走的是"做和查"，中间是人拍板。
 *   步数变了（比如 5 步或 9 步）就沿着同一条外圈继续排，
 *   而不是改成别的形状 —— 换个形状，那套语义就对不上了。
 */

/** 外圈八格，**按流程顺序**排。0 号是左下角 */
export const PERIMETER: ReadonlyArray<{ col: number; row: number }> = [
  { col: 0, row: 2 }, // 0  左下 —— 起点
  { col: 0, row: 1 }, // 1  左中
  { col: 0, row: 0 }, // 2  左上
  { col: 1, row: 0 }, // 3  上中
  { col: 2, row: 0 }, // 4  右上
  { col: 2, row: 1 }, // 5  右中
  { col: 2, row: 2 }, // 6  右下 —— 参考图上 07 回流在这
  { col: 1, row: 2 }, // 7  下中 —— 七步时这一格空着
];

/** 中心。hub 占这一格 */
export const HUB_SLOT = { col: 1, row: 1 } as const;

export const GRID_COLS = 3;
export const GRID_ROWS = 3;

/**
 * 第 i 步（从 0 起）落在哪一格。
 *
 * 步数超过外圈八格时**绕回来重用格子** —— 但那种图会很挤，
 * 由校验去提醒（步数异常），这里不拦。
 */
export function loopSlot(index: number): { col: number; row: number } {
  return PERIMETER[index % PERIMETER.length];
}

/** 每一格的序号 → 步骤序号。用来判断"这一步是不是最后一格" */
export function perimeterIndex(col: number, row: number): number {
  return PERIMETER.findIndex((p) => p.col === col && p.row === row);
}

/** 这一格在不在外圈上 */
export function isPerimeter(col: number, row: number): boolean {
  return perimeterIndex(col, row) >= 0;
}

/* ============================================================
   像素位置
   ============================================================ */

export interface LoopGeometry {
  /** 一格多宽 */
  cellW: number;
  /** 一格多高 */
  cellH: number;
  /** 格与格之间的空隙 */
  gapX: number;
  gapY: number;
}

/**
 * 默认尺寸。
 *
 * ── 格高为什么是 160，不是参考图那种更矮的格子 ──
 *   参考图上每张卡是三行：编号+名字 / 一句话 / 原理条。
 *   我们的卡片正文更长（中文比英文占地方），第一版按 128 做，
 *   结果 02 那张的原理条直接压到了下面 01 的头上。
 *
 *   160 是量出来的：内边距 24 + 头 18 + 间隔 8 + 正文两行 32
 *               + 间隔 10 + 原理两行 36 ≈ 128，留出余量到 160。
 *   留余量的原因是**内容长度由生成决定**，
 *   正好卡着 128 的话，模型多写半句话就会溢出。
 */
export const DEFAULT_GEOMETRY: LoopGeometry = {
  cellW: 232,
  cellH: 160,
  gapX: 56,
  gapY: 20,
};

/** 整张图多大。组件据此设容器尺寸，连线也按它算 */
export function loopCanvasSize(g: LoopGeometry) {
  return {
    width: GRID_COLS * g.cellW + (GRID_COLS - 1) * g.gapX,
    height: GRID_ROWS * g.cellH + (GRID_ROWS - 1) * g.gapY,
  };
}

/** 某一格的左上角 */
export function cellOrigin(col: number, row: number, g: LoopGeometry) {
  return {
    x: col * (g.cellW + g.gapX),
    y: row * (g.cellH + g.gapY),
  };
}

/** 某一格的中心。连线的端点都从这里算 */
export function cellCenter(col: number, row: number, g: LoopGeometry) {
  const o = cellOrigin(col, row, g);
  return { x: o.x + g.cellW / 2, y: o.y + g.cellH / 2 };
}

/* ============================================================
   连线
   ============================================================ */

export type EdgeSide = "top" | "bottom" | "left" | "right";

/**
 * 从一格到另一格，线该从哪条边出、进哪条边。
 *
 * ── 为什么不用"算两个中心、连一条直线" ──
 *   那样线会从卡片中间穿过去。参考图上每条线都是
 *   从边的中点在格子之间的空隙里走的 —— 空隙就是留给线的。
 *   这也让线不会盖住卡片上的字。
 */
export function edgeSides(
  from: { col: number; row: number },
  to: { col: number; row: number },
): { out: EdgeSide; into: EdgeSide } {
  const dc = to.col - from.col;
  const dr = to.row - from.row;

  // 同一列：竖直走
  if (dc === 0) {
    return dr < 0 ? { out: "top", into: "bottom" } : { out: "bottom", into: "top" };
  }
  // 同一行：水平走
  if (dr === 0) {
    return dc < 0 ? { out: "left", into: "right" } : { out: "right", into: "left" };
  }
  // 斜的：从上下出、往左右进 —— 走一个 L 形，比直斜线好读
  return {
    out: dr < 0 ? "top" : "bottom",
    into: dc < 0 ? "right" : "left",
  };
}

/** 某条边的中点。线的端点 */
export function sidePoint(
  col: number,
  row: number,
  side: EdgeSide,
  g: LoopGeometry,
) {
  const o = cellOrigin(col, row, g);
  switch (side) {
    case "top":
      return { x: o.x + g.cellW / 2, y: o.y };
    case "bottom":
      return { x: o.x + g.cellW / 2, y: o.y + g.cellH };
    case "left":
      return { x: o.x, y: o.y + g.cellH / 2 };
    case "right":
      return { x: o.x + g.cellW, y: o.y + g.cellH / 2 };
  }
}

/**
 * 两个格子之间那条线怎么走。
 *
 * ── 为什么不能"连两个中心、画条直线" ──
 *   直线会从卡片上穿过去，而卡片上全是字。
 *
 * ── 为什么也不能"从边出去、直接连到对面的边" ──
 *   第一版就是这么做的：算出出边和入边，然后连一条**直线**。
 *   同行同列时没问题；但 03 在左上、hub 在中中，两点既不同行
 *   也不同列 —— 那条直线斜着穿过 (0,1) 那格，
 *   而 (0,1) 上正好是 02 看现状那张卡。
 *   线上那句「建议先交编排」于是压在了卡片的角上。
 *
 * ── 正确的走法：**从格子之间的缝里绕** ──
 *   缝就是留给线的。不同行也不同列时走三段：
 *     出边 → 拐进缝里 → 沿缝走 → 拐进目标边
 *   这样任何一条线都不会碰到卡片。
 *
 * 返回值里带 label，因为标签也得跟着线走 ——
 * 放在缝的中间，而不是"两端点的中点"（那个点可能落在卡片上）。
 */
export interface RoutedEdge {
  /** 直接塞进 <path d> */
  d: string;
  /** 标签放哪 */
  label: { x: number; y: number };
  /** 线在标签那里是竖着走的吗。竖着走时标签要横排 */
  vertical: boolean;
}

export function routeEdge(
  from: { col: number; row: number },
  to: { col: number; row: number },
  g: LoopGeometry,
  /**
   * 车道偏移。同一个缝里有多条线时，让它们并排走。
   *
   * ── 为什么需要这个 ──
   *   参考图上 「派活」（hub→05）和「做完整交编排」（05→hub）
   *   是同一条缝里的两个方向。不分子道的话，两条线重合、
   *   两个标签也重合 —— 第一版就是两个标签摞在一起。
   *   真实道路也是这么解决的：对向车道分左右。
   */
  lane = 0,
): RoutedEdge {
  const dc = to.col - from.col;
  const dr = to.row - from.row;

  /* ---- 同一列：竖直走 ---- */
  if (dc === 0) {
    const sides = edgeSides(from, to);
    const p1 = sidePoint(from.col, from.row, sides.out, g);
    const p2 = sidePoint(to.col, to.row, sides.into, g);
    return {
      d: `M ${p1.x} ${p1.y} L ${p2.x} ${p2.y}`,
      label: { x: p1.x, y: (p1.y + p2.y) / 2 },
      vertical: true,
    };
  }

  /* ---- 同一行：水平走 ---- */
  if (dr === 0) {
    const sides = edgeSides(from, to);
    const p1 = sidePoint(from.col, from.row, sides.out, g);
    const p2 = sidePoint(to.col, to.row, sides.into, g);
    return {
      d: `M ${p1.x} ${p1.y} L ${p2.x} ${p2.y}`,
      label: { x: (p1.x + p2.x) / 2, y: p1.y },
      vertical: false,
    };
  }

  /* ---- 既不同行也不同列：从缝里绕三段 ---- */
  const goingRight = dc > 0;
  const outSide: EdgeSide = goingRight ? "right" : "left";
  const inSide: EdgeSide = goingRight ? "left" : "right";

  const p1 = sidePoint(from.col, from.row, outSide, g);
  const p2 = sidePoint(to.col, to.row, inSide, g);

  // 缝的中心线，加上车道偏移
  const corridorX = goingRight
    ? p1.x + g.gapX / 2 + lane // 从右边缘往右半个缝
    : p1.x - g.gapX / 2 + lane; // 从左边缘往左半个缝

  return {
    d:
      `M ${p1.x} ${p1.y} ` +
      `L ${corridorX} ${p1.y} ` +
      `L ${corridorX} ${p2.y} ` +
      `L ${p2.x} ${p2.y}`,
    // 标签挂在中间那段竖线上，也就是缝里
    label: { x: corridorX, y: (p1.y + p2.y) / 2 },
    vertical: true,
  };
}