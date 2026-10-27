/**
 * 自动跟随的闸门：工序推进时把视口移过去，用户动过视口后本次运行不再跟。
 * 这层判据做成纯函数，因为「用户动过 + 又推进一步」在 e2e 里造出来很贵。
 */

import type { StageId } from "../pipeline/stages";

/**
 * 自动跟随的记忆。lastStageId 为 undefined 表示尚未开始（挂载或刚换 run），
 * 为 null 表示当前没有工序在跑；两者都不触发聚焦。
 */
export interface FocusFollowMemory {
  lastStageId: StageId | null | undefined;
  /** 用户平移、缩放或点过视口按钮 */
  userMoved: boolean;
}

/** 决策结果：新记忆 + 该聚焦的工序（null = 不动视口） */
export interface FocusFollowStep {
  next: FocusFollowMemory;
  focus: StageId | null;
}

/** 干净的初始记忆；每次返回新对象，避免多个画布实例共享状态 */
export function freshFocusFollow(): FocusFollowMemory {
  return { lastStageId: undefined, userMoved: false };
}

/** 用户动过视口，本次运行内不再自动聚焦 */
export function markUserMoved(mem: FocusFollowMemory): FocusFollowMemory {
  return { lastStageId: mem.lastStageId, userMoved: true };
}

/**
 * 四条规则按顺序判断：工序未变 → 起点 → 当前无工序 → 用户动过。
 * 全不命中才聚焦；next 恒为新对象，focus 为 null 时无副作用。
 */
export function planFocusFollow(
  mem: FocusFollowMemory,
  stageId: StageId | null,
): FocusFollowStep {
  if (mem.lastStageId === stageId) return { next: mem, focus: null };

  const next: FocusFollowMemory = { lastStageId: stageId, userMoved: mem.userMoved };

  // ② 起点：挂载或刚换 run 的第一个值
  if (mem.lastStageId === undefined) return { next, focus: null };

  if (stageId === null) return { next, focus: null };

  // ④ 排在最后：用户说了算时，推进多少步都不跟
  if (mem.userMoved) return { next, focus: null };

  return { next, focus: stageId };
}

// 用户点名（点清单里的一行）与自动跟随是两条规矩：点名是明确要求，不受视口禁令约束。
// 点名来自 URL，是状态不是事件，所以只在 ?focus= 变化时生效一次。

/** 点名记忆：上一次生效的节点 id；null 表示 URL 上没有点名 */
export type FocusRequestMemory = string | null;

export interface FocusRequestStep {
  /** 新的记忆，调用方存回 */
  next: FocusRequestMemory;
  /** 该聚焦的节点 id，null = 不动视口 */
  go: string | null;
}

/**
 * 三条规则：没有点名 → 清记忆；与上次相同 → 不动；变了 → 执行。
 * 它只回答要不要执行，节点是否存在由画布查。
 */
export function planUserFocus(
  mem: FocusRequestMemory,
  requestedId: string | null,
): FocusRequestStep {
  if (!requestedId) return { next: null, go: null };

  // 同一次点名只生效一次
  if (mem === requestedId) return { next: mem, go: null };

  return { next: requestedId, go: requestedId };
}