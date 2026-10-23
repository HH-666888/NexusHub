/**
 * 工序的权限模型
 * ============================================================
 * 一套流程真正的骨头**不是流程图，是权限**。
 *
 * 参考图上每一格底下那句「原理」，一半在讲权限：
 *   02  只看不碰店铺：看错了，最多写错一句话
 *   04  上新、下架、对外回复，只有人能点头
 *   05  只接批过的活；真动店铺前，再问店主一次
 *
 * 读成一句话就是：
 *   **AI 可以随便看，可以随便在自己这边改，但不能替人对外做决定。**
 *
 * ── 这个文件是怎么来的 ──
 *   一开始它是「研发团队运转图」那个第二能力的一部分，
 *   有一整套自己的模型（组织结构 / 闭环 / 产物 / 校验 / 降级），
 *   还有一张专门用来展示它的页面。
 *
 *   后来发现那是在**并排造第二套"工作怎么发生"的描述** ——
 *   用户看完两张图还得自己猜它们什么关系。
 *   所以那套模型整个删了，**只把这里留下**：
 *   它是那套东西里唯一真正约束行为的规则，
 *   而规则该长在工序上，不该画在图上。
 *
 * ── 为什么规则要单独一个文件 ──
 *   它会被三处用到：界面上（画徽章和告警）、生成时（拦住动作）、
 *   校验时（这套流程自相矛盾吗）。散在三处就一定会漂。
 */

/**
 * 谁在做这件事。
 *
 * 三档决定了权限。注意它回答的是"谁"，不是"能不能改" ——
 * 「AI 看数」和「AI 动手」是同一个 actor 的两种模式，
 * 而它们的风险差了一个数量级。所以下面还有一个 access。
 */
export type ActorKind = "human" | "ai" | "program";

/** 能不能改东西 */
export type AccessMode = "read" | "write";

/**
 * 碰什么。
 *
 * ── 为什么不能从 actor/access 推 ──
 *   「写代码」和「上线发布」都是 ai + write，
 *   但一个改的是自己这边的工作区，一个动的是外面看得见的东西。
 *   风险差着量级，而前两个字段都表达不了这件事。
 *   参考图上「上新、下架、对外回复，只有人能点头」这句原理，
 *   说的正是这一档。
 */
export type ActionScope = "observe" | "internal" | "outward";

/** 谁必须点头 */
export type Approver =
  /** 不需要额外批准，直接做 */
  | "none"
  /** 必须人点头 */
  | "human";

/** 权限规则只看这三个字段。传工序、传步骤、传别的都行 */
export interface AccessSubject {
  actor: ActorKind;
  access?: AccessMode;
  scope?: ActionScope;
}

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
 *     只读            → observe（真的无害）
 *     写、但没说范围   → outward（当成对外的，要人点头）
 *     人做的事        → internal（人本来就是批准者，不用批自己）
 *
 *   代价是「漏填的内部写操作会被多问一次」。
 *   多问一次的代价是烦；放过一次的代价是不可逆。这两个不对等。
 */
export function resolveScope(step: AccessSubject): ActionScope {
  if (step.scope) return step.scope;

  if (step.access === "read") return "observe";
  if (step.actor === "human") return "internal";
  if (step.access === "write") return "outward";
  // 程序和人之外的、连模式都没写的：也往严的一边倒
  return step.actor === "program" ? "observe" : "outward";
}

/* ============================================================
   第二步：谁要点头
   ============================================================ */

/**
 * 这一步需不需要人批准。规则只有三条，但每一条都有来处：
 *
 *   一、只看不改 → 不用批
 *       参考图 02：「看错了，最多写错一句话」。
 *       这是整套设计里最划算的一条 —— 把 AI 的权限压到只读，
 *       它无论如何搞不坏东西，于是可以放心让它天天跑。
 *
 *   二、在自己这边改 → 不用批
 *       写文件、跑测试、改本地配置。搞坏了能回滚，且有版本管理兜着。
 *
 *   三、**对外 → 必须人批**
 *       发布、部署、删数据、给外部发消息。
 *       这一类动作的共同点是**不可逆**，或者**别人看得见**。
 *
 * 人自己做的事不用再批自己 —— 他就是批准者。
 */
export function requiredApproval(step: AccessSubject): Approver {
  if (step.actor === "human") return "none";
  const scope = resolveScope(step);
  if (scope === "outward") return "human";
  return "none";
}

export function needsHumanSignoff(step: AccessSubject): boolean {
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
 */
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

/**
 * 徽章文字。界面上那一小块：「AI · 只读」「程序自动」「人」。
 *
 * 放在核心层而不是组件里，是因为**它是规则的表达**：
 * AI 必须说清是读还是写，人不分读写，程序统一叫"自动"。
 * 这条规则不该散在界面代码里。
 */
export function actorBadge(step: { actor: ActorKind; access?: AccessMode }): string {
  if (step.actor === "human") return "人";
  if (step.actor === "program") return "程序自动";
  // 漏填时按"干活"显示 —— 宁可保守。
  // 不这样的话，「看数」和「上线」会显示成同一个徽章，
  // 而这两件事的风险差了一个数量级
  return step.access === "read" ? "AI · 只读" : "AI · 干活";
}

/**
 * 给某个角色一句话的权限说明。用在节点详情面板上。
 *
 * 「AI 能干到哪一步」是用户最想知道、也最容易误解的一件事，
 * 所以这里不返回布尔值，返回一句能读的话。
 */
export function actorCapability(actor: ActorKind, access?: AccessMode): string {
  if (actor === "human") return "想做什么做什么 —— 所有对外动作的最后一道都是人";
  if (actor === "program") return "按点自动取数，只读不写";
  return access === "read"
    ? "可以看任何东西，改不了任何东西"
    : "可以在自己这边改，对外动作前会来问你";
}

/* ============================================================
   整套流程的权限画像
   ============================================================ */

/** 只要能报出 id 和名字就够了 —— 工序、步骤都满足 */
export interface AccessItem extends AccessSubject {
  id: string;
  name: string;
}

export interface AuthorityReport {
  /** 要人点头的 */
  gated: Array<{ id: string; name: string; reason: string }>;
  /** 只看不改的 */
  observeOnly: Array<{ id: string; name: string }>;
  /**
   * 有问题的地方：有对外动作，但整套流程里没有任何一环是人做的。
   *
   * 这是最重要的一条检查 —— 它意味着**整套流程可以自己对外做决定**。
   * 参考图上那一步「人拍板」就是为这件事存在的。
   */
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
    // 不软化这句话。它说的是"这套流程可以自己对外做决定"，
    // 而那是这套方法论里唯一一条不能让步的事
    return `有 ${n.unguarded} 处会对外产生后果，但整套流程里没有任何一环是人做的`;
  }

  const parts: string[] = [];
  if (n.observe > 0) parts.push(`${n.observe} 处只看不改`);
  if (n.gated > 0) parts.push(`${n.gated} 处要人点头`);
  return parts.length > 0 ? `${parts.join("，")}，其余在自己这边做` : "全部在自己这边做";
}