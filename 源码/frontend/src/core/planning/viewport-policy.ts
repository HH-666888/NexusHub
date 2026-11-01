/**
 * 视口策略：focus 收进当前卡，batch 退到整棵树。
 * 两种模式共用同一份树与清单，差异只在这个函数。
 */

export type RunMode = "focus" | "batch";

export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 返回视口该看的范围；原样返回入参不拷贝，调用方按只读快照用 */
export function boundsFor(mode: RunMode, focusOn: Bounds, whole: Bounds): Bounds {
  return mode === "batch" ? whole : focusOn;
}
