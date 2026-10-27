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
  labelTier,
  panBy,
  zoomAt,
  type Viewport,
} from "@/core/canvas/viewport";

/**
 * 无限画布：底下一张无限网格，可以拖、可以缩放，上面放世界坐标内容。
 *
 * 网格是两条 CSS 渐变画的，DOM 节点数为 0，平移缩放只改 background-position / size，
 * 所以开销只跟画布上有几个东西有关，跟画布多大无关。
 * 无限真正的风险是浮点精度（平移夹在 ±100000）、找不到北（回到原点按钮）、
 * 缩放失控（倍率夹在 0.2~4，滚轮以光标为锚点），三条都便宜地处理了。
 * “第 3 列第 2 行”靠初始视口表达，不画边框 —— 画了框就等于宣布画布有边界。
 */

export interface CanvasStageProps {
  /**
   * 原点标记。它是这套 UI 自身的位置参照，不是内容 ——
   * 没有它，“回到原点”按下去时画面没有任何可辨认的变化。
   */
  showOrigin?: boolean;
  /**
   * 画在世界坐标上的内容。子元素用世界坐标自己绝对定位，不需要关心平移缩放。
   * 内容层是画布的兄弟而不是子节点：画布本体挂着拖拽事件，
   * 内容放在里面的话，点一个节点会同时触发拖拽，手一抖点击就变成平移。
   * 兄弟层 pointer-events: none，节点自己开 auto，两个需求互不打架。
   */
  children?: React.ReactNode;
  /**
   * 打开时让这块世界区域完整落进视口。
   *
   * 不传就对准核心格（原来的行为）。
   */
  fitBounds?: { x: number; y: number; w: number; h: number };
  /** “回到原点”按钮去的地方。不传就是核心格 */
  homeBounds?: { x: number; y: number; w: number; h: number };
  /**
   * 自动适应的缩放下限。面板里给 0.62 左右：不设的话，一个 808×371 的面板
   * 会把六道工序缩到 48%，卡片上的字只剩 7 像素。
   */
  minFitScale?: number;
  /**
   * 聚焦到某块区域（双击一个节点时用）。传“值 + 计数器”而不是只传值：
   * 连点同一个节点两次，bounds 是同一个值，只看值第二次不会触发。
   * homeBounds 是状态，这个是事件。
   */
  focusRequest?: {
    bounds: { x: number; y: number; w: number; h: number };
    nonce: number;
  } | null;
  /**
   * “看全”按钮要装下的世界区域。它和 fitBounds / homeBounds 的区别是不看 minFitScale：
   * “看全”是用户明确说要看全局，那时读不清字是他自己选的代价，不是系统替他做的取舍。
   * 不传就不显示这个按钮 —— 面板那类用法说不出“看全”看的是什么全。
   */
  fitAllBounds?: { x: number; y: number; w: number; h: number };
  /**
   * 用户自己动过视口了（拖、滚、点缩放/回到原点/看全）。画布是视口的唯一主人，
   * 它只如实上报是谁引起的这次变化；是否继续自动聚焦由父组件决定（见 focus-follow.ts）。
   */
  onUserMoved?: () => void;
}

/**
 * 世界坐标层：一层 transform 把内容整体搬到该在的位置。
 *
 * 不给每个节点算屏幕坐标 —— 那样每帧平移都要逐个改几十个 left/top，
 * 而一层 transform 是一次样式写入，节点数量不影响平移代价。
 * 它和网格用同一套坐标约定（screen = world × scale + pan），写法不同、映射相同。
 * transform-origin 必须是 0 0，否则缩放绕中心转，内容会整片漂走。
 */
function WorldLayer({
  viewport,
  children,
}: {
  viewport: Viewport;
  children: React.ReactNode;
}) {
  return (
    <div
      data-canvas-world
      /*
        当前倍率下文字显示到哪一档，globals.css 按它决定藏哪些字。
        放在这一层是因为它是全局显示档位：各自算的话，边界上会出现
        “这张卡的字没了、旁边那张还在”。
      */
      data-label-tier={labelTier(viewport.scale)}
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
 * 原点十字。标的是核心格中心，不是世界坐标 (0,0) ——
 * 标错时肉眼看不出来，十字确实落在网格交点上，而“回到原点”会偏 400×240。
 */
function OriginMark() {
  return (
    <div
      aria-hidden
      data-canvas-origin
      className="absolute"
      style={{ left: HOME_WORLD.x, top: HOME_WORLD.y, width: 1, height: 1 }}
    >
      <span
        className="absolute block bg-slate-600"
        style={{ left: -7, top: 0, width: 15, height: 1 }}
      />
      <span
        className="absolute block bg-slate-600"
        style={{ left: 0, top: -7, width: 1, height: 15 }}
      />
    </div>
  );
}

export function CanvasStage({
  showOrigin = true,
  children,
  fitBounds,
  homeBounds,
  minFitScale = 0,
  focusRequest = null,
  fitAllBounds,
  onUserMoved,
}: CanvasStageProps) {
  const shellRef = useRef<HTMLDivElement>(null);
  /*
    视口初值给 0,0：服务端没有窗口尺寸，挂载后由 ResizeObserver 量出真实尺寸再对准。
  */
  const [viewport, setViewport] = useState<Viewport>({ panX: 0, panY: 0, scale: 1 });

  /*
    是否已经对准过。用 ref 而非 state：它只影响“要不要再对准”，
    不影响渲染结果，放进 state 会多一次重渲染。
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
        只在第一次对准。窗口尺寸变化时不动视口 ——
        否则用户拖动窗口边缘，画面会被一次次拽回原点，正在看的地方就丢了。
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
      必须用原生监听器并显式 passive: false。React 的 onWheel 是被动监听，
      在被动监听里调 preventDefault 会被忽略，结果是缩放的同时整页跟着滚。
    */
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      // 指数缩放：每 100 像素滚动 ≈ 1.15 倍。
      // 用乘法而不是加法，才不会“放大容易缩小难”
      const factor = Math.exp(-e.deltaY / 700);
      setViewport((vp) =>
        zoomAt(vp, e.clientX - rect.left, e.clientY - rect.top, factor),
      );
      /* 滚轮 = 用户自己在缩放。上报一次，父组件据此不再自动聚焦 */
      onUserMoved?.();
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [onUserMoved]);

  /* ---------- 拖拽平移 ---------- */
  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    // 只响应主键（左键）。右键要留给以后的右键菜单
    if (e.button !== 0) return;

    /*
      事件挂在外层容器上，所以画布上任何东西按下都会走到这里，包括缩放按钮和工序卡。
      这两类要显式排除：按钮按下要触发点击，工序卡按下要选中它，同时开始平移就都做不成了。
      用 closest 而不是判断 e.target 本身 —— 按钮和卡片里都有子元素，点到的往往是子元素。
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

  const endDrag = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      /*
        真的拖过才算“用户动过视口”。指针抬起时 draggingRef 是 null 的话，
        这一次只是普通点击，画布没动 —— 算进去的话，随手点一下界面就永久关掉了自动跟随。
      */
      if (draggingRef.current) onUserMoved?.();
      draggingRef.current = null;
      e.currentTarget.style.cursor = "grab";
    },
    [onUserMoved],
  );

  /* ---------- 按钮 ---------- */
  const zoomButton = useCallback(
    (factor: number) => {
      const el = shellRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      // 按钮缩放锚在视口中心 —— 光标不在画布上时，中心是唯一不别扭的锚点
      setViewport((vp) => zoomAt(vp, rect.width / 2, rect.height / 2, factor));
      // 用户自己按的缩放，和滚轮一样算"他接手了视口"
      onUserMoved?.();
    },
    [onUserMoved],
  );

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
    onUserMoved?.();
  }, [homeBounds, minFitScale, onUserMoved]);

  /*
    把整棵树装进视口，忽略 minFitScale（传 0）：按这个按钮就是一个明确的意图 ——
    “我要看全局”，这时再拿 0.45 卡住，就成了“点了看全，还是看不全”。

    代价是 1832×1064 的树装进 770×330 要缩到 20% 左右，工序名只剩 3 像素，
    所以按钮的 title 直接写“会很小，读不清字”—— 知道代价再点和点完发现被骗是两件事。
  */
  const fitAll = useCallback(() => {
    const el = shellRef.current;
    if (!el || !fitAllBounds) return;
    const rect = el.getBoundingClientRect();
    setViewport(fitViewport(fitAllBounds, rect.width, rect.height, 56, 0));
    onUserMoved?.();
  }, [fitAllBounds, onUserMoved]);

  const step = gridStepScreen(viewport.scale);

  /*
    聚焦请求：双击节点时父组件把“装下这棵子树”的区域发过来。
    只认 nonce —— 连点同一个节点时 bounds 是同一个值，只看值第二次不会触发。
  */
  const lastNonceRef = useRef(0);
  useEffect(() => {
    if (!focusRequest) return;
    if (focusRequest.nonce === lastNonceRef.current) return;
    lastNonceRef.current = focusRequest.nonce;

    const el = shellRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setViewport(
      fitViewport(focusRequest.bounds, rect.width, rect.height, 56, minFitScale),
    );
  }, [focusRequest, minFitScale]);

  return (
    /*
      指针和滚轮事件挂在**这一层**（外层容器），不是挂在画布本体上。
      世界坐标层是画布本体的兄弟，事件挂在本体上的话，鼠标在工序卡上时
      滚轮不缩放、拖拽不平移 —— 而工序卡正好占了屏幕中间一大片。
      挂在外层都收得到，再由 onPointerDown 里那条 closest 把按钮和卡片排除掉。
    */
    <div
      ref={shellRef}
      data-canvas-shell
      className="relative h-full w-full cursor-grab touch-none overflow-hidden bg-[var(--color-canvas)] select-none"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      /*
        双击空白处回到全局视口。双击工序会聚焦到那棵树（别的都出画了），
        进去之后只能靠找“回到原点”那个小按钮出来，这功能就会让人不敢用 ——
        进去容易出来难的功能没人用。双击空白是和“进去”完全对称的“出来”。
      */
      onDoubleClick={goHome}
    >
      {/* 网格：纯背景，不接事件 */}
      <div
        data-canvas-stage
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          /*
            网格：两条渐变，一条画竖线一条画横线。background-position 承接平移、
            background-size 承接缩放，所以平移缩放只是改样式，不产生任何 DOM 变化。
          */
          backgroundImage: `
            linear-gradient(to right, var(--grid-line) 1px, transparent 1px),
            linear-gradient(to bottom, var(--grid-line) 1px, transparent 1px)
          `,
          backgroundSize: `${step}px ${step}px`,
          backgroundPosition: `${viewport.panX}px ${viewport.panY}px`,
        }}
      >
        {/* 原点标记。极淡的一个十字，只为让“回到原点”有可见的落点 */}
      </div>

      {/* 世界坐标层：画布上的内容都长在这一层里 */}
      <WorldLayer viewport={viewport}>
        {showOrigin && <OriginMark />}
        {children}
      </WorldLayer>

      {/*
        操作提示放左上角：左下角是 Next.js 开发浮标的位置，会和它叠住；
        右上角有缩放控件，右下角留给状态栏。pointer-events-none，不该挡住拖拽。
      */}
      <div className="pointer-events-none absolute top-3 left-4 text-[11px] leading-relaxed text-slate-600">
        拖动平移 · 滚轮缩放
      </div>

      {/* 右下角缩放控制 */}
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
          className="min-w-[52px] rounded-full px-2 py-1 text-[11.5px] text-slate-300 tabular-nums transition-colors duration-150 hover:bg-slate-700/50 hover:text-slate-100"
        >
          {formatScale(viewport.scale)}
        </button>

        {/*
          挨着倍率按钮放。它和“回到原点”是一对相反的出口：一个看得清但看不全，
          一个装下整棵树但读不清字。把代价写在 title 里 —— 知道了再点和被骗着点是两件事。
        */}
        {fitAllBounds && (
          <button
            type="button"
            onClick={fitAll}
            data-canvas-fit-all
            title="装下整棵树（会很小，读不清字）"
            className="rounded-full px-2 py-1 text-[11.5px] text-slate-400 transition-colors duration-150 hover:bg-slate-700/50 hover:text-slate-100"
          >
            看全
          </button>
        )}

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
