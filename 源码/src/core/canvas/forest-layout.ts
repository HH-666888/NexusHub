/**
 * 森林布局：给一棵树，算出每个节点摆在哪儿，纯函数零 IO。
 * 两趟：measure（后序）量子树尺寸，place（前序）摆位置；兄弟间距由子树宽推出。
 * 子节点每行 2 个（窄而深）：横向宽度是硬约束，纵向可以无限长。
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
  /** 0 是根，往下递增 */
  depth: number;
  /** 父节点的 id。根是 null */
  parentId: string | null;
  /** 含整棵子树的世界范围，双击聚焦用 */
  subtree: { x: number; y: number; w: number; h: number };
  /** 直接子节点数，界面角标用 */
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
  /** 子树节点；缺省时所有深度共用一套，见文件末尾 */
  child: { w: number; h: number; gapX: number; gapY: number; perRow: number };
  /** 按深度覆盖；不传时行为不变 */
  levels?: Partial<
    Record<number, { w?: number; h?: number; perRow?: number; gapX?: number; gapY?: number }>
  >;
  /** 父节点底边到第一行子节点顶边的距离 */
  parentGapY: number;
  /** 根节点的行距画布核心格的垂直偏移 */
  rowOffsetY: number;
  /** 根节点换行时两行之间的最小空隙。必须装得下回退弧线 */
  rootRowGap: number;
}

/** 默认几何。根的几个数与 WIDE_GEOMETRY 一致，无子树时两者逐像素相同 */
export const FOREST_GEOMETRY: ForestGeometry = {
  root: { w: 240, h: 156, gapX: 84, perRow: 6 },
  /*
    子节点 232×112、每行 2 个：子卡与主卡同构（状态胶囊 + 名称 + 依据 + 胶囊排 + 数值），
    44 高塞不下，112 是量出来的。

    宽度预算（改大之前必须重算）：子树宽 492，总宽 2112，1440 屏上缩放 0.682，
    根卡实际约 163.6px，须 ≥130（否则工序名读不清）；总宽须 ≤2450。
    gapY 32：卡片变高后再留 40，子树会高到 640+，一屏装不下。
  */
  child: { w: 232, h: 112, gapX: 28, gapY: 32, perRow: 2 },
  parentGapY: 56,
  rowOffsetY: -78,
  rootRowGap: 136,
};

/**
 * 三层 Agent 树的按层几何。第 1 层是六道工序，必须用主卡尺寸，
 * 否则会被画成执行点那么大，还会被 perRow=2 折成三行。
 *
 * 0 {240×156, 1} 一级 Agent 只有一个根；1 {240×156, 6} 六道工序一行六个；
 * 2 {232×112, 2} 执行任务点。
 *
 * 宽度账：工序那行自身 6×240+5×28 = 1580，实际由子树宽决定，验收挂 7 个点时是
 * 5×240+492+5×28 = 1832；四分布局下整页只剩 786px，1832 装进去是 0.429，
 * 撞在 page 那档 0.45 的下限，最外侧两张各切约 19px —— 已知取舍。
 *
 * 不传 levels 时 levelAt 逐字段不变，旧的六根并列画布一个像素都不动。
 */
export const TREE_LEVELS: NonNullable<ForestGeometry["levels"]> = {
  0: { w: 240, h: 156, perRow: 1 },
  1: { w: 240, h: 156, perRow: 6 },
  2: { w: 232, h: 112, perRow: 2 },
};

/**
 * 取某一层的实际几何：基准按深度选（0 → root，>=1 → child），
 * levels 逐字段覆盖，没写的字段沿用基准。不传 levels 时须与旧行为逐字段相同。
 * gapY 是唯一两档基准不全有的字段，统一退回 child.gapY。
 */
export function levelAt(
  g: ForestGeometry,
  depth: number,
): { w: number; h: number; gapX: number; perRow: number; gapY: number } {
  const base = depth === 0 ? g.root : g.child;
  const over = g.levels?.[depth];
  return {
    w: over?.w ?? base.w,
    h: over?.h ?? base.h,
    gapX: over?.gapX ?? base.gapX,
    perRow: over?.perRow ?? base.perRow,
    gapY: over?.gapY ?? g.child.gapY,
  };
}

// 折行 + measure

function chunk<T>(list: T[], perRow: number): T[][] {
  const n = Math.max(1, Math.floor(perRow));
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

/** 量过的节点：w/h 含整棵子树，selfW/selfH 是自己那块的尺寸，两者不能混 */
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
  const self = levelAt(g, depth);
  const kids = (node.children ?? []).map((c) => measure(c, depth + 1, g));

  if (kids.length === 0) {
    return { node, depth, selfW: self.w, selfH: self.h, w: self.w, h: self.h, rows: [] };
  }

  // 折行用子节点那一层的 perRow：perRow 说的是「这一行」，而这一行是子节点所在的行
  const kidLevel = levelAt(g, depth + 1);
  const rows = chunk(kids, kidLevel.perRow).map((items) => ({
    items,
    w: items.reduce((s, k) => s + k.w, 0) + Math.max(0, items.length - 1) * kidLevel.gapX,
    h: Math.max(...items.map((k) => k.h)),
  }));

  const widest = Math.max(...rows.map((r) => r.w));
  const rowsH = rows.reduce((s, r) => s + r.h, 0) + Math.max(0, rows.length - 1) * kidLevel.gapY;

  return {
    node,
    depth,
    selfW: self.w,
    selfH: self.h,
    // 子节点比自己宽时以子节点为准，否则兄弟会重叠
    w: Math.max(self.w, widest),
    h: self.h + g.parentGapY + rowsH,
    rows,
  };
}

// 摆放

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

  // 间距也取子节点那一层，否则量出来的宽度与摆出来的位置对不上，方块会叠
  const kidLevel = levelAt(g, m.depth + 1);
  let rowTop = top + m.selfH + g.parentGapY;
  for (const row of m.rows) {
    // 整行在父节点中线上居中
    let cursor = centerX - row.w / 2;
    for (const kid of row.items) {
      const kidLaid = place(kid, cursor + kid.w / 2, rowTop, m.node.id, g, out);
      cursor += kid.w + kidLevel.gapX;
      // subtree 要含住每个子节点的 subtree
      laid.subtree = union(laid.subtree, kidLaid.subtree);
    }
    rowTop += row.h + kidLevel.gapY;
  }
  /*
    再并上自己那一行：子节点比父节点窄时，父节点自身才是这片子树的最宽处。
  */
  laid.subtree = union(laid.subtree, { x, y: top, w: m.selfW, h: m.selfH });
  return laid;
}

// 对外

/**
 * 把一棵森林摆开。坐标系与旧 nodeRect 一致：以核心格 x 居中、首行加 rowOffsetY，
 * 于是「打开画布就看到整条流水线」不需要额外的对准逻辑。
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
      下一行根要落在这一行最高的那棵子树下面，空档还要装得下回退弧线。
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

// 父子连线：一条脊线 + 每个孩子一根短横枝

/**
 * 一个父节点到它所有孩子的连线：一条脊线 + 每个孩子一根短横枝。
 * 每个孩子各画一条线时，第 2 行起的竖线会被方块盖住，看起来像飘着的卡片。
 * 脊线取父卡中心 x，那正是子卡区的中缝，永远不会从方块底下穿过。
 * 横枝接孩子侧边中点而非顶边，否则那一竖会和相邻行的方块重叠。
 */
export interface TreeLink {
  parentId: string;
  /** 脊线的 x。同一父节点的所有横枝都从这条线出发 */
  spineX: number;
  /** 竖线（躯干）：从父卡底边中点到最下面那根横枝 */
  trunk: { x: number; y1: number; y2: number };
  /** 横枝：从脊线插到孩子侧边中点（或顶边中点，见上） */
  branches: {
    childId: string;
    x1: number;
    x2: number;
    y: number;
    /** 孩子横跨脊线时退化成一个点 */
    degenerate: boolean;
  }[];
}

/** 只吃摆好的节点，不算布局；纯函数可单独测 */
export function treeLinks(nodes: LaidNode[]): TreeLink[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out: TreeLink[] = [];

  // 按父节点分组：一个父节点只出一条躯干
  const groups = new Map<string, LaidNode[]>();
  for (const n of nodes) {
    if (!n.parentId) continue;
    const list = groups.get(n.parentId);
    if (list) list.push(n);
    else groups.set(n.parentId, [n]);
  }

  for (const [parentId, kids] of groups) {
    const parent = byId.get(parentId);
    if (!parent || kids.length === 0) continue;

    // 脊线走父卡中心，即子卡区中缝
    const spineX = parent.x + parent.w / 2;
    const top = parent.y + parent.h;

    const branches = kids.map((kid) => {
      const kidCx = kid.x + kid.w / 2;
      const kidCy = kid.y + kid.h / 2;

      /*
        孩子横跨脊线（单数列末行会这样）→ 从顶边直接下来，
        不特判会画出一根插进自己肚子里的短线。
      */
      if (Math.abs(kidCx - spineX) < kid.w / 2) {
        return { childId: kid.id, x1: spineX, x2: kidCx, y: kid.y, degenerate: true };
      }

      // 接朝向脊线的那侧边中点
      const toRight = kidCx > spineX;
      return {
        childId: kid.id,
        x1: spineX,
        x2: toRight ? kid.x : kid.x + kid.w,
        y: kidCy,
        degenerate: false,
      };
    });

    out.push({
      parentId,
      spineX,
      trunk: { x: spineX, y1: top, y2: Math.max(...branches.map((b) => b.y)) },
      branches,
    });
  }

  return out;
}

// 生长动画：两套布局之间的插值

/**
 * 两套布局之间取中间态，纯算术（无 rAF、无时间、无 React），因此可测。
 * 不插值的话子树长出是瞬间完成的，看起来像换了一张图而不是长出来。
 * 新节点从父节点上一帧的位置长出来；父子同时新增时退到父节点这一帧的位置。
 */
export function lerpLayout(
  prev: readonly LaidNode[],
  next: readonly LaidNode[],
  t: number,
): LaidNode[] {
  // 夹到 [0,1]：rAF 时间戳偶尔溢出或倒退，不夹会算出负尺寸
  const k = Math.max(0, Math.min(1, t));

  const prevById = new Map(prev.map((n) => [n.id, n]));
  const nextById = new Map(next.map((n) => [n.id, n]));

  const mix = (a: number, b: number) => a + (b - a) * k;

  return next.map((to) => {
    const from = prevById.get(to.id);

    if (from) {
      // 老节点：位置与尺寸都插值
      return {
        ...to,
        x: mix(from.x, to.x),
        y: mix(from.y, to.y),
        w: mix(from.w, to.w),
        h: mix(from.h, to.h),
      };
    }

    /*
      新节点从父节点中心以 0 宽高展开，看起来像从父卡里钻出来再展开。
    */
    const parent = to.parentId
      ? (prevById.get(to.parentId) ?? nextById.get(to.parentId))
      : undefined;

    const originX = parent ? parent.x + parent.w / 2 : to.x + to.w / 2;
    const originY = parent ? parent.y + parent.h / 2 : to.y + to.h / 2;

    return {
      ...to,
      x: mix(originX, to.x + to.w / 2) - (to.w * k) / 2,
      y: mix(originY, to.y + to.h / 2) - (to.h * k) / 2,
      w: to.w * k,
      h: to.h * k,
    };
  });
}

/** 是否这一帧新出现；渲染层据此做 0 → 1 淡入，「新」只有比较两套布局才知道 */
export function isNewNode(prev: readonly LaidNode[], id: string): boolean {
  return !prev.some((n) => n.id === id);
}

/*
  所有深度共用一套子节点尺寸：三层以上会横向浪费（孙节点那行比父格宽一倍）。
  现在能确定的树形是 1~2 层，三层以上再按深度缩尺寸或换轮廓合并算法。
*/