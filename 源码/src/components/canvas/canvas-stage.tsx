"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  HOME_WORLD,
  MAX_SCALE,
  MIN_SCALE,
  formatScale,
  fitViewport,
  gridStepScreen,
  homeViewport,
  panBy,
  zoomAt,
  type Viewport,
} from "@/core/canvas/viewport";

/**
 * 无限画布
 * ============================================================
 * 底下一张无限网格，可以拖、可以缩放。**上面什么都没有** ——
 * 没有流程、没有节点、没有任何内容。
 *
 * ── 为什么「无限」几乎不花钱 ──
 *   网格是两条 CSS 渐变画的（一横一竖），浏览器在合成层里铺，
 *   **DOM 节点数 = 0，每帧 JS 开销 = 0**。
 *   内容将来是绝对定位的 div，有几个节点就几个。
 *   所以内存和渲染开销只跟「画布上有几个东西」有关，
 *   跟画布有多大**完全无关**。
 *
 *   反过来说：一张 5×6 的有限画布，如果真用 30 个 div 铺格子，
 *   反而比无限画布更贵。所以没理由为了省空间把它做成有限的。
 *
 *   无限真正的风险是另外三条，都便宜地处理了：
 *     浮点精度 → 平移夹在 ±100000（见 viewport.ts 的 PAN_LIMIT）
 *     找不到北 → 一个「回到原点」按钮
 *     缩放失控 → 倍率夹在 0.2~4，且滚轮以光标为锚点
 *
 * ── 关于「第 3 列第 2 行」──
 *   这件事是通过**初始视口**表达的：打开时让那一格落在
 *   屏幕水平正中、纵向偏上（0.34）。下面留出三分之二屏，
 *   以后往下长内容不用先平移。
 *   之所以不画一个 5×6 的框：画了框就等于宣布画布有边界，
 *   而后面要往上、往左、往右长东西的时候，那个框会变成谎话。
 */

export interface CanvasStageProps {
  /**
   * 原点标记。默认开。
   *
   * 为什么画布是空的却要留一个标记：
   *   「回到原点」这个按钮如果按下去画面没有任何可辨认的变化，
   *   用户没法判断它到底生效了没有。一个极淡的十字就够了 ——
   *   它不是内容，是**这套 UI 自身的位置参照**。
   *   不想要的话传 false。
   */
  showOrigin?: boolean;
  /**
   * 画在世界坐标上的内容。
   *
   * ── 怎么用 ──
   *   子元素用世界坐标自己绝对定位（`left: worldX`），
   *   不需要关心当前的平移缩放 —— 那一层由画布负责。
   *
   * ── 为什么内容层是画布的**兄弟**而不是子节点 ──
   *   画布本体挂着拖拽的指针事件（按下就 pan）。
   *   内容放在它里面的话，点一个节点会同时触发拖拽 ——
   *   手一抖，点击就变成了平移。
   *
   *   拆成兄弟之后：内容层 `pointer-events: none`（拖拽照常穿透到画布），
   *   而节点自己开 `pointer-events: auto`（点得着）。
   *   两个需求互不打架。
   */
  children?: React.ReactNode;
  /**
   * 打开时让这块世界区域完整落进视口。
   *
   * 不传就对准核心格（原来的行为）。
   */
  fitBounds?: { x: number; y: number; w: number; h: number };
  /** 「回到原点」按钮去的地方。不传就是核心格 */
  homeBounds?: { x: number; y: number; w: number; h: number };
  /**
   * 自动适应的缩放下限。
   *
   * 面板里要给一个值（0.62 左右）—— 不设的话，一个 808×371 的面板
   * 会把六道工序缩到 48%，卡片上字 7 像素，读不清。
   * 见 fitViewport 里那段说明。
   */
  minFitScale?: number;
}

/**
 * 世界坐标层
 * ============================================================
 * 一层 `transform` 把所有内容整体搬到该在的位置。
 *
 * ── 为什么是一层 transform，而不是给每个节点算屏幕坐标 ──
 *   算屏幕坐标的话，**每帧平移都要逐个改几十个节点的 left/top** ——
 *   每个都是一次样式写入，节点多了会掉帧。
 *
 *   一层 transform 是**一次**样式写入，浏览器在合成层里整体搬，
 *   节点数量完全不影响平移的代价。
 *
 * ── 它和网格为什么不会错位 ──
 *   两者用的是同一套坐标约定（见 core/canvas/viewport.ts）：
 *     screen = world × scale + pan
 *   网格用 background-position: (panX, panY) 且 background-size: CELL×scale 表达它；
 *   这一层用 translate(panX, panY) scale(scale) 加 transform-origin: 0 0 表达它。
 *   写法不同，算出来的是同一个映射。
 *
 *   ⚠️ transform-origin 必须是 0 0（默认是 50% 50%）。
 *      用默认值的话，缩放会绕着自己的中心转 ——
 *      表现是"滚轮缩放时内容整片漂走"，而且缩得越大漂得越远。
 */
function WorldLayer({ viewport, children }: { viewport: Viewport; children: React.ReactNode }) {
  return (
    <div
      data-canvas-world
      className="pointer-events-none absolute top-0 left-0 origin-top-left"
      style={{
        transform: `translate(${viewport.panX}px, ${viewport.panY}px) scale(${viewport.scale})`,
      }}
    >
      {children}
    </div>
  );
}

/**
 * 原点十字
 * ============================================================
 * ⚠️ 标的是**核心格中心**，不是世界坐标 (0,0)。
 *
 * 第一版写的是 `left: viewport.panX` —— 那是世界原点 (0,0) 的屏幕位置。
 * 而「回到原点」按钮去的是核心格（世界坐标 400, 240）。
 * 两个点差了 400×240 像素，于是**按钮按下去画面动了一大截，
 * 十字却不在视野中心** —— 一个自己打自己的 UI。
 *
 * 标错的地方肉眼看不出来：十字确实在网格的某个交点上，
 * 看起来完全正常。是拿具体数字算了一遍才对上账的。
 */
function OriginMark() {
  /*
    ⚠️ 标的是**核心格中心**，不是世界坐标 (0,0)。

    第一版写的是 `left: viewport.panX` —— 那是世界原点 (0,0) 的屏幕位置。
    而「回到原点」按钮去的是核心格（世界坐标 400, 240）。
    两个点差了 400×240 像素，于是**按钮按下去画面动了一大截，
    十字却不在视野中心** —— 一个自己打自己的 UI。

    标错的地方肉眼看不出来：十字确实在网格的某个交点上，
    看起来完全正常。是拿具体数字算了一遍才对上账的。

    现在它在世界坐标层里，所以直接写世界坐标就行 ——
    屏幕位置由那一层负责，这里不再自己算一遍。
  */
  return (
    <div
      aria-hidden
      data-canvas-origin
      className="absolute"
      style={{ left: HOME_WORLD.x, top: HOME_WORLD.y, width: 1, height: 1 }}
    >
      <span className="absolute block bg-slate-600" style={{ left: -7, top: 0, width: 15, height: 1 }} />
      <span className="absolute block bg-slate-600" style={{ left: 0, top: -7, width: 1, height: 15 }} />
    </div>
  );
}

export function CanvasStage({
  showOrigin = true,
  children,
  fitBounds,
  homeBounds,
  minFitScale = 0,
}: CanvasStageProps) {
  const shellRef = useRef<HTMLDivElement>(null);
  /*
    视口初值给 0,0 —— 服务端没有窗口尺寸，只能先给个中间值，
    挂载后由 ResizeObserver 量出真实尺寸再对准。
  */
  const [viewport, setViewport] = useState<Viewport>({ panX: 0, panY: 0, scale: 1 });

  /*
    是否已经对准过。
    用 ref 而不是 state：它只影响「要不要再对准」，
    不影响渲染结果，放进 state 会多一次无谓的重渲染。
  */
  const placedRef = useRef(false);
  const draggingRef = useRef<{ x: number; y: number } | null>(null);

  /* ---------- 量尺寸并对准 ---------- */
  useEffect(() => {
    const el = shellRef.current;
    if (!el) return;

    /** 打开时对准哪儿：给了区域就装下它，没给就对准核心格 */
    const initial = (w: number, h: number) =>
      fitBounds ? fitViewport(fitBounds, w, h, 56, minFitScale) : homeViewport(w, h);

    const observer = new ResizeObserver(() => {
      const rect = el.getBoundingClientRect();
      /*
        只在第一次对准。
        窗口尺寸变化时**不动视口** —— 否则用户拖动窗口边缘，
        画面会被一次次拽回原点，正在看的地方就丢了。
      */
      if (placedRef.current) return;
      placedRef.current = true;
      setViewport(initial(rect.width, rect.height));
    });

    observer.observe(el);
    return () => observer.disconnect();
    // fitBounds 是常量对象，但写成依赖会每次渲染都重跑 —— 只在挂载时对一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------- 滚轮缩放 ---------- */
  useEffect(() => {
    const el = shellRef.current;
    if (!el) return;

    /*
      必须用原生监听器并显式 passive: false。
      React 的 onWheel 是挂在根节点上的被动监听，
      在被动监听里调 preventDefault 会被浏览器忽略 ——
      结果是「缩放的同时整页跟着滚」，一个很别扭的手感。
    */
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      // 指数缩放：每 100 像素滚动 ≈ 1.15 倍。
      // 用乘法而不是加法，才不会「放大容易缩小难」
      const factor = Math.exp(-e.deltaY / 700);
      setViewport((vp) =>
        zoomAt(vp, e.clientX - rect.left, e.clientY - rect.top, factor),
      );
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  /* ---------- 拖拽平移 ---------- */
  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    // 只响应主键（左键）。右键要留给以后的右键菜单
    if (e.button !== 0) return;

    /*
      ⚠️ 事件挂在外层容器上，所以画布上的**任何**东西按下都会走到这里 ——
      包括缩放按钮和工序卡。这两类要显式排除：

        按钮   按下要触发点击，同时开始平移的话，手一抖按钮就点不中了
        工序卡 按下要选中它，同时开始平移的话，点击会变成拖拽

      用 closest 而不是判断 e.target 本身：按钮和卡片里都有子元素
      （文字、图标），点到的往往是子元素。
    */
    if ((e.target as HTMLElement).closest("button, [data-pipeline-stage]")) return;

    draggingRef.current = { x: e.clientX, y: e.clientY };
    // 捕获指针：拖到画布外面（甚至窗口外）也不会断
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.style.cursor = "grabbing";
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const from = draggingRef.current;
    if (!from) return;
    setViewport((vp) => panBy(vp, e.clientX - from.x, e.clientY - from.y));
    draggingRef.current = { x: e.clientX, y: e.clientY };
  }, []);

  const endDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = null;
    e.currentTarget.style.cursor = "grab";
  }, []);

  /* ---------- 按钮 ---------- */
  const zoomButton = useCallback((factor: number) => {
    const el = shellRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    // 按钮缩放锚在视口中心 —— 光标不在画布上时，中心是唯一不别扭的锚点
    setViewport((vp) => zoomAt(vp, rect.width / 2, rect.height / 2, factor));
  }, []);

  const goHome = useCallback(() => {
    const el = shellRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    // 有 homeBounds 就回到"装下那块区域"的视口，否则回到核心格
    setViewport(
      homeBounds
        ? fitViewport(homeBounds, rect.width, rect.height, 56, minFitScale)
        : homeViewport(rect.width, rect.height),
    );
  }, [homeBounds, minFitScale]);

  const step = gridStepScreen(viewport.scale);

  return (
    /*
      ⚠️ 指针和滚轮事件挂在**这一层**（外层容器），不是挂在画布本体上。

      原因：世界坐标层是画布本体的**兄弟**（见上面的说明）。
      事件挂在画布本体上的话，鼠标在工序卡上时 ——
      滚轮不缩放、拖拽不平移，因为它们根本走不到画布本体。
      而工序卡正好占了屏幕中间一大片，问题很显眼。

      挂在外层就都收得到（事件冒泡会经过这里），
      再由 onPointerDown 里那条 closest 判断把按钮和卡片排除掉。
    */
    <div
      ref={shellRef}
      data-canvas-shell
      className="relative h-full w-full cursor-grab touch-none overflow-hidden bg-[var(--color-canvas)] select-none"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      {/* ---------- 网格（纯背景，不接事件） ---------- */}
      <div
        data-canvas-stage
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          /*
            网格：两条渐变，一条画竖线一条画横线。
            用 background-position 承接平移、background-size 承接缩放 ——
            所以平移缩放都只是改样式，**不产生任何 DOM 变化**，
            也就不会有重排。这是无限网格能免费的原因。
          */
          backgroundImage: `
            linear-gradient(to right, var(--grid-line) 1px, transparent 1px),
            linear-gradient(to bottom, var(--grid-line) 1px, transparent 1px)
          `,
          backgroundSize: `${step}px ${step}px`,
          backgroundPosition: `${viewport.panX}px ${viewport.panY}px`,
        }}
      >
        {/* 原点标记。极淡的一个十字，只为让「回到原点」有可见的落点 */}
      </div>

      {/* ---------- 世界坐标层：画布上的内容都长在这一层里 ---------- */}
      <WorldLayer viewport={viewport}>
        {showOrigin && <OriginMark />}
        {children}
      </WorldLayer>

      {/*
        ---------- 操作提示 ----------
        放在**左上角**而不是左下角：
        左下角是 Next.js 开发浮标的位置（dev 模式下常驻），
        两样东西叠在一起会互相盖住 —— 截图里就是这么发现的。
        右上角有缩放控件，右下角留给以后的状态栏，所以选左上。

        它是 pointer-events-none 的：只是提示，不该挡住拖拽。
      */}
      <div className="pointer-events-none absolute top-3 left-4 text-[11px] leading-relaxed text-slate-600">
        拖动平移 · 滚轮缩放
      </div>

      {/* ---------- 右下角缩放控制 ---------- */}
      <div className="absolute right-4 bottom-4 flex items-center gap-1 rounded-full border border-[var(--color-border-soft)] bg-[var(--color-surface)]/90 px-1.5 py-1 backdrop-blur">
        <button
          type="button"
          onClick={() => zoomButton(1 / 1.25)}
          disabled={viewport.scale <= MIN_SCALE}
          aria-label="缩小"
          className="flex h-7 w-7 items-center justify-center rounded-full text-[14px] leading-none text-slate-400 transition-colors duration-150 hover:bg-slate-700/50 hover:text-slate-100 disabled:opacity-30 disabled:hover:bg-transparent"
        >
          −
        </button>

        <button
          type="button"
          onClick={goHome}
          title="回到原点（第 3 列第 2 行）"
          data-canvas-zoom
          className="min-w-[52px] rounded-full px-2 py-1 text-[11.5px] tabular-nums text-slate-300 transition-colors duration-150 hover:bg-slate-700/50 hover:text-slate-100"
        >
          {formatScale(viewport.scale)}
        </button>

        <button
          type="button"
          onClick={() => zoomButton(1.25)}
          disabled={viewport.scale >= MAX_SCALE}
          aria-label="放大"
          className="flex h-7 w-7 items-center justify-center rounded-full text-[14px] leading-none text-slate-400 transition-colors duration-150 hover:bg-slate-700/50 hover:text-slate-100 disabled:opacity-30 disabled:hover:bg-transparent"
        >
          +
        </button>
      </div>
    </div>
  );
}