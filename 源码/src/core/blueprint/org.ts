/**
 * 研发团队运转图 —— 组织结构模型
 * ============================================================
 * 描述的是「一支 AI 原生研发团队长什么样」：
 * 谁向谁汇报、谁派活给谁、每一块在看什么数、哪些动作必须由人点头。
 *
 * ⚠️ 这个文件里**没有任何具体业务词**（没有"店铺"、没有"抖音"、
 *    没有"前端 Agent"）。词汇由生成阶段填进来，模型只管结构。
 *    这样同一个模型既能描述研发团队，也能描述别的组织 ——
 *    而**换业务时不用改这个文件**。
 *
 * ── 形状是从参考图里读出来的 ──
 *   四层树：
 *     人（拍板定方向）
 *       ↕  往下"拍板 定方向" / 往上"汇报 每天按点"
 *     总管 Agent（收汇报 · 派活 · 验收）
 *       ↕  往下"派活" / 往上"日报"        ← 注意：这一层的边标签和上一层不同
 *     若干个领域 Agent（每个"看"一样东西）
 *       ↕
 *     具体资产（每个带自己的指标）
 *
 *   所以**边的标签不能挂在节点上** —— 同一棵树里不同层的边
 *   说的是不同的话。见 OrgLink。
 */

/** 谁在干这件事。这三档决定了权限，见 authority.ts */
export type ActorKind = "human" | "ai" | "program";

/**
 * 节点看的一个"数"。
 *
 * 参考图上每个节点底下都有一行小字：「流量 · 订单 · 上架」。
 * 那一行不是装饰 —— 它回答的是**"这个角色凭什么做判断"**。
 * 一个不看数的 AI 角色等于一个凭感觉拍脑袋的人。
 */
export interface Metric {
  label: string;
  /** 补充说明，例如「每天」「按点」「两个模块」 */
  hint?: string;
}

/**
 * 树上的一个节点。
 *
 * 字段分成两组：
 *   身份组  role / actions   —— 它是谁、它干什么
 *   依据组  watches / note   —— 它凭什么、还有什么要说的
 * 分开是有意的：生成时先定身份，再看它该看哪些数。
 * 两者混在一起写，模型很容易给出「一个不看数的角色」。
 */
export interface OrgNode {
  /** 稳定标识。父子关系、连线、界面上的高亮都靠它 */
  id: string;
  /** 角色名。「电商 Agent」「CEO Agent」「Simon」 */
  role: string;
  /** 干什么。可以多个，例如「收汇报」「派活」「验收」 */
  actions: string[];
  /** 一句话补充。可以没有 */
  note?: string;
  /** 看什么数。叶子节点必须至少有一个 —— 这条由校验保证 */
  watches: Metric[];
  actor: ActorKind;
  children: OrgNode[];
}

/**
 * 一条边。
 *
 * ── 为什么单独建模，而不是从父子关系推出来 ──
 *   参考图上，Simon 和 CEO 之间那两条线写的是
 *   「拍板 定方向」和「汇报 每天按点」；
 *   而 CEO 和各个 Agent 之间写的是「派活」和「日报」。
 *   **同一棵树里，不同层的边说的是不同的话。**
 *   挂在节点上就表达不了这件事（一个节点只有一个父边，
 *   但父边在不同层要写不同的字）。
 */
export interface OrgLink {
  from: string;
  to: string;
  /** 往下那条线：上级给下级什么 */
  down: { label: string; hint?: string };
  /** 往上那条线：下级给上级什么 */
  up: { label: string; hint?: string };
}

/** 整棵树 */
export interface OrgTree {
  root: OrgNode;
  /**
   * 所有边。
   * 允许为空 —— 那时从父子关系推一套默认标签（派活 / 日报）。
   * 但只要有显式声明，就以声明为准。
   */
  links: OrgLink[];
}

/* ============================================================
   遍历
   ============================================================ */

/** 前序遍历，把树摊平。界面、校验、统计都用它 */
export function flattenOrg(node: OrgNode): OrgNode[] {
  const out: OrgNode[] = [node];
  for (const c of node.children) out.push(...flattenOrg(c));
  return out;
}

/** 按 id 找节点。找不到返回 null，不抛 —— 调用方多半只是想问"有没有" */
export function findOrgNode(tree: OrgTree, id: string): OrgNode | null {
  for (const n of flattenOrg(tree.root)) {
    if (n.id === id) return n;
  }
  return null;
}

/** 节点在第几层。根是 0 */
export function depthOf(tree: OrgTree, id: string): number {
  let found = -1;
  const walk = (n: OrgNode, d: number) => {
    if (found >= 0) return;
    if (n.id === id) {
      found = d;
      return;
    }
    for (const c of n.children) walk(c, d + 1);
  };
  walk(tree.root, 0);
  return found;
}

/** 树深。根自己算一层，所以只有根的树深度是 1 */
export function treeDepth(node: OrgNode): number {
  if (node.children.length === 0) return 1;
  return 1 + Math.max(...node.children.map(treeDepth));
}

export function countOrgNodes(tree: OrgTree): number {
  return flattenOrg(tree.root).length;
}

/** 叶子节点。界面上这些是"具体资产"，要单独画一种样式 */
export function leavesOf(tree: OrgTree): OrgNode[] {
  return flattenOrg(tree.root).filter((n) => n.children.length === 0);
}

/* ============================================================
   边的标签
   ============================================================ */

/**
 * 取某条边的标签。没有显式声明就退回一套默认。
 *
 * ── 默认值为什么是「派活 / 日报」──
 *   这是参考图上 CEO 和各个 Agent 之间用的词，
 *   也是"总管 → 干活的人"最自然的一对：
 *   往下给的是活，往上回的是进展。
 *   根和人之间那一层通常要显式写（拍板 / 汇报），两者不是一个意思。
 */
export function linkBetween(
  tree: OrgTree,
  from: string,
  to: string,
): { down: { label: string; hint?: string }; up: { label: string; hint?: string } } {
  const hit = tree.links.find((l) => l.from === from && l.to === to);
  return hit ?? { down: { label: "派活" }, up: { label: "日报" } };
}

/**
 * 按树的父子关系补齐所有边。
 *
 * 显式声明的边优先；缺的那些用默认标签补上。
 * 界面只调这一个函数，不用自己判断"这条边有没有声明过"。
 */
export function resolveLinks(tree: OrgTree): Array<OrgLink & { implied: boolean }> {
  const out: Array<OrgLink & { implied: boolean }> = [];
  const declared = new Map(tree.links.map((l) => [`${l.from}→${l.to}`, l]));

  const walk = (n: OrgNode) => {
    for (const c of n.children) {
      const key = `${n.id}→${c.id}`;
      const hit = declared.get(key);
      out.push(
        hit
          ? { ...hit, implied: false }
          : {
              from: n.id,
              to: c.id,
              down: { label: "派活" },
              up: { label: "日报" },
              implied: true,
            },
      );
      walk(c);
    }
  };
  walk(tree.root);
  return out;
}

/* ============================================================
   统计（给界面上的概览用）
   ============================================================ */

export interface OrgStats {
  total: number;
  depth: number;
  /** 按类型数。界面上「几个人、几个 AI、几个程序」 */
  byActor: Record<ActorKind, number>;
  /** 有"看数"的节点占比。低于 1 说明有角色不知道自己凭什么做判断 */
  watchedRatio: number;
}

export function orgStats(tree: OrgTree): OrgStats {
  const all = flattenOrg(tree.root);
  const byActor: Record<ActorKind, number> = { human: 0, ai: 0, program: 0 };
  let watched = 0;

  for (const n of all) {
    byActor[n.actor]++;
    if (n.watches.length > 0) watched++;
  }

  return {
    total: all.length,
    depth: treeDepth(tree.root),
    byActor,
    // 保留两位。界面显示成百分比，不做四舍五入的话会出现 66.66666%
    watchedRatio: all.length === 0 ? 0 : Math.round((watched / all.length) * 100) / 100,
  };
}