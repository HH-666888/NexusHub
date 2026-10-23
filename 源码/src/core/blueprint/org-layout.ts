/**
 * 研发团队运转图 —— 组织结构图的布局
 * ============================================================
 * 参考图（第一张「公司运转图」）的形状是**自上而下的树**：
 *
 *                     人
 *                     ↕
 *                   总管 Agent
 *        ↕派活/日报  （扇形散开）
 *   ┌──────┬──────┬──────┬──────┐
 *  领域A   领域B   领域C   领域D
 *   │      │      │      │
 *  资产    资产    资产    资产
 *  资产    资产           资产
 *
 * ── 和闭环图（loop-layout）的关键差别 ──
 *   闭环图是**固定九宫格**：步数固定、位置固定、能一屏看全。
 *   组织结构图是**列数不定**的：四个领域还是六个、每个领域下挂几个资产，
 *   都由生成决定。所以这里的布局是**算出来的**，不是查表。
 *
 * ── 为什么用"列"这个概念 ──
 *   参考图上同一个领域下的资产是**竖直排成一列**的，
 *   而不同领域之间是横向并列的。这与"树"的直觉一致：
 *   横向代表分工，纵向代表层级。
 *   按列算位置，连线自然就是竖直的 —— 不需要复杂的走线器。
 */

import type { OrgNode, OrgTree } from "./org";

export interface OrgGeometry {
  /** 领域卡的宽 */
  nodeW: number;
  /** 领域卡的高 */
  agentH: number;
  /** 叶子资产卡的宽 */
  leafW: number;
  /** 叶子资产卡的高 */
  leafH: number;
  /** 根（人）那个小卡的高 */
  rootH: number;
  /** 总管卡的高 */
  hubH: number;
  /** 列与列之间的空隙 */
  colGap: number;
  /** 层与层之间的空隙 —— 连线走在这里 */
  levelGap: number;
  /** 同一列里两张资产卡之间的空隙 */
  leafGap: number;
  /** 一列里连续两张资产卡之间额外缩进多少（参考图上下一张比上一张窄一点） */
  leafIndent: number;
}

export const DEFAULT_ORG_GEOMETRY: OrgGeometry = {
  nodeW: 208,
  agentH: 84,
  leafW: 208,
  leafH: 46,
  rootH: 56,
  /**
   * 总管卡的高。
   *
   * 第一版是 72 —— 量下来三行装不下：内边距 16 + 头 16 + 动作 14
   * + 备注 13 = 59，看着够，但行高按 leading-tight 算下来
   * 每行取整后各多一两像素，最后那行「盯着每一块转没转」被裁了半个字。
   * 改成 88。
   *
   * 教训：**排版高度不能按字号估**，行高、行距、取整都会各加一点。
   * 而且被裁的正好是最下面那行 —— 那行往往是最有信息量的一句。
   */
  hubH: 88,
  colGap: 26,
  levelGap: 46,
  leafGap: 14,
  leafIndent: 8,
};

/** 一个已经算好位置的节点 */
export interface PlacedOrgNode {
  node: OrgNode;
  /** 第几列。根和总管是 -1（它们横跨所有列） */
  col: number;
  depth: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 它下面那一列里有多少张资产卡。用来算"整张图多高" */
  kind: "root" | "hub" | "agent" | "asset";
}

export interface OrgLayout {
  nodes: PlacedOrgNode[];
  width: number;
  height: number;
  /** 有几列 */
  columns: number;
}

/* ============================================================
   主入口
   ============================================================ */

export function layoutOrg(tree: OrgTree, g: OrgGeometry = DEFAULT_ORG_GEOMETRY): OrgLayout {
  const nodes: PlacedOrgNode[] = [];
  const domains = tree.root.children;

  // 如果根本身就是唯一节点，就到此为止
  if (domains.length === 0) {
    const w = Math.min(g.nodeW, 180);
    nodes.push({
      node: tree.root,
      col: -1,
      depth: 0,
      x: 0,
      y: 0,
      w,
      h: g.rootH,
      kind: "root",
    });
    return { nodes, width: w, height: g.rootH, columns: 1 };
  }

  /**
   * 取"要横排的那一层"。
   *
   * 参考图上横排的是根的直接子节点（六个领域）。
   * 但生成出来的树可能多一层中间节点 —— 那时横排的应当是
   * **最靠上的那一层分叉**，而不是硬取直接子节点。
   * 判据很简单：如果根只有一个孩子、而那个孩子有多个孩子，
   * 那就往下走一层。
   */
  let level: OrgNode[] = domains;
  let levelDepth = 1;
  let hubNode: OrgNode | null = null;
  if (domains.length === 1 && domains[0].children.length > 0) {
    hubNode = domains[0];
    level = domains[0].children;
    levelDepth = 2;
  }

  const columns = Math.max(level.length, 1);
  const totalW = columns * g.nodeW + (columns - 1) * g.colGap;
  const centerX = totalW / 2;

  /* ---------- 根：人 ---------- */
  /*
    ⚠️ 居中的基准是 totalW —— 也就是**横排那一层**的宽度，
    不是"根的直接子节点数"。
    第一版按 domains.length 算，遇到"根只有一个孩子、孩子有六个"的树时，
    中心算成了 104，而整张图宽 1144，根和总管全挤在最左边。
    测试里那条"根和总管都横向居中"就是为这个写的。
  */
  const rootW = Math.min(g.nodeW, 180);
  nodes.push({
    node: tree.root,
    col: -1,
    depth: 0,
    x: centerX - rootW / 2,
    y: 0,
    w: rootW,
    h: g.rootH,
    kind: "root",
  });

  /* ---------- 总管（有中间层时才有） ---------- */
  const hubY = g.rootH + g.levelGap;
  if (hubNode) {
    const hubW = Math.min(totalW, 320);
    nodes.push({
      node: hubNode,
      col: -1,
      depth: 1,
      x: centerX - hubW / 2,
      y: hubY,
      w: hubW,
      h: g.hubH,
      kind: "hub",
    });
  }

  /* ---------- 横排那一层 + 各自的资产 ---------- */
  const agentsY = hubNode ? hubY + g.hubH + g.levelGap : g.rootH + g.levelGap;

  level.forEach((agent, i) => {
    const colX = i * (g.nodeW + g.colGap);

    nodes.push({
      node: agent,
      col: i,
      depth: levelDepth,
      x: colX,
      y: agentsY,
      w: g.nodeW,
      h: g.agentH,
      kind: "agent",
    });

    // 这一列下面的资产，逐张往下排
    let y = agentsY + g.agentH + g.leafGap;
    agent.children.forEach((asset, j) => {
      // 参考图上同一列里越往下越窄一点 —— 视觉上像"从属于上面那张"
      const indent = Math.min(j, 3) * g.leafIndent;
      nodes.push({
        node: asset,
        col: i,
        depth: levelDepth + 1,
        x: colX + indent,
        y,
        w: g.leafW - indent * 2,
        h: g.leafH,
        kind: "asset",
      });
      y += g.leafH + g.leafGap;
    });
  });

  const height = Math.max(...nodes.map((n) => n.y + n.h));
  return { nodes, width: totalW, height, columns };
}

/* ============================================================
   连线
   ============================================================ */

/**
 * 从一层到下一层的连线。
 *
 * 参考图上这一段的画法和闭环图不一样：
 * 它不是"一条一条画"，而是**从总管底部扇形散开**，
 * 每条线的方向不同、但都汇聚在总管脚下。
 * 所以这里返回的是"从哪个点、到哪个点"，而不是标准化的边。
 *
 * 每对线**成对出现**：往下一条（派活）、往上来一条（日报）。
 * 参考图上它们并排，用颜色区分方向（蓝往下、橙往上）。
 */
export interface OrgEdge {
  from: PlacedOrgNode;
  to: PlacedOrgNode;
  /** 往下那条线（上级给下级） */
  down: { label: string; hint?: string };
  /** 往上那条线 */
  up: { label: string; hint?: string };
}

/** 连线从哪个点出发：从某个节点的底边中点，或顶边中点 */
export function bottomOf(n: PlacedOrgNode) {
  return { x: n.x + n.w / 2, y: n.y + n.h };
}
export function topOf(n: PlacedOrgNode) {
  return { x: n.x + n.w / 2, y: n.y };
}

/**
 * 连线的路径：走一个"肘形"（先竖直出去，再横向，再竖直进去）。
 *
 * ── 为什么不画直线 ──
 *   总管居中、六个领域散开，直线会是一条斜线。
 *   参考图上用的是肘形：从总管脚下竖直下来一小段，
 *   横向走到目标列的中线，再竖直下去。
 *   这样所有线共享同一段水平走廊，看起来是"一束"而不是"一把扇"。
 */
export function orgEdgePath(
  from: PlacedOrgNode,
  to: PlacedOrgNode,
  g: OrgGeometry,
): string {
  const a = bottomOf(from);
  const b = topOf(to);
  // 水平走廊摆在两层之间靠下的位置
  const busY = b.y - g.levelGap * 0.35;

  return `M ${a.x} ${a.y} L ${a.x} ${busY} L ${b.x} ${busY} L ${b.x} ${b.y}`;
}