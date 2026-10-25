/**
 * 森林布局：六道工序 + 每道工序往下长的子树
 * ============================================================
 * 这个文件只做一件事：**给一棵森林，算出每个节点摆在哪儿**。
 * 纯函数，零 IO，零 React —— 所以它能被单测钉死。
 *
 * ── 为什么要单开一个文件，而不是改 pipeline-layout.ts ──
 *   pipeline-layout.ts 里那套（nodeRect / pipelineWidth / slotOf）
 *   只吃 `(index, total, geometry)` —— **只吃索引，不吃数据**。
 *   所以「第 3 个节点在哪儿」是一个纯算术问题，32 条单测钉着它。
 *
 *   有了子树之后，位置取决于**这棵树长什么样**，光有索引不够了。
 *   但「纯」这件事不能丢 —— 它从「纯算术」变成「纯数据」，
 *   可测性一点没少（这个文件的单测只多不少）。
 *
 *   旧的那套先留着：它还被 fallbackLaneX 和 pipelineBounds 用着，
 *   而且它是这一套的**回归锚** —— 见下面「没有子树时必须一模一样」。
 *
 * ── 布局算法：两趟 ──
 *   ① measure（后序）：每棵子树有多宽多高
 *   ② place（前序）：把根摆开，再把每棵子树在自己那块地方里摆开
 *
 *   核心就一行：同一行里，后一个的 x 由前一个的**子树宽**推出来 ——
 *   子树越宽，兄弟之间被撑得越开。这就是「自动扩展」。
 *
 * ── 为什么子节点竖着深、不横着宽 ──
 *   横向宽度是**稀缺**的：六道工序要在一个屏幕宽度里全部保持可读。
 *   量过：根节点要 ≥130px 宽，1440 的屏上缩放就得不低于 0.542，
 *   于是整片森林的总宽不能超过 2450。
 *   而纵向**没有约束** —— 画布往下可以无限长。
 *
 *   所以 child.perRow = 2：子树窄而深。
 *   这个值不是审美选择，是从上面那个 2450 反推出来的：
 *     每行 2 个 → 子树宽 360 → 总宽 2400 ✓
 *     每行 3 个 → 子树宽 552 → 总宽 3456 ✗（根节点缩到 92px，读不清）
 */

import { HOME_WORLD } from "./viewport";
import { FALLBACK_DROP } from "./pipeline-layout";

/** 喂进来的树。布局只关心 id 和 children，别的字段原样带回去 */
export interface LayoutNode {
  id: string;
  children?: LayoutNode[];
}

/** 摆好的一个节点 */
export interface LaidNode {
  id: string;
  /** 世界坐标，左上角 */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 0 是根（六道工序），往下递增 */
  depth: number;
  /** 父节点的 id。根是 null */
  parentId: string | null;
  /** **含自己整棵子树**的世界范围。双击聚焦用它 */
  subtree: { x: number; y: number; w: number; h: number };
  /** 直接子节点数。界面上要显示「8 条」这种角标 */
  childCount: number;
}

export interface ForestLayout {
  nodes: LaidNode[];
  byId: Map<string, LaidNode>;
  /** 只有根节点，按顺序 */
  roots: LaidNode[];
  /** 整片森林的世界范围。用来做「缩放到全部」 */
  bounds: { x: number; y: number; w: number; h: number };
}

export interface ForestGeometry {
  /** 根节点（六道工序） */
  root: { w: number; h: number; gapX: number; perRow: number };
  /** 子树节点。所有深度共用一套 —— 见文件末尾的说明 */
  child: { w: number; h: number; gapX: number; gapY: number; perRow: number };
  /** 父节点底边到第一行子节点顶边的距离 */
  parentGapY: number;
  /** 根节点的行距画布核心格的垂直偏移 */
  rowOffsetY: number;
  /** 根节点换行时两行之间的最小空隙。必须装得下回退弧线 */
  rootRowGap: number;
}

/**
 * 默认几何。根的那几个数和 WIDE_GEOMETRY 一致 ——
 * 这样「没有子树时」新旧两套算出来的位置**逐像素相同**（有单测钉着）。
 */
export const FOREST_GEOMETRY: ForestGeometry = {
  root: { w: 240, h: 156, gapX: 84, perRow: 6 },
  /*
    子节点 168 宽、每行 2 个 —— 这个组合让总宽落在 2400，
    1440 的屏上根节点还有 133px 宽（可读）。改大就会破这条线。
  */
  child: { w: 168, h: 44, gapX: 24, gapY: 40, perRow: 2 },
  parentGapY: 56,
  rowOffsetY: -78,
  rootRowGap: 136,
};

/* ============================================================
   内部：折行 + measure
   ============================================================ */

function chunk<T>(list: T[], perRow: number): T[][] {
  const n = Math.max(1, Math.floor(perRow));
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

/**
 * 量过的节点。
 *
 * w/h 是**含整棵子树**的尺寸，selfW/selfH 是自己那个方块的尺寸 ——
 * 两者在叶子节点上相等，在有子节点时前者更大。分开存是因为
 * 「自己画多大」和「占多大地方」是两件事，混成一个字段迟早算错。
 */
interface Measured {
  node: LayoutNode;
  depth: number;
  selfW: number;
  selfH: number;
  w: number;
  h: number;
  rows: { items: Measured[]; w: number; h: number }[];
}

function measure(node: LayoutNode, depth: number, g: ForestGeometry): Measured {
  const self = depth === 0 ? g.root : g.child;
  const kids = (node.children ?? []).map((c) => measure(c, depth + 1, g));

  if (kids.length === 0) {
    return { node, depth, selfW: self.w, selfH: self.h, w: self.w, h: self.h, rows: [] };
  }

  /*
    子节点按 child.perRow 折行 —— 注意用的是**子节点那一档**的 perRow，
    不是当前节点自己的。perRow 是「这一行放几个」，
    而「这一行」是子节点所在的那一行。
  */
  const rows = chunk(kids, g.child.perRow).map((items) => ({
    items,
    w: items.reduce((s, k) => s + k.w, 0) + Math.max(0, items.length - 1) * g.child.gapX,
    h: Math.max(...items.map((k) => k.h)),
  }));

  const widest = Math.max(...rows.map((r) => r.w));
  const rowsH = rows.reduce((s, r) => s + r.h, 0) + Math.max(0, rows.length - 1) * g.child.gapY;

  return {
    node,
    depth,
    selfW: self.w,
    selfH: self.h,
    // 自己那块方块放不下子节点时，以子节点为准 —— 否则兄弟会重叠
    w: Math.max(self.w, widest),
    h: self.h + g.parentGapY + rowsH,
    rows,
  };
}

/* ============================================================
   摆放
   ============================================================ */

function union(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const r = Math.max(a.x + a.w, b.x + b.w);
  const bt = Math.max(a.y + a.h, b.y + b.h);
  return { x, y, w: r - x, h: bt - y };
}

function place(
  m: Measured,
  centerX: number,
  top: number,
  parentId: string | null,
  g: ForestGeometry,
  out: LaidNode[],
): LaidNode {
  const x = centerX - m.selfW / 2;
  const laid: LaidNode = {
    id: m.node.id,
    x,
    y: top,
    w: m.selfW,
    h: m.selfH,
    depth: m.depth,
    parentId,
    subtree: { x, y: top, w: m.selfW, h: m.selfH },
    childCount: m.rows.reduce((s, r) => s + r.items.length, 0),
  };
  out.push(laid);

  if (m.rows.length === 0) return laid;

  let rowTop = top + m.selfH + g.parentGapY;
  for (const row of m.rows) {
    // 整行在父节点的中线上居中 —— 这就是「父节点居中于子节点」
    let cursor = centerX - row.w / 2;
    for (const kid of row.items) {
      const kidLaid = place(kid, cursor + kid.w / 2, rowTop, m.node.id, g, out);
      cursor += kid.w + g.child.gapX;
      // 父节点的 subtree 要含住每一个子节点的 subtree
      laid.subtree = union(laid.subtree, kidLaid.subtree);
    }
    rowTop += row.h + g.child.gapY;
  }
  /*
    再把「自己这一行」也算进 subtree —— 子节点比父节点窄的时候，
    父节点自己的宽度才是这片子树的最宽处。
    union 一次最省事，不用分情况讨论。
  */
  laid.subtree = union(laid.subtree, { x, y: top, w: m.selfW, h: m.selfH });
  return laid;
}

/* ============================================================
   对外
   ============================================================ */

/**
 * 把一棵森林摆开。
 *
 * ── 坐标系 ──
 *   和旧的 nodeRect 完全一致：**以核心格的 x 居中**，
 *   第一行在核心格的 y 加上 rowOffsetY。
 *   保持一致是有意的 —— 「打开画布就看到整条流水线」这件事
 *   靠的就是「位置对齐核心格」，不需要额外的对准逻辑。
 *
 * @param roots 根节点，按顺序。它们之间的箭头由调用方画，这里不管
 */
export function layoutForest(
  roots: LayoutNode[],
  g: ForestGeometry = FOREST_GEOMETRY,
): ForestLayout {
  if (roots.length === 0) {
    return {
      nodes: [],
      byId: new Map(),
      roots: [],
      bounds: { x: HOME_WORLD.x, y: HOME_WORLD.y, w: 0, h: 0 },
    };
  }

  const measured = roots.map((r) => measure(r, 0, g));
  const rootRows = chunk(measured, g.root.perRow).map((items) => ({
    items,
    // 根之间按**子树宽**留空隙 —— 这就是自动扩展
    w: items.reduce((s, k) => s + k.w, 0) + Math.max(0, items.length - 1) * g.root.gapX,
    h: Math.max(...items.map((k) => k.h)),
  }));

  const widest = Math.max(...rootRows.map((r) => r.w));
  const left = HOME_WORLD.x - widest / 2;

  const out: LaidNode[] = [];
  const rootLaid: LaidNode[] = [];
  let top = HOME_WORLD.y + g.rowOffsetY;

  for (const row of rootRows) {
    let cursor = left + (widest - row.w) / 2;
    for (const m of row.items) {
      rootLaid.push(place(m, cursor + m.w / 2, top, null, g, out));
      cursor += m.w + g.root.gapX;
    }
    /*
      下一行根节点要落在**这一行最高的那棵子树**下面，而不是落在
      这一行节点自己的下面 —— 否则上一行的子树会横穿下一行的节点。
      空档还要装得下回退弧线（rootRowGap）。
    */
    top += row.h + g.rootRowGap;
  }

  // 包围盒：所有根节点的 subtree 的并集，再往下留出回退弧线那一段
  let bounds = rootLaid[0].subtree;
  for (const r of rootLaid) bounds = union(bounds, r.subtree);

  return {
    nodes: out,
    byId: new Map(out.map((n) => [n.id, n])),
    roots: rootLaid,
    bounds: { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h + FALLBACK_DROP },
  };
}

/* ============================================================
   关于「所有深度共用一套子节点尺寸」
   ============================================================
   现在第 2 层和第 5 层的方块一样大。

   后果：三层以上的树会横向浪费 —— 一个子节点带两个孙节点时，
   孙节点那一行就是 4 个宽（744），比它父亲那一格（360）宽一倍，
   于是整棵子树被撑宽，根节点之间的距离跟着变大。

   为什么先不管：现在能确定的树形是 **1~2 层**（六道工序 →
   它们各自产出的一批东西）。三层以上要等后端判定规则定了再说，
   那时再按深度缩小尺寸，或者换 Reingold–Tilford 那种轮廓合并的算法。

   写在这里是因为**这是一个已知的取舍，不是没想到**。
*/