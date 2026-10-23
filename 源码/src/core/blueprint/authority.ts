/**
 * 研发团队运转图 —— 权限模型
 * ============================================================
 * 这套方法论真正的骨头**不是流程图，是权限**。
 *
 * 参考图上每一格底下那句「原理」，一半在讲权限：
 *   02  只看不碰店铺：看错了，最多写错一句话
 *   04  上新、下架、对外回复，只有人能点头
 *   05  只接批过的活；真动店铺前，再问店主一次
 *
 * 把它读成一句话：
 *   **AI 可以随便看，可以随便在自己这边改，但不能替人对外做决定。**
 *
 * ── 为什么权限要单独一个文件 ──
 *   这条规则会被三处用到：生成时（校验）、界面上（画徽章和告警）、
 *   将来真的执行时（拦住动作）。散在三处就一定会漂。
 *   集中在这里，改一次三处全变。
 */

import type { ActorKind } from "./org";
import type { AccessMode, ActionScope, Loop, LoopStep } from "./loop";

/** 谁必须点头 */
export type Approver =
  /** 不需要额外批准，直接做 */
  | "none"
  /** 必须人点头 */
  | "human";

/* ============================================================
   第一步：这一步碰什么
   ============================================================ */

/**
 * 定出这一步的范围。**缺省是保守的。**
 *
 * ── 缺省为什么不能按"看起来无害"那一档 ──
 *   一个漏填 scope 的写操作，如果默认按「自己这边」处理，
 *   它就会被放过去 —— 而线上动作是不可逆的。
 *   所以缺省一律往严的一边倒：
 *     只读          → observe（真的无害）
 *     写、但没说范围 → outward（当成对外的，要人点头）
 *     人做的事      → internal（人本来就是批准者，不用再批自己）
 *
 *   代价是「漏填的内部写操作会被多问一次」。
 *   多问一次的代价是烦；放过一次的代价是不可逆。这两个不对等。
 */
export function resolveScope(
  step: Pick<LoopStep, "actor" | "mode" | "scope">,
): ActionScope {
  if (step.scope) return step.scope;

  if (step.mode === "read") return "observe";
  if (step.actor === "human") return "internal";
  // 写操作 + 没说范围 = 按对外的算
  if (step.mode === "write") return "outward";
  // 程序和人之外的、连模式都没写的：也往严的一边倒
  return step.actor === "program" ? "observe" : "outward";
}

/* ============================================================
   第二步：谁要点头
   ============================================================ */

/**
 * 这一步需不需要人批准。
 *
 * 规则只有三条，但每一条都有来处：
 *
 *   一、只看不改 → 不用批
 *       参考图 02：「看错了，最多写错一句话」。
 *       这是整套设计里最划算的一条 —— 把 AI 的权限压到只读，
 *       它就无论如何搞不坏东西，于是可以放心让它天天跑。
 *
 *   二、在自己这边改 → 不用批
 *       写代码、补测试、改本地配置。搞坏了能回滚，且有版本管理兜着。
 *
 *   三、**对外 → 必须人批**
 *       发布、部署、删数据、给外部发消息。
 *       这一类动作的共同点是**不可逆**，或者**别人看得见**。
 *       参考图 04：「上新、下架、对外回复，只有人能点头」。
 *
 * 人自己做的事不用再批自己 —— 他就是批准者。
 */
export function requiredApproval(
  step: Pick<LoopStep, "actor" | "mode" | "scope">,
): Approver {
  if (step.actor === "human") return "none";

  const scope = resolveScope(step);
  if (scope === "observe") return "none";
  if (scope === "outward") return "human";
  return "none"; // internal
}

/** 简写。界面上问得最多的一句就是"这步要不要人管" */
export function needsHumanSignoff(
  step: Pick<LoopStep, "actor" | "mode" | "scope">,
): boolean {
  return requiredApproval(step) === "human";
}

/* ============================================================
   第三步：解释给用户听
   ============================================================ */

/**
 * 一句话说清这一步为什么是这个权限。
 *
 * ── 为什么要专门写一个"解释"函数 ──
 *   权限规则如果只体现在"要不要弹窗"上，用户学不到东西 ——
 *   他只会觉得这个系统时灵时不灵。
 *   把理由说出来，用户才能预判"哪些事它自己能干、哪些会来问我"。
 *   参考图上每条「原理」做的正是这件事。
 */
export function explainAuthority(
  step: Pick<LoopStep, "actor" | "mode" | "scope">,
): string {
  if (step.actor === "human") {
    return "这一步是人做的 —— 他本来就是批准者，不用再批一次";
  }

  const scope = resolveScope(step);
  if (scope === "observe") {
    return "只看不改 —— 看错了最多是一句错话，不会弄坏任何东西";
  }
  if (scope === "outward") {
    return "这一步会对外产生后果，且不可逆 —— 必须人点头才能做";
  }
  return "只在自己这边改 —— 有版本管理兜底，能不批";
}

/* ============================================================
   整个圈的权限画像
   ============================================================ */

export interface AuthorityReport {
  /** 要人点头的步骤 */
  gated: Array<{ id: string; name: string; reason: string }>;
  /** 只读步骤 */
  observeOnly: Array<{ id: string; name: string }>;
  /**
   * 有问题的步骤：AI 在做对外的事，但这个圈里没有任何一步是人批的。
   *
   * 这是最重要的一条检查 —— 它意味着**整套流程可以自己对外做决定**。
   * 参考图的 04 就是为这件事存在的。
   */
  unguarded: Array<{ id: string; name: string }>;
  /** 一句话结论，给界面顶部用 */
  verdict: string;
}

export function authorityOf(loop: Loop): AuthorityReport {
  const gated: AuthorityReport["gated"] = [];
  const observeOnly: AuthorityReport["observeOnly"] = [];
  const outward: Array<{ id: string; name: string }> = [];
  let hasHumanStep = false;

  for (const s of loop.steps) {
    const scope = resolveScope(s);
    if (s.actor === "human") hasHumanStep = true;

    if (scope === "observe") {
      observeOnly.push({ id: s.id, name: s.name });
    }
    if (scope === "outward" && s.actor !== "human") {
      outward.push({ id: s.id, name: s.name });
      if (requiredApproval(s) === "human") {
        gated.push({ id: s.id, name: s.name, reason: explainAuthority(s) });
      }
    }
  }

  const unguarded = hasHumanStep ? [] : outward;

  return {
    gated,
    observeOnly,
    unguarded,
    verdict: buildVerdict({
      total: loop.steps.length,
      observe: observeOnly.length,
      gated: gated.length,
      unguarded: unguarded.length,
    }),
  };
}

function buildVerdict(n: {
  total: number;
  observe: number;
  gated: number;
  unguarded: number;
}): string {
  if (n.total === 0) return "这个圈还没有步骤";

  if (n.unguarded > 0) {
    // 不软化这句话。它说的是"这套流程可以自己对外做决定"，
    // 而那是这套方法论里唯一一条不能让步的事
    return `有 ${n.unguarded} 步会对外产生后果，但整个圈里没有任何一步需要人点头`;
  }

  const parts: string[] = [];
  if (n.observe > 0) parts.push(`${n.observe} 步只看不改`);
  if (n.gated > 0) parts.push(`${n.gated} 步要人点头`);
  return parts.length > 0 ? `${parts.join("，")}，其余在自己这边做` : "全部在自己这边做";
}

/**
 * 给某个角色一句话的权限说明。用在节点详情面板上。
 *
 * 「AI 能干到哪一步」是用户最想知道、也最容易误解的一件事，
 * 所以这里不返回布尔值，返回一句能读的话。
 */
export function actorCapability(actor: ActorKind, mode?: AccessMode): string {
  if (actor === "human") return "想做什么做什么 —— 所有对外动作的最后一道都是人";
  if (actor === "program") return "按点自动取数，只读不写";
  return mode === "read"
    ? "可以看任何东西，改不了任何东西"
    : "可以在自己这边改，对外动作前会来问你";
}