/**
 * 工序子树：把每道工序内部发生的事拼成森林。
 * 系统自身的动作可真逐个揭示，AI 一次写完的内容只能整批落下（见 reveal）。
 */

import type { StageId } from "./stages";
import type { CheckResult } from "../domain/check";
import type { LayoutNode } from "../canvas/forest-layout";

/** stream：系统逐个完成，可以真揭示；batch：AI 一次写完，只能整批落下 */
export type RevealMode = "stream" | "batch";

/** 子卡片未接真数据的槽位占位；收敛成常量便于以后只改一处 */
export const CHILD_PLACEHOLDER = "——";

/**
 * 工序下的子卡片。字段与 StageCard 同构，层级感由结构与连线给，不由样式给。
 */
export interface StageChild {
  /** 全局唯一，渲染层按它查数据 */
  id: string;
  /** 归属的工序 */
  stage: StageId;
  /** 卡片名称 */
  label: string;
  /** 判定依据 */
  detail: string;
  tone: "pass" | "fail" | "plain";
  reveal: RevealMode;
  /** 状态胶囊文字，由 tone 推出，不另存 */
  statusLabel: string;
  /** 关键字胶囊，当前为占位 */
  chips: string[];
  /** 分隔线下方的数值，当前为占位 */
  metric: string;
}

/** tone → 状态胶囊文字，渲染层不自判 */
export function statusLabelOf(tone: StageChild["tone"]): string {
  return tone === "pass" ? "通过" : tone === "fail" ? "未过" : "——";
}

/** 七项检查 → 验收子节点；results 取最后一次 kind:"check" 的结果 */
export function checksToChildren(
  results: readonly CheckResult[] | null | undefined,
): StageChild[] {
  if (!results || results.length === 0) return [];

  return results.map((r) => ({
    // id 用检查项名字而非下标，否则顺序一变 React 会把通过方块复用到失败项上
    id: `verify:${r.name}`,
    stage: "verify" as StageId,
    label: r.name,
    detail: r.detail,
    tone: r.pass ? ("pass" as const) : ("fail" as const),
    // 七项检查同步跑完，逐个出现是真的
    reveal: "stream" as const,
    statusLabel: statusLabelOf(r.pass ? "pass" : "fail"),
    // 占位；两枚是因为主卡那一排通常有两三个胶囊
    chips: [CHILD_PLACEHOLDER, CHILD_PLACEHOLDER],
    metric: CHILD_PLACEHOLDER,
  }));
}

/** 按工序分组的子节点 */
export type ChildrenByStage = Partial<Record<StageId, StageChild[]>>;

/** 子节点 → 森林布局树；布局只要 id 与 children，业务字段归渲染层 */
export function toLayoutNodes(
  stageIds: readonly StageId[],
  childrenByStage: ChildrenByStage,
): LayoutNode[] {
  return stageIds.map((id) => {
    const kids = childrenByStage[id];
    return kids && kids.length > 0
      ? { id, children: kids.map((c) => ({ id: c.id })) }
      : { id };
  });
}

/**
 * 一级 Agent + 六道工序 + 各自子节点拼成三层树（toLayoutNodes 返回的是平铺森林）。
 * 布局按深度定尺寸，只有拼树的人知道谁在哪一层；无子节点不带 children 键。
 */
export function toForestNodes(
  rootId: string,
  stageIds: readonly StageId[],
  childrenByStage: ChildrenByStage,
): LayoutNode[] {
  const stages: LayoutNode[] = stageIds.map((id) => {
    const kids = childrenByStage[id];
    return kids && kids.length > 0
      ? { id, children: kids.map((c) => ({ id: c.id })) }
      : { id };
  });

  // 单根是它与平铺森林的唯一区别
  return [{ id: rootId, children: stages }];
}

/** 摊平成 id → 数据表，避免渲染时 O(n²) 查找 */
export function childIndex(childrenByStage: ChildrenByStage): Map<string, StageChild> {
  const out = new Map<string, StageChild>();
  for (const kids of Object.values(childrenByStage)) {
    for (const c of kids ?? []) out.set(c.id, c);
  }
  return out;
}

/** 验收卡角标用（如 7/7），不必展开子树 */
export function summarizeChildren(kids: readonly StageChild[]): {
  total: number;
  failed: number;
} {
  return {
    total: kids.length,
    failed: kids.filter((k) => k.tone === "fail").length,
  };
}