/**
 * 门禁策略：权限模型是唯一真相来源，环境变量降级为运行时覆盖。
 * 覆盖必须在事件流和策略里同时说明，静默放行比没有门禁更糟。
 */

import { STAGE_MAP, stageApproval, stageAuthorityNote, type StageId } from "./stages";

/** 运行时覆盖：declared 按声明；pause 强制停，continue 强制放行，可无视声明 */
export type GateOverride = "declared" | "pause" | "continue";

export interface GatePolicy {
  stage: StageId;
  /** 权限模型声明该不该有人点头 */
  declared: boolean;
  /** 运行时是否真的会停 */
  active: boolean;
  /** 声明与实际是否不一致；不一致不是错误，但必须可查 */
  overridden: boolean;
  /** 要不要人点头的理由，界面展示用 */
  reason: string;
  /** 覆盖说明，未覆盖为 null（不返回空串） */
  overrideNote: string | null;
}

/**
 * 优先级：强制停下 > 权限模型 > 强制放行。
 * 加严永远允许，放松必须有明确覆盖且标成 overridden。
 */
export function resolveGatePolicy(
  stageId: StageId,
  override: GateOverride,
): GatePolicy {
  const stage = STAGE_MAP[stageId];
  const declared = stageApproval(stage) === "human";
  const reason = stageAuthorityNote(stage);

  if (override === "pause") {
    return {
      stage: stageId,
      declared,
      active: true,
      // 加严不与声明冲突，不算覆盖
      overridden: false,
      reason,
      overrideNote: null,
    };
  }

  if (override === "continue" && declared) {
    return {
      stage: stageId,
      declared,
      active: false,
      overridden: true,
      reason,
      overrideNote:
        `“${stage.name}”这一步声明了要人点头，但当前设置是先放行。` +
        `也就是说，规格里那些模型拿不准的地方，这一次它会替你猜。` +
        `猜出来的东西会照常往下做，错了要到验收那一步才看得出来 —— 那时钱已经花完了。`,
    };
  }

  return {
    stage: stageId,
    declared,
    active: declared,
    overridden: false,
    reason,
    overrideNote: null,
  };
}

/** 声明了要人点头的工序 */
export function declaredGates(): StageId[] {
  return (Object.keys(STAGE_MAP) as StageId[]).filter(
    (id) => stageApproval(STAGE_MAP[id]) === "human",
  );
}
