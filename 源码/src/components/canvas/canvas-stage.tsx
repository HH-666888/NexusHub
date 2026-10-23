"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  HOME_WORLD,
  MAX_SCALE,
  MIN_SCALE,
  formatScale,
  gridStepScreen,
  homeViewport,
  panBy,
  worldToScreen,
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
function OriginMark({ viewport }: { viewport: Viewport }) {
  const p = worldToScreen(viewport, HOME_WORLD.x, HOME_WORLD.y);
  return (
    <div
      aria-hidden
      data-canvas-origin
      className="pointer-events-none absolute"
      style={{ left: p.x, top: p.y, width: 1, height: 1 }}
    >
      <span className="absolute block bg-slate-600" style={{ left: -7, top: 0, width: 15, height: 1 }} />
      <span className="absolute block bg-slate-600" style={{ left: 0, top: -7, width: 1, height: 15 }} />
    </div>
  );
}

export function CanvasStage({ showOrigin = true }: CanvasStageProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  /*
    视口初值给 0,0 —— 服务端没有窗口尺寸，只能先给个中间值，
    挂载后由 ResizeObserver 量出真实尺寸再对准核心格。
  */
  const [viewport, setViewport] = useState<Viewport>({ panX: 0, panY: 0, scale: 1 });

  /*
    是否已经对准过核心格。
    用 ref 而不是 state：它只影响「要不要再对准」，
    不影响渲染结果，放进 state 会多一次无谓的重渲染。
  */
  const placedRef = useRef(false);
  const draggingRef = useRef<{ x: number; y: number } | null>(null);

  /* ---------- 量尺寸并对准核心格 ---------- */
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;

    const observer = new ResizeObserver(() => {
      const rect = el.getBoundingClientRect();
      /*
        只在第一次对准。
        窗口尺寸变化时**不动视口** —— 否则用户拖动窗口边缘，
        画面会被一次次拽回原点，正在看的地方就丢了。
      */
      if (placedRef.current) return;
      placedRef.current = true;
      setViewport(homeViewport(rect.width, rect.height));
    });

    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  /* ---------- 滚轮缩放 ---------- */
  useEffect(() => {
    const el = stageRef.current;
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
    const el = stageRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    // 按钮缩放锚在视口中心 —— 光标不在画布上时，中心是唯一不别扭的锚点
    setViewport((vp) => zoomAt(vp, rect.width / 2, rect.height / 2, factor));
  }, []);

  const goHome = useCallback(() => {
    const el = stageRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setViewport(homeViewport(rect.width, rect.height));
  }, []);

  const step = gridStepScreen(viewport.scale);

  return (
    <div className="relative h-full w-full overflow-hidden bg-[var(--color-canvas)]">
      {/* ---------- 画布本体 ---------- */}
      <div
        ref={stageRef}
        data-canvas-stage
        className="absolute inset-0 cursor-grab touch-none select-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
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
        {showOrigin && <OriginMark viewport={viewport} />}
      </div>

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