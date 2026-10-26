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
  /** ★ 新增（可选）：按深度覆盖。不传 = 现有行为一模一样 */
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

/**
 * 默认几何。根的那几个数和 WIDE_GEOMETRY 一致 ——
 * 这样「没有子树时」新旧两套算出来的位置**逐像素相同**（有单测钉着）。
 */
export const FOREST_GEOMETRY: ForestGeometry = {
  root: { w: 240, h: 156, gapX: 84, perRow: 6 },
  /*
    子节点 232×112、每行 2 个。

    ── 为什么从 168×44 涨到这么大 ──
      原来子卡片只有「一个圆点 + 一行字」，44 高就够了。
      用户要求子卡和主卡**同一套视觉语言**：
        「需要有关键的颜色和内容……不能只是一个标题」
        「6 个根节点是主、后面的是子，但只是**位置**上的区分，样式先不区分」
      于是一张子卡要装下：状态胶囊 + 名称 + 判定依据 + 关键字胶囊排
      + 分隔线 + 一个数值 —— 和主卡同构，只是小一号。
      44 高塞不下这五样，112 是量出来的。

    ── 宽度预算（改大之前必须算这笔账）──
      子树宽 = 2×232 + 28 = 492
      总宽   = 5×240 + 492 + 5×84 = 2112     ← 必须 ≤ 2450
      1440 屏上缩放 = 0.682
      根卡实际宽 = 240 × 0.682 ≈ 163.6px     ← 必须 ≥ 130（否则工序名读不清）
      子卡实际宽 ≈ 158.2px

      2450 和 130 这两个数是**硬约束**，来自「六道工序要在一屏里
      全部保持可读」——见文件头那段。2112 < 2450，还有余量，
      所以这次放大是安全的。再往上加就要重新算这笔账。

    ── gapY 从 40 降到 32 ──
      卡片变高之后行距再留 40，子树就高到 640+，一屏装不下
      （现在子树高 544）。32 是"同属一组"仍然看得出来、
      又不浪费纵向空间的值。
  */
  child: { w: 232, h: 112, gapX: 28, gapY: 32, perRow: 2 },
  parentGapY: 56,
  rowOffsetY: -78,
  rootRowGap: 136,
};

/**
 * 三层 Agent 树的按层几何。
 *
 * ── 为什么必须是「按层」而不是一套尺寸 ──
 *   升级成三层之后，**第 1 层的六道工序掉进了 child 那一档**：
 *   六张本该和主卡一样大的工序卡被画成执行任务点那么大（232×112），
 *   层级感当场消失；而且它们会被按 perRow = 2 折成三行，
 *   「六道横着排成一行」这个流水线最基本的形态也没了。
 *   所以第 0 层和第 1 层都用主卡尺寸 240×156，第 2 层起才是子卡尺寸。
 *
 * ── 三个数字各自的来历 ──
 *   0  { w: 240, h: 156, perRow: 1 }   一级 Agent：和主卡同尺寸；只有它一个根
 *   1  { w: 240, h: 156, perRow: 6 }   六道工序：**和现在一样大、一行六个**
 *   2  { w: 232, h: 112, perRow: 2 }   执行任务点：照旧（子树窄而深，见文件头）
 *
 * ── 横向宽度这笔账（改大之前必须重算）──
 *   六道工序**自己那一行** = 6×240 + 5×28 = 1580
 *   （ⓘ gapX 这一层没有覆盖，按 levelAt 的规则退回 child.gapX = 28）
 *
 *   但一行实际排多宽由**各自的子树宽**决定（measure 里那句
 *   `w: Math.max(self.w, widest)`）：验收下面挂着 7 个执行任务点，
 *   光是它自己就占 492 宽 —— 于是真到跑起来时这一行是
 *     5×240 + 492 + 5×28 = **1832**，仍然 ≤ 2450（见文件头那条硬约束）。
 *
 *   顺带一个必须一起看的数：四分布局之后整页画布只剩 786px 左右，
 *   1832 装进去是 0.429，**撞在 page 那一档 0.45 的下限上**，
 *   也就是最外侧两张各被切掉约 19 像素。这和升级前的取舍是同一档
 *   （那时候带上子树的整片森林 2112 宽，算出来 0.372，切得更多），
 *   不是这次变宽造成的。真要消掉它就得缩 gapX 或缩卡片 —— 两件事
 *   都会动到"六道工序一屏读得清"那条底线，所以留着。
 *
 * ── 深浅怎么定 ──
 *   perRow 用的是**子节点那一层**的值（见 measure 里那句）：
 *   所以「六道排成一行」靠的是 levels[1].perRow = 6，
 *   而「执行任务点每行 2 个」靠的是 levels[2].perRow = 2。
 *
 * ⚠️ 不传 levels 时 levelAt 的行为**逐字段不变**（有单测钉着）——
 *    也就是说这份常量只影响传了它的调用方，旧的六根并列画布一个像素都不动。
 */
export const TREE_LEVELS: NonNullable<ForestGeometry["levels"]> = {
  0: { w: 240, h: 156, perRow: 1 },
  1: { w: 240, h: 156, perRow: 6 },
  2: { w: 232, h: 112, perRow: 2 },
};

/**
 * 取某一层的实际几何：levels 覆盖优先，没写就退回 root/child 默认。
 *
 * ── 基准按**深度**选，覆盖按**字段**走 ──
 *   depth === 0 → 基准 g.root；depth >= 1 → 基准 g.child。
 *   然后 levels[depth] **逐字段**覆盖 —— 只写了 w 的那一层，
 *   h / gapX / perRow 仍然是基准里的值，不会变成 undefined。
 *
 * gapY 是唯一一个「两档基准里不全有」的字段（g.root 上没有 gapY），
 * 所以它统一退回 g.child.gapY，除非 levels[depth].gapY 明写。
 *
 * ── 为什么必须「不传 levels 时与旧行为逐字段相同 ──
 *   三层树里第 1 层（六道工序）要用主卡尺寸 240×156，
 *   而第 2 层往下是 232×112 —— 只有按深度区分尺寸才摆得对。
 *   但「没有子树时与旧布局逐像素一致」那条回归锚不能破：
 *   它靠的就是 levels 缺省时这里算出来的每个字段
 *   都等于原来的 `depth === 0 ? g.root : g.child`。
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
  const self = levelAt(g, depth);
  const kids = (node.children ?? []).map((c) => measure(c, depth + 1, g));

  if (kids.length === 0) {
    return { node, depth, selfW: self.w, selfH: self.h, w: self.w, h: self.h, rows: [] };
  }

  /*
    子节点按**它们自己那一层**的 perRow 折行 —— 注意用的是**子节点那一档**的 perRow，
    不是当前节点自己的。perRow 是「这一行放几个」，
    而「这一行」是子节点所在的那一行。
    三层树里六道工序要排成一行（第 1 层 perRow = 6）、
    执行任务点每行 2 个（第 2 层 perRow = 2），靠的就是这一句。
  */
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

  /*
    间距也必须取**子节点那一层**的：measure 里折行宽高用的是 kidLevel，
    这里若还用默认的 g.child，两者会在 levels 覆盖了 gapX/gapY 时对不上 ——
    量出来的宽度和摆出来的位置不一致，方块就会叠上。
  */
  const kidLevel = levelAt(g, m.depth + 1);
  let rowTop = top + m.selfH + g.parentGapY;
  for (const row of m.rows) {
    // 整行在父节点的中线上居中 —— 这就是「父节点居中于子节点」
    let cursor = centerX - row.w / 2;
    for (const kid of row.items) {
      const kidLaid = place(kid, cursor + kid.w / 2, rowTop, m.node.id, g, out);
      cursor += kid.w + kidLevel.gapX;
      // 父节点的 subtree 要含住每一个子节点的 subtree
      laid.subtree = union(laid.subtree, kidLaid.subtree);
    }
    rowTop += row.h + kidLevel.gapY;
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
   父子连线：一条脊线 + 每个孩子一根短横枝
   ============================================================ */

/**
 * 一个父节点到它所有孩子的连线。
 *
 * ── 为什么不是"每个孩子各画一条线" ──
 *   那种画法（第一版就是这样）在**一排孩子**时没问题，
 *   但孩子的排布是**多行多列**的（每行 2 个、共 4 行）：
 *   每个孩子各自从父节点连线，第 2/3/4 行的那几条竖线
 *   必须**从第 1 行的方块底下穿过去** —— 而方块画在线**上面**，
 *   于是那些线全被盖住。
 *
 *   结果是：**只有第一行看起来连着，下面三行像飘着的卡片。**
 *   用户的反馈「为什么没有树节点的效果」，这就是直接原因。
 *
 * ── 现在怎么画 ──
 *
 *           父卡底边中点
 *                │
 *                │   ← trunk：一条竖线，从父卡底下拉到最下面那根横枝
 *         ┌──────┼──────┐
 *      [子1]     │    [子2]      ← 横枝接在孩子**朝向脊线的那条边**的中点
 *         ┌──────┤
 *      [子3]     │    [子4]
 *                │
 *             [子5]              ← 孩子横跨脊线时，横枝退化成从顶边直接下来
 *
 * **关键在脊线的位置**：父卡中心 x 恰好等于两块子卡区的中缝 ——
 * 因为子树本来就是**以父卡中心为中心**摆的（见 place 里那句
 * `cursor + m.w / 2`）。于是脊线天然落在两列之间的空隙里，
 * **永远不会从任何方块底下穿过**。
 *
 * ── 接边而不是接顶 ──
 *   横枝接在孩子**侧边的中点**，不接顶边中点。
 *   接顶边的话每个孩子还要多一段自己的竖线，那一竖会和相邻行的
 *   方块重叠；接侧边则是一根干净的横线插进去，扫描一眼就知道
 *   谁挂在谁身上 —— 这是组织结构图的通行画法。
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
    /** 横枝退化成了一个点（孩子横跨脊线）时为 true */
    degenerate: boolean;
  }[];
}

/**
 * 算出所有「父 → 子」的连线。
 *
 * 只吃摆好的节点，不算布局 —— 和 layoutForest 一样是纯函数，
 * 可以单独钉单测。
 *
 * @param nodes 一棵摆好的森林的全部节点（根 + 子）
 */
export function treeLinks(nodes: LaidNode[]): TreeLink[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out: TreeLink[] = [];

  /* 按父节点分组 —— 一个父节点只出一条躯干 */
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

    /* 脊线走父卡中心 —— 那正是子卡区的中缝，见上面那段说明 */
    const spineX = parent.x + parent.w / 2;
    const top = parent.y + parent.h;

    const branches = kids.map((kid) => {
      const kidCx = kid.x + kid.w / 2;
      const kidCy = kid.y + kid.h / 2;

      /*
        孩子自己就横跨脊线（单数列的最后一行会这样：一个孩子居中摆在
        两列正中间）→ 横枝没有意义，让它从顶边直接下来。
        不特判的话会画出一根插进自己肚子里的短线。
      */
      if (Math.abs(kidCx - spineX) < kid.w / 2) {
        return { childId: kid.id, x1: spineX, x2: kidCx, y: kid.y, degenerate: true };
      }

      /* 孩子在脊线右边 → 接它的左边中点；在左边 → 接它的右边中点 */
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

/* ============================================================
   生长动画：两套布局之间的插值
   ============================================================ */

/**
 * 在上一帧的布局和这一帧的布局之间取一个中间态。
 *
 * ── 为什么要有它 ──
 *   子树是**跑起来才长出来的**：一开始六个根节点挨在一起，
 *   跑到验收时「验收」下面突然多出七个方块，六道工序被撑开让位。
 *   不做插值的话，这些位移是**瞬间**发生的 —— 画面上看起来
 *   就像"闪了一下换了一张图"，而不是"东西长出来了"。
 *
 *   用户要的「动态效果拉满」，一半就落在这个函数上。
 *
 * ── 纯函数 ──
 *   它只做算术：吃两套布局和一个 0~1 的数，吐一套中间布局。
 *   没有 requestAnimationFrame、没有时间、没有 React ——
 *   所以它可以被单测钉死（"t=0 等于上一帧、t=1 等于这一帧"
 *   这种性质用眼睛是验不出来的）。
 *
 * ── 新节点从哪儿冒出来 ──
 *   这是这个函数里唯一有判断的地方。
 *
 *   上一帧没有的节点（新长出来的子方块），如果直接从它的终点开始，
 *   就是硬生生"凭空出现"。让它**从父节点的位置长出来**，
 *   才有"挂上去"的感觉 —— 而那正是这棵树想表达的东西。
 *
 *   起点取父节点**上一帧**的位置：这样方块看起来是从父卡里钻出来的。
 *   上一帧也没有父节点（父子同时新增）时退而取父节点这一帧的位置；
 *   再退而取它自己 —— 至少不会算出 NaN。
 *
 * @param prev 上一帧的节点，按 id 认。第一次渲染传空数组
 * @param next 这一帧的目标节点
 * @param t    0 = 完全在上一帧，1 = 完全在这一帧。中间值自动夹到 [0,1]
 */
export function lerpLayout(
  prev: readonly LaidNode[],
  next: readonly LaidNode[],
  t: number,
): LaidNode[] {
  /* 夹一下：rAF 的时间戳偶尔会溢出或倒退，不夹的话会算出负尺寸 */
  const k = Math.max(0, Math.min(1, t));

  const prevById = new Map(prev.map((n) => [n.id, n]));
  const nextById = new Map(next.map((n) => [n.id, n]));

  const mix = (a: number, b: number) => a + (b - a) * k;

  return next.map((to) => {
    const from = prevById.get(to.id);

    if (from) {
      /* 老节点：位置和尺寸都插值。六个根被撑开时走的就是这条路 */
      return {
        ...to,
        x: mix(from.x, to.x),
        y: mix(from.y, to.y),
        w: mix(from.w, to.w),
        h: mix(from.h, to.h),
      };
    }

    /*
      新节点：从父节点那儿长出来。
      起点是一个**退化的矩形**（宽高为 0，落在父节点中心）——
      这样它看起来是从父卡里"钻"出来再展开的，而不是淡入一个成品。
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

/**
 * 某个节点是不是这一帧新冒出来的。
 *
 * 渲染层用它决定透明度：新节点要 0 → 1 淡入，老节点一直是 1。
 * 单独抽出来是因为**"新"这件事只有比较两套布局才知道**，
 * 而 lerpLayout 的返回值里没有这个信息（它只给中间位置）。
 */
export function isNewNode(prev: readonly LaidNode[], id: string): boolean {
  return !prev.some((n) => n.id === id);
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