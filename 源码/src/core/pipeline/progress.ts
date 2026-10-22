/**
 * 流水线进度推算
 * ============================================================
 * 把「这次运行跑到哪了」翻译成「每一道工序分别显示什么状态」。
 *
 * 之所以从组件里抽出来做成纯函数：
 *   这里面藏着一条**不能被改错的规则** —— 没接入的工序绝不能显示成「已通过」。
 *   留在组件内部就只能靠人眼检查；抽出来之后，可以用单元测试钉死它。
 *
 * 背景：最初的做法是「当前阶段之前的都算已通过」。在直通模式下，
 * 这会让①规格化 ②架构定型 ③界面设计 全部显示成「已通过」——
 * 而它们根本没跑过，也拿不出 spec.json / arch.json。
 * 界面上写着「已通过」却交不出产物，比直接写「未接入」严重得多。
 */

import {
  STAGES,
  STAGE_MAP,
  type StageId,
  type StageStatus,
} from "./stages";

export interface RunProgressInput {
  stage: StageId;
  status: "running" | "paused" | "done" | "failed" | string;
}

export function computeStageStatuses(
  run: RunProgressInput | null,
): Record<StageId, StageStatus> {
  const entries = STAGES.map((s): [StageId, StageStatus] => {
    // 第一条规则：还没接入的工序，无论进度如何都如实标注
    if (s.implementation === "planned") return [s.id, "pending"];

    if (!run) return [s.id, "pending"];

    const current = STAGE_MAP[run.stage].order;
    if (s.order < current) return [s.id, "passed"];
    if (s.order > current) return [s.id, "pending"];

    // 就是当前这一道工序，看运行本身的状态
    if (run.status === "running") return [s.id, "running"];
    if (run.status === "paused") return [s.id, "blocked"];
    if (run.status === "done") return [s.id, "passed"];
    if (run.status === "failed") return [s.id, "failed"];
    return [s.id, "skipped"];
  });

  return Object.fromEntries(entries) as Record<StageId, StageStatus>;
}

/** 还有多少道工序没接入 —— 界面上的「直通模式」提示要用 */
export function countPlanned(): number {
  return STAGES.filter((s) => s.implementation === "planned").length;
}

/** 真正有产物的工序（界面右侧只该列这些） */
export function wiredStages() {
  return STAGES.filter((s) => s.implementation !== "planned");
}