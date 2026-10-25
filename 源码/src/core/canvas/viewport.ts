/**
 * 画布的视口数学
 * ============================================================
 * 全部是纯函数 —— 没有 DOM、没有 React、没有副作用。
 * 平移和缩放的坐标换算最容易出错，而且错了之后表现为
 * 「缩放时内容往旁边跑」，很难靠肉眼定位。
 * 抽成纯函数就能用测试钉住：锚点不动、边界夹紧、来回换算可逆。
 *
 * ── 坐标约定 ──
 *   世界坐标（world）：画布上的逻辑坐标，加一个节点就是定在那儿的数
 *   屏幕坐标（screen）：相对视口左上角的像素
 *
 *     screen = world * scale + pan
 *     world  = (screen - pan) / scale
 *
 *   选这个写法而不是「偏移 + 缩放」的另一种顺序，是因为
 *   缩放要以光标为锚点时，反解 world 只要一步减法，不容易写错。
 */

export interface Viewport {
  /** 平移量，单位是屏幕像素 */
  panX: number;
  panY: number;
  /** 缩放倍率。1 = 原始大小 */
  scale: number;
}

/** 网格一格的世界尺寸。跟首页项目卡片一样大，视觉上有延续感 */
export const CELL = 160;

/**
 * 「核心格」——第 3 列第 2 行（都从 1 开始数）。
 *
 * 为什么核心格不在正中：
 *   流水线是**从上往下**长的（后面还要往下加东西），
 *   把起点放在偏上、居中偏左的位置，右边和下边都留着空，
 *   用户第一次拖动时不会立刻撞到边界感。
 *
 * 为什么是第 3 列：
 *   5 列里第 3 列就是中间那列。用户要求的就是这里。
 */
export const HOME_COL = 3;
export const HOME_ROW = 2;

/** 核心格中心的世界坐标 */
export const HOME_WORLD = {
  x: (HOME_COL - 0.5) * CELL,
  y: (HOME_ROW - 0.5) * CELL,
} as const;

/* ============================================================
   缩放
   ============================================================ */

export const MIN_SCALE = 0.2;
export const MAX_SCALE = 4;

/**
 * 缩放倍率夹紧。越界会让内容小到看不见或大到只剩一个角
 *
 * Infinity 与 NaN 要分开处理：
 *   Infinity 是一个「太大了」的数，夹到上限就对了；
 *   NaN 根本不是数，夹到哪都没有依据，退回 1（原始大小）。
 * 一开始这两种情况共用了一个判断，于是 Infinity 被退成了 1 ——
 * 表现是「缩放算法出问题时画面突然跳回 100%」，
 * 比停在上限难查得多。
 */
export function clampScale(scale: number): number {
  if (Number.isNaN(scale)) return 1;
  if (scale === Infinity) return MAX_SCALE;
  if (scale === -Infinity) return MIN_SCALE;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/**
 * 平移的软边界。
 *
 * ── 为什么一个「无限画布」要夹住平移 ──
 *   不是为了省内存 —— 网格是 CSS 画的，画布多大都不占 DOM。
 *   夹住是两个实际原因：
 *     一、浮点精度：一直往一个方向拖，坐标到 10^7 量级时
 *         相邻像素的差值开始被浮点吃掉，画面会抖；
 *     二、会迷路：无限画布没有边界，拖远了以后
 *        「回到原点」按钮是唯一的出路，但用户未必想到去点。
 *
 *   100000 像素 ≈ 625 格，几十个节点的流水线永远用不到 ——
 *   所以它**用起来就是无限的**，只是不会真的飘到无穷远。
 */
export const PAN_LIMIT = 100_000;

export function clampPan(v: number): number {
  // 同 clampScale：Infinity 夹到边界，NaN 才是「没有依据」
  if (Number.isNaN(v)) return 0;
  if (v === Infinity) return PAN_LIMIT;
  if (v === -Infinity) return -PAN_LIMIT;
  return Math.min(PAN_LIMIT, Math.max(-PAN_LIMIT, v));
}

/* ============================================================
   换算
   ============================================================ */

export function worldToScreen(vp: Viewport, wx: number, wy: number) {
  return { x: wx * vp.scale + vp.panX, y: wy * vp.scale + vp.panY };
}

export function screenToWorld(vp: Viewport, sx: number, sy: number) {
  return { x: (sx - vp.panX) / vp.scale, y: (sy - vp.panY) / vp.scale };
}

/**
 * 以某个屏幕点为锚点缩放 —— **那个点下面的内容不动**。
 *
 * 这是画布手感好坏的分水岭：
 *   不以光标为锚点的话，滚轮缩放时内容会朝视口中心跑，
 *   用户想放大看某个角落，得「缩放一次、平移一次」反复挪。
 *
 * 做法：先把锚点换算成世界坐标，改完倍率再反推 pan，
 * 让同一个世界点仍然落在同一个屏幕点上。
 */
export function zoomAt(
  vp: Viewport,
  anchorScreenX: number,
  anchorScreenY: number,
  factor: number,
): Viewport {
  const next = clampScale(vp.scale * factor);
  // 已经顶到上下限时直接原样返回：否则继续滚会持续改 pan，
  // 表现为「缩不动了但画面还在慢慢漂」
  if (next === vp.scale) return vp;

  const w = screenToWorld(vp, anchorScreenX, anchorScreenY);
  return {
    scale: next,
    panX: clampPan(anchorScreenX - w.x * next),
    panY: clampPan(anchorScreenY - w.y * next),
  };
}

/** 平移。delta 是屏幕像素 */
export function panBy(vp: Viewport, dx: number, dy: number): Viewport {
  return {
    ...vp,
    panX: clampPan(vp.panX + dx),
    panY: clampPan(vp.panY + dy),
  };
}

/**
 * 让某个世界坐标落在视口正中的初始视口。
 *
 * 打开画布时用这个对准核心格 —— 于是「第 3 列第 2 行」
 * 这件事是通过**初始视口**表达的，而不是通过画一个 5×6 的框。
 * 区别在于：前者不妨碍以后往任何方向长，后者会。
 */
export function viewportCenteredOn(
  wx: number,
  wy: number,
  viewportW: number,
  viewportH: number,
  scale = 1,
): Viewport {
  const s = clampScale(scale);
  return {
    scale: s,
    panX: clampPan(viewportW / 2 - wx * s),
    panY: clampPan(viewportH / 2 - wy * s),
  };
}

/**
 * 打开画布时，核心格落在视口的**纵向什么位置**。
 *
 * ── 为什么不是 0.5（正中）──
 *   流水线是从上往下长的。
 *   核心格放正中，下半屏立刻就不够用，用户往下加东西时
 *   得先平移一次才看得到，第一次用的手感就是「怎么顶到底了」。
 *   放在 0.34，下面留出约三分之二屏 —— 加三四层都不用挪。
 *
 * 横向仍然是正中（0.5）：左右是并列展开的，两边都该有余地。
 */
export const HOME_SCREEN_Y_RATIO = 0.34;

/** 回到核心格。对应界面上那个「回到原点」 */
export function homeViewport(viewportW: number, viewportH: number, scale = 1): Viewport {
  const s = clampScale(scale);
  return {
    scale: s,
    panX: clampPan(viewportW / 2 - HOME_WORLD.x * s),
    panY: clampPan(viewportH * HOME_SCREEN_Y_RATIO - HOME_WORLD.y * s),
  };
}

/**
 * 让一块世界区域**完整落进视口**。
 *
 * ── 为什么需要它，而不是固定一个倍率 ──
 *   流水线是 1840 宽。窗口 1440 时要缩到 0.78 才看得全，
 *   窗口 2560 时又该是 1（甚至更大）。写死一个倍率的话，
 *   小屏上看不全、大屏上白白缩得很小 —— 两头都不合适。
 *
 * ── 上下留白为什么不一样 ──
 *   横向两侧各留 `padding`；纵向**上方留得多、下方留得少**。
 *   因为回退边是从节点下方绕出去的（见 pipeline-layout 的 FALLBACK_DROP）——
 *   下方不给够空间，那几条弧线会被切在屏幕外，
 *   而它们是这张图上最该被看见的东西之一。
 */
export function fitViewport(
  bounds: { x: number; y: number; w: number; h: number },
  viewportW: number,
  viewportH: number,
  padding = 56,
  /**
   * 缩放的**下限**。自动适应不允许缩到这个值以下。
   *
   * ── 为什么需要这条底线 ──
   *   工作台面板只有 808×371。摆成三列两行之后内容高 544，
   *   自动适应算出 48% —— 六个节点全都看见了，
   *   可卡片在屏幕上只有 114×74，**字 7 像素，读不清**。
   *
   *   也就是说"全都看见"和"看得清"在这里是矛盾的，
   *   而自动适应**只顾了前者**。一份看不清的全景图等于没看。
   *
   *   所以：宁可让用户平移一下（这本来就是无限画布该干的事），
   *   也不把字缩到读不出来。缩放到全部仍然可以手动做 ——
   *   右下角那个倍率按钮就是干这个的，而且是**用户主动**选的。
   */
  minScale = 0,
): Viewport {
  // 空区域没有"适合"可言，退回核心格 —— 不然会算出 Infinity
  if (bounds.w <= 0 || bounds.h <= 0) return homeViewport(viewportW, viewportH);

  const usableW = Math.max(1, viewportW - padding * 2);
  const usableH = Math.max(1, viewportH - padding * 2);
  const fitted = Math.min(usableW / bounds.w, usableH / bounds.h);
  const s = clampScale(Math.max(fitted, minScale));

  const cx = bounds.x + bounds.w / 2;
  const cy = bounds.y + bounds.h / 2;

  /*
    纵向对齐分两种情况 —— 这是被截图逼出来的：

      装得下    按 0.34 放（和 homeViewport 同一个理由：下面还要长东西）
      装不下    按**顶对齐**放（上边留一个 padding）

    一律用 0.34 的话，内容比视口高的时候会从中间对齐 ——
    上半截被推到可视区外，用户第一眼看到的是一排**被切掉头的卡片**。
    比缩小更糟：缩小至少还看得见全貌，切头是什么都看不出来。
  */
  const contentH = bounds.h * s;
  const fits = contentH <= viewportH - padding * 2;

  return {
    scale: s,
    panX: clampPan(viewportW / 2 - cx * s),
    panY: clampPan(fits ? viewportH * HOME_SCREEN_Y_RATIO - cy * s : padding - bounds.y * s),
  };
}

/* ============================================================
   显示
   ============================================================ */

/** 倍率显示成百分比。整数不带小数点，省得写「100.0%」 */
export function formatScale(scale: number): string {
  const pct = scale * 100;
  return `${Number.isInteger(pct) ? pct : pct.toFixed(0)}%`;
}

/* ============================================================
   低缩放时，字该让位
   ============================================================ */

/**
 * 次要文字（产物名、看什么数、权限标签、花费）保留到多少倍率。
 *
 * 卡片 240 宽，正文 10.5px。0.62 × 10.5 ≈ 6.5px —— 再小就是一层灰糊，
 * 看着像渲染坏了，而不像「故意缩小」。
 */
export const LABEL_MINOR_SCALE = 0.62;

/**
 * 主要文字（工序名、序号、状态）保留到多少倍率。
 *
 * 工序名 15px。0.45 × 15 ≈ 6.7px —— 同样道理。
 */
export const LABEL_MAJOR_SCALE = 0.45;

/** 当前倍率下，文字该显示到哪一档 */
export type LabelTier = "all" | "major" | "none";

/**
 * 按倍率决定文字的显示档位。
 *
 * ── 为什么这不是「按缩放折叠内容」那套 LOD ──
 *   有人提过按缩放级别折叠**子树**（50% 只显示一层的数量、35% 只剩根）。
 *   那个被否掉了，理由站得住：**画布的价值恰恰在于
 *   「看不清全貌时看形状，要看内容时放大」** ——
 *   拿「全屏可读」当验收标准本身就是错的。
 *
 *   但**文字**是另一回事。形状、边框、颜色在缩小后仍然成立，
 *   而 6 像素的字不成立 —— 它不是"小一号的信息"，是噪点。
 *   一张缩小后每张卡片上都糊着一层灰渣的图，比一片干净的色块难看得多，
 *   也难懂得对。
 *
 *   所以这里藏的是**字**，不是信息：
 *     色块、边框、状态色全都留着（这才是"看位置"要的东西），
 *     放大一点，字自己就回来了。
 *
 *   ⚠️ 实现上用的是 `color: transparent` 而不是 `display: none` ——
 *      屏幕阅读器用户不经历"缩放"这件事，对他们信息必须还在。
 *      见 globals.css 里那条规则上的说明。
 */
export function labelTier(scale: number): LabelTier {
  if (scale >= LABEL_MINOR_SCALE) return "all";
  if (scale >= LABEL_MAJOR_SCALE) return "major";
  return "none";
}

/**
 * 网格一格在屏幕上占多少像素。
 *
 * ── 结论：不做「缩小时换更粗的格」那套 LOD ──
 *   一开始写了 LOD（间距太小就翻倍画），写完发现两个问题：
 *
 *   一、**它几乎用不到。** 最小倍率 0.2 × CELL = 32px，
 *      本来就够清楚，不是「糊成一片」。LOD 只在 0.2~0.25 这一段
 *      极窄的区间里起作用。
 *
 *   二、**它会制造锯齿。** LOD 的间距必然在 [T, 2T) 之间来回跳：
 *         scale 0.2 → 翻倍 → 64
 *         scale 0.3 → 不翻 → 48      ← 放大反而更密
 *      也就是说轻微放大时，网格会突然变密一次。
 *      所有用 LOD 的画布都有这个现象，靠两层网格交叉淡入淡出来掩盖 ——
 *      那套东西的复杂度远超它在这里的价值。
 *
 *   所以：间距就是 `CELL × 倍率`，单调、可预测、没有意外。
 *   缩小时间距跟着变小 —— 那本来就是「你缩远了」的正确表达。
 *
 *   （这个决定是被测试逼出来的：写了一条「倍数越大格子只会更疏」
 *     的单调性断言，它红了，才发现 LOD 和这条性质天然冲突。）
 */
export function gridStepScreen(scale: number): number {
  return CELL * clampScale(scale);
}