/**
 * 门禁策略 —— 把人工门禁接到权限模型上
 * ============================================================
 *
 * ── 改之前是什么样 ──
 *   有两个互不相干的真相来源：
 *
 *     stages.ts   humanGate: true      声明「这一步要人点头」
 *     env.ts      SPEC_GATE=continue   实际控制门禁的开关，默认「放行」
 *
 *   而 `humanGate` **没有任何代码读它** —— 它只是一句声明。
 *   于是声明说"要人点头"、运行时默认放行，而且**放行是静默的**：
 *   用户拿到的成品里，模型替他猜的那些地方一句提示都没有。
 *
 *   这是"孤立开关"这个词的字面意思：开关在那儿，但它跟这套流程
 *   自己的描述没有关系。
 *
 * ── 改之后 ──
 *   权限模型是**唯一**的真相来源：
 *     stageApproval(stage) === "human"  →  这一步就该有人点头
 *
 *   环境变量降级成**运行时覆盖**，它的语义变成：
 *     "我知道这一步声明要人点头，但现在我选择先放行"
 *
 * ── 覆盖可以被允许，但不能是静默的 ──
 *   这是这个文件最重要的一条规矩。
 *
 *   覆盖本身有正当理由（开发时每次生成都被拦一次，很烦；
 *   而"一句话 → 一个能用的成品"这个承诺也会打折扣）。
 *   所以不禁止覆盖。但覆盖之后**必须在两个地方说出来**：
 *     · 事件流里：用户得知道模型在替他猜
 *     · 策略里：界面能查到现在和声明不一致
 *
 *   一个静默关掉的门禁，和没有门禁是同一件事 ——
 *   而且更糟，因为界面上还写着「要人点头」。
 */

import { STAGE_MAP, stageApproval, stageAuthorityNote, type StageId } from "./stages";

/** 运行时对门禁的覆盖 */
export type GateOverride =
  /** 按声明来 */
  | "declared"
  /** 强制停下等人（声明里没写也停） */
  | "pause"
  /** 强制放行（声明里写了也不停） */
  | "continue";

export interface GatePolicy {
  stage: StageId;
  /** 权限模型说的：这一步该不该有人点头 */
  declared: boolean;
  /** 运行时实际会不会停 */
  active: boolean;
  /**
   * 两者是否不一致。
   *
   * **不一致本身不是错误**，但它必须能被查出来 ——
   * 界面上写着「要人点头」而实际不停，是比没有门禁更糟的状态。
   */
  overridden: boolean;
  /** 为什么这一步要人点头（或者为什么不要）。给界面用 */
  reason: string;
  /**
   * 覆盖之后要说给用户听的那句话。没覆盖就是 null。
   *
   * 返回 null 而不是空串：调用方要能一眼分清
   * "没有覆盖"和"有覆盖但理由为空"。
   */
  overrideNote: string | null;
}

/**
 * 定出这一步的门禁策略。
 *
 * 优先级：**运行时的"强制停下" > 权限模型 > 运行时的"强制放行"**。
 *
 * ── 为什么"强制停下"排在模型前面 ──
 *   把门禁加严是安全的：多问一次人的代价是烦，放过一次的代价不可逆。
 *   这两个代价不对等，所以加严永远允许，哪怕模型说不用。
 *
 *   反过来，"强制放行"排在模型后面 —— 它是在放松，必须有明确的
 *   覆盖声明才做，而且会被标成 overridden。
 */
export function resolveGatePolicy(stageId: StageId, override: GateOverride): GatePolicy {
  const stage = STAGE_MAP[stageId];
  const declared = stageApproval(stage) === "human";
  const reason = stageAuthorityNote(stage);

  if (override === "pause") {
    return {
      stage: stageId,
      declared,
      active: true,
      // 加严不算"覆盖"—— 它没有和声明冲突，只是比声明更严
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
        `「${stage.name}」这一步声明了要人点头，但当前设置是先放行。` +
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

/** 这套流程里，哪几道工序声明了要人点头 */
export function declaredGates(): StageId[] {
  return (Object.keys(STAGE_MAP) as StageId[]).filter(
    (id) => stageApproval(STAGE_MAP[id]) === "human",
  );
}