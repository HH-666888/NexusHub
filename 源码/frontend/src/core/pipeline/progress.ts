/**
 * 流水线进度推算：把运行状态翻译成每道工序的显示状态。
 * 未接入的工序恒为 pending，不能因为排在当前阶段之前就显示成已通过。
 */

import { STAGES, STAGE_MAP, type StageId, type StageStatus } from "./stages";

export interface RunProgressInput {
  stage: StageId;
  status: "running" | "paused" | "done" | "failed" | string;
}

export function computeStageStatuses(
  run: RunProgressInput | null,
): Record<StageId, StageStatus> {
  const entries = STAGES.map((s): [StageId, StageStatus] => {
    if (s.implementation === "planned") return [s.id, "pending"];

    if (!run) return [s.id, "pending"];

    const current = STAGE_MAP[run.stage].order;
    if (s.order < current) return [s.id, "passed"];
    if (s.order > current) return [s.id, "pending"];

    if (run.status === "running") return [s.id, "running"];
    if (run.status === "paused") return [s.id, "blocked"];
    if (run.status === "done") return [s.id, "passed"];
    if (run.status === "failed") return [s.id, "failed"];
    return [s.id, "skipped"];
  });

  return Object.fromEntries(entries) as Record<StageId, StageStatus>;
}

/** 未接入的工序数，直通模式提示用 */
export function countPlanned(): number {
  return STAGES.filter((s) => s.implementation === "planned").length;
}

/** 有产物的工序，界面右侧只列这些 */
export function wiredStages() {
  return STAGES.filter((s) => s.implementation !== "planned");
}
