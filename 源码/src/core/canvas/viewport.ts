/**
 * 视口的坐标数学：全部纯函数，没有 DOM、React 与副作用。
 * 约定 screen = world * scale + pan，反解只要一步减法，缩放锚点不易写错。
 */

export interface Viewport {
  /** 平移量，单位是屏幕像素 */
  panX: number;
  panY: number;
  /** 缩放倍率。1 = 原始大小 */
  scale: number;
}

/** 网格一格的世界尺寸 */
export const CELL = 160;

/**
 * “核心格”：第 3 列第 2 行（从 1 数起）。
 * 流水线从上往下长，所以起点偏上居中，右边和下边都留空。
 */
export const HOME_COL = 3;
export const HOME_ROW = 2;

/** 核心格中心的世界坐标 */
export const HOME_WORLD = {
  x: (HOME_COL - 0.5) * CELL,
  y: (HOME_ROW - 0.5) * CELL,
} as const;

export const MIN_SCALE = 0.2;
export const MAX_SCALE = 4;

/**
 * 缩放倍率夹紧。Infinity 夹到上限，NaN 退回 1：两者混在一起判时
 * Infinity 会被退成 1，表现为画面突然跳回 100%。
 */
export function clampScale(scale: number): number {
  if (Number.isNaN(scale)) return 1;
  if (scale === Infinity) return MAX_SCALE;
  if (scale === -Infinity) return MIN_SCALE;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/**
 * 平移的软边界。夹住不为省内存（网格由 CSS 画），而是浮点精度与防迷路：
 * 拖到 10^7 量级时相邻像素被浮点吃掉，画面会抖。100000px ≈ 625 格。
 */
export const PAN_LIMIT = 100_000;

export function clampPan(v: number): number {
  // 同 clampScale：Infinity 夹到边界，NaN 退回 0
  if (Number.isNaN(v)) return 0;
  if (v === Infinity) return PAN_LIMIT;
  if (v === -Infinity) return -PAN_LIMIT;
  return Math.min(PAN_LIMIT, Math.max(-PAN_LIMIT, v));
}

export function worldToScreen(vp: Viewport, wx: number, wy: number) {
  return { x: wx * vp.scale + vp.panX, y: wy * vp.scale + vp.panY };
}

export function screenToWorld(vp: Viewport, sx: number, sy: number) {
  return { x: (sx - vp.panX) / vp.scale, y: (sy - vp.panY) / vp.scale };
}

/**
 * 以某个屏幕点为锚点缩放，该点下的内容不动。
 * 否则滚轮缩放会让内容朝视口中心跑，用户得反复缩放加平移。
 */
export function zoomAt(
  vp: Viewport,
  anchorScreenX: number,
  anchorScreenY: number,
  factor: number,
): Viewport {
  const next = clampScale(vp.scale * factor);
  // 顶到上下限时原样返回，否则继续滚会持续改 pan，画面缓慢漂移
  if (next === vp.scale) return vp;

  const w = screenToWorld(vp, anchorScreenX, anchorScreenY);
  return {
    scale: next,
    panX: clampPan(anchorScreenX - w.x * next),
    panY: clampPan(anchorScreenY - w.y * next),
  };
}

/** 平移。delta 是屏幕像素 */
export function panBy(vp: Viewport, dx: number, dy: number): Viewport {
  return {
    ...vp,
    panX: clampPan(vp.panX + dx),
    panY: clampPan(vp.panY + dy),
  };
}

/** 让某个世界坐标落在视口正中的视口；打开画布时用它对准核心格 */
export function viewportCenteredOn(
  wx: number,
  wy: number,
  viewportW: number,
  viewportH: number,
  scale = 1,
): Viewport {
  const s = clampScale(scale);
  return {
    scale: s,
    panX: clampPan(viewportW / 2 - wx * s),
    panY: clampPan(viewportH / 2 - wy * s),
  };
}

/** 打开画布时核心格落在视口纵向 0.34 处。放正中会让下半屏立刻不够用，加三四层都得挪 */
export const HOME_SCREEN_Y_RATIO = 0.34;

/** 回到核心格。对应界面上那个“回到原点” */
export function homeViewport(
  viewportW: number,
  viewportH: number,
  scale = 1,
): Viewport {
  const s = clampScale(scale);
  return {
    scale: s,
    panX: clampPan(viewportW / 2 - HOME_WORLD.x * s),
    panY: clampPan(viewportH * HOME_SCREEN_Y_RATIO - HOME_WORLD.y * s),
  };
}

/**
 * 让一块世界区域完整落进视口。倍率按窗口算而不写死：1840 宽的流水线
 * 在 1440 窗口要 0.78，在 2560 窗口则是 1。
 * 纵向下方留白多于上方，因为回退边从节点下方绕出去。
 */
export function fitViewport(
  bounds: { x: number; y: number; w: number; h: number },
  viewportW: number,
  viewportH: number,
  padding = 56,
  /**
   * 缩放下限。面板 808×371 算出来是 48%，字 7 像素读不清：
   * “全都看见”与“看得清”矛盾时，宁可让用户平移，也不把字缩到读不出来。
   */
  minScale = 0,
): Viewport {
  // 空区域退回核心格，否则会算出 Infinity
  if (bounds.w <= 0 || bounds.h <= 0) return homeViewport(viewportW, viewportH);

  const usableW = Math.max(1, viewportW - padding * 2);
  const usableH = Math.max(1, viewportH - padding * 2);
  const fitted = Math.min(usableW / bounds.w, usableH / bounds.h);
  const s = clampScale(Math.max(fitted, minScale));

  const cx = bounds.x + bounds.w / 2;
  const cy = bounds.y + bounds.h / 2;

  /*
    装得下按 0.34 放；装不下按顶对齐放 —— 一律 0.34 的话，内容比视口高时
    上半截被推出可视区，第一眼是排被切掉头的卡片。
  */
  const contentH = bounds.h * s;
  const fits = contentH <= viewportH - padding * 2;

  return {
    scale: s,
    panX: clampPan(viewportW / 2 - cx * s),
    panY: clampPan(
      fits ? viewportH * HOME_SCREEN_Y_RATIO - cy * s : padding - bounds.y * s,
    ),
  };
}

/** 倍率显示成百分比。整数不带小数点，省得写“100.0%” */
export function formatScale(scale: number): string {
  const pct = scale * 100;
  return `${Number.isInteger(pct) ? pct : pct.toFixed(0)}%`;
}

/** 次要文字保留到多少倍率：0.62 × 10.5px ≈ 6.5px，再小就是一层灰糊 */
export const LABEL_MINOR_SCALE = 0.62;

/** 主要文字保留到多少倍率：0.45 × 15px ≈ 6.7px */
export const LABEL_MAJOR_SCALE = 0.45;

/** 当前倍率下，文字该显示到哪一档 */
export type LabelTier = "all" | "major" | "none";

/**
 * 按倍率决定文字显示档位。藏的是字不是信息：色块、边框、状态色都留着，
 * 6 像素的字不是“小一号的信息”，是噪点。
 * 实现用 color: transparent 而非 display: none，屏幕阅读器用户不经历缩放。
 */
export function labelTier(scale: number): LabelTier {
  if (scale >= LABEL_MINOR_SCALE) return "all";
  if (scale >= LABEL_MAJOR_SCALE) return "major";
  return "none";
}

/**
 * 自动适应的缩放下限按档位给，两档与 labelTier 的阈值故意绑在一起：
 * 下限一旦落到档位之下，自动适应就会把“字全没了”的画面当成合适的初始视口。
 * page 取 0.45：取 0.62 要切掉近 300px，最后两道得平移才看得见。
 */
export function fitFloor(variant: "page" | "panel"): number {
  return variant === "panel" ? LABEL_MINOR_SCALE : LABEL_MAJOR_SCALE;
}

/**
 * 网格一格在屏幕上占多少像素。不做“缩小时换更粗的格”那套 LOD：
 * 最小倍率 0.2 × CELL = 32px 本来就够清楚，而 LOD 会让间距在 [T, 2T) 里来回跳。
 */
export function gridStepScreen(scale: number): number {
  return CELL * clampScale(scale);
}
