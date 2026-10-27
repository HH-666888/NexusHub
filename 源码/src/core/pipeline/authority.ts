/**
 * 工序的权限模型：AI 可以随便看、可以在自己这边改，但不能替人对外做决定。
 * 界面、生成、校验三处都要用，所以只留一份。
 */

/** 谁在做这件事。回答的是“谁”，能不能改由 access 表示 */
export type ActorKind = "human" | "ai" | "program";

/** 能不能改东西 */
export type AccessMode = "read" | "write";

/** 碰什么。“写代码”与“上线发布”都是 ai + write，风险差一个量级 */
export type ActionScope = "observe" | "internal" | "outward";

/** 谁必须点头 */
export type Approver =
  /** 不需要额外批准，直接做 */
  | "none"
  /** 必须人点头 */
  | "human";

/** 权限规则只看这三个字段；工序、步骤都满足 */
export interface AccessSubject {
  actor: ActorKind;
  access?: AccessMode;
  scope?: ActionScope;
}

/**
 * 定出这一步的范围，缺省往严的一边倒：只读 → observe，
 * 写但没说范围 → outward，人做的事 → internal。
 * 多问一次的代价是烦，放过一次的代价不可逆。
 */
export function resolveScope(step: AccessSubject): ActionScope {
  if (step.scope) return step.scope;

  if (step.access === "read") return "observe";
  if (step.actor === "human") return "internal";
  if (step.access === "write") return "outward";
  // 没写模式的程序也往严的一边倒
  return step.actor === "program" ? "observe" : "outward";
}

/**
 * 三条规则：只看不改 → 不批；在自己这边改（可回滚）→ 不批；
 * 对外且不可逆或别人看得见 → 必须人批。人自己做的事不用再批自己。
 */
export function requiredApproval(step: AccessSubject): Approver {
  if (step.actor === "human") return "none";
  const scope = resolveScope(step);
  if (scope === "outward") return "human";
  return "none";
}

/** 一句话说清为什么是这个权限；理由说得出来，用户才能预判哪些事会来问他 */
export function explainAuthority(step: AccessSubject): string {
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

/** 徽章文字。AI 必须说清读还是写，人不分读写，程序统一叫自动 */
export function actorBadge(step: { actor: ActorKind; access?: AccessMode }): string {
  if (step.actor === "human") return "人";
  if (step.actor === "program") return "程序自动";
  // 漏填按“干活”显示，否则“看数”和“上线”会显示成同一个徽章
  return step.access === "read" ? "AI · 只读" : "AI · 干活";
}

/** 只要能报出 id 与名字就够，工序、步骤都满足 */
export interface AccessItem extends AccessSubject {
  id: string;
  name: string;
}

export interface AuthorityReport {
  /** 要人点头的 */
  gated: Array<{ id: string; name: string; reason: string }>;
  /** 只看不改的 */
  observeOnly: Array<{ id: string; name: string }>;
  /** 有对外动作但整套流程里没人把关：意味着流程能自己对外做决定 */
  unguarded: Array<{ id: string; name: string }>;
  /** 一句话结论，给界面顶部用 */
  verdict: string;
}

export function authorityOf(items: readonly AccessItem[]): AuthorityReport {
  const gated: AuthorityReport["gated"] = [];
  const observeOnly: AuthorityReport["observeOnly"] = [];
  const outward: Array<{ id: string; name: string }> = [];
  let hasHuman = false;

  for (const s of items) {
    if (s.actor === "human") hasHuman = true;
    const scope = resolveScope(s);

    if (scope === "observe") observeOnly.push({ id: s.id, name: s.name });

    if (scope === "outward" && s.actor !== "human") {
      outward.push({ id: s.id, name: s.name });
      if (requiredApproval(s) === "human") {
        gated.push({ id: s.id, name: s.name, reason: explainAuthority(s) });
      }
    }
  }

  const unguarded = hasHuman ? [] : outward;

  return {
    gated,
    observeOnly,
    unguarded,
    verdict: buildVerdict({
      total: items.length,
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
  if (n.total === 0) return "还没有工序";

  if (n.unguarded > 0) {
    // 不软化这句话：这是这套方法论里唯一不能让步的一条
    return `有 ${n.unguarded} 处会对外产生后果，但整套流程里没有任何一环是人做的`;
  }

  const parts: string[] = [];
  if (n.observe > 0) parts.push(`${n.observe} 处只看不改`);
  if (n.gated > 0) parts.push(`${n.gated} 处要人点头`);
  return parts.length > 0
    ? `${parts.join("，")}，其余在自己这边做`
    : "全部在自己这边做";
}
