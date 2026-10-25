"use client";

import { useCallback, useMemo, type CSSProperties } from "react";
import { tintVarAt } from "@/core/domain/appearance";
import { actorBadge } from "@/core/pipeline/authority";
import type { GateOverride } from "@/core/pipeline/gate-policy";
import type { PipelineNode } from "@/core/pipeline/graph";
import {
  PIPELINE_GEOMETRY,
  flowArrowAt,
  flowPath,
  type CanvasPipelineGeometry,
  type NodeRect,
} from "@/core/canvas/pipeline-layout";
import {
  FOREST_GEOMETRY,
  layoutForest,
  type ForestGeometry,
} from "@/core/canvas/forest-layout";
import {
  childIndex,
  toLayoutNodes,
  type ChildrenByStage,
  type StageChild,
} from "@/core/pipeline/forest";
import type { StageId } from "@/core/pipeline/stages";

/**
 * 画布上的六道工序
 * ============================================================
 * 这张图以前是 React Flow 画的。现在自己画 —— 一行六个节点、
 * 顺序流转的实线、失败回退的弧线，全都落在画布的世界坐标上。
 *
 * ── 为什么自己画是值得的 ──
 *   一、**位置可以说清楚。** 每个节点的世界坐标由纯函数给，
 *       于是"第三道在哪儿"是一个能断言的数，而不是一个库的内部实现。
 *   二、**回退边能画成它该有的样子。** React Flow 的边只能从
 *       预设的手柄出来，绕行要么画不圆、要么得自己塞一个自定义边；
 *       这里一条二次贝塞尔就够了。
 *   三、少一个运行时依赖。
 *
 * ── 图上放什么，有一条硬约束 ──
 *   只放**真实存在**的东西。
 *   没接入的工序照样画出来，但状态如实标成「未接入」且不参与进度推算；
 *   没有产物就不显示产物大小，没有耗时就不显示耗时。
 *   图比列表更容易让人相信「这里真的有东西」，所以更不能画假的。
 */

export interface PipelineCanvasProps {
  nodes: readonly PipelineNode[];
  /** 高亮的节点。点了某个节点之后，整条上下游链上的都是它 */
  chain?: ReadonlySet<StageId> | null;
  activeId?: StageId | null;
  onPick?: (id: StageId) => void;
  gateOverride?: GateOverride;
  /**
   * 摆几行。
   *
   * 整页画布给 WIDE（一行六个），工作台面板给 PANEL（三列两行）。
   * 面板只有 830 宽，一行六个会被自动缩到 37% —— 六个都看见了，
   * 可字看不清，等于白看。一行放不下就该换行。
   */
  geometry?: CanvasPipelineGeometry;
  /**
   * 每一步**内部**产出了什么 —— 画成挂在它下面的子节点。
   *
   * 现在只有「验收与交付」有：七项检查，来自事件日志里
   * kind:"check" 那条（纯本地正则跑的确定结果，不是 AI 生成的）。
   * 别的五步没有产物可拆，就不给 —— 空着是实话。
   *
   * 不给的话六道工序就是六个孤立的根节点，和以前一样。
   */
  childrenByStage?: ChildrenByStage;
}

/* ============================================================
   状态的样子
   ============================================================ */

/**
 * 五档状态各自的文案和颜色。
 *
 * ── 为什么「未接入」和「待执行」要分开 ──
 *   它们看起来都像"还没跑"，但意思完全不同：
 *     待执行  这一道**能跑**，只是还没轮到
 *     未接入  这一道**还跑不了**，代码都没写
 *   合并成一档的话，用户会以为"再等等它就会跑"，
 *   而实际上等到最后也不会有产物 —— 那是虚假的期待。
 */
const TONE: Record<string, { label: string; cls: string; dot: string }> = {
  pending: { label: "待执行", cls: "text-slate-500", dot: "var(--ink-6)" },
  running: { label: "正在跑", cls: "text-cyan-300", dot: "rgb(34 211 238)" },
  passed: { label: "已通过", cls: "text-green-400", dot: "rgb(74 222 128)" },
  failed: { label: "失败", cls: "text-red-400", dot: "rgb(248 113 113)" },
};

function toneOf(node: PipelineNode) {
  if (node.implementation === "planned") {
    return { label: "未接入", cls: "text-slate-600", dot: "var(--ink-7)" };
  }
  const base = TONE[node.status] ?? TONE.pending;
  /*
    直通模式要单独标出来。
    `direct` 的意思是"这件事做了，但没走完整的契约链路" ——
    直接显示成「已通过」的话，用户会以为各阶段的产物都在。
  */
  if (node.implementation === "direct" && node.status === "passed") {
    return { ...base, label: "已通过 · 直通" };
  }
  return base;
}

/* ============================================================
   一个节点
   ============================================================ */

function StageCard({
  node,
  rect,
  tint,
  active,
  dimmed,
  onPick,
}: {
  node: PipelineNode;
  rect: NodeRect;
  tint: string;
  active: boolean;
  dimmed: boolean;
  onPick?: (id: StageId) => void;
}) {
  const empty = node.implementation === "planned";
  const tone = toneOf(node);
  const running = node.status === "running" && !empty;

  return (
    <div
      /*
        ⚠️ 属性名是 data-pipeline-stage，不是 data-canvas-stage。
        画布本体（canvas-stage.tsx 里那层网格）已经占了后者 ——
        两个同名的话，`querySelectorAll('[data-canvas-stage]')` 会
        把画布本身也数进去，于是"六道工序"变成七个。
        这个错在画面上完全看不出来，只有数数才发现。
      */
      data-pipeline-stage={node.id}
      data-stage-status={node.status}
      /*
        pointer-events-auto 是必须的：整层世界坐标内容是 pointer-events-none，
        为的是让拖着空白处仍然能平移画布（见 canvas-stage 里的说明）。
        节点自己把事件收回来，点击才落得到它身上。
      */
      className={`pointer-events-auto absolute cursor-pointer overflow-hidden rounded-xl border px-3.5 py-3 transition-[border-color,opacity] duration-200 ${
        running ? "working-ring" : ""
      }`}
      style={
        {
          left: rect.x,
          top: rect.y,
          width: rect.w,
          height: rect.h,
          ["--ring-color" as string]: `rgb(${tint})`,
          borderColor: `rgb(${tint} / ${active ? 0.8 : empty ? 0.28 : 0.45})`,
          backgroundColor: "var(--color-surface)",
          backgroundImage: empty
            ? undefined
            : `linear-gradient(150deg, rgb(${tint} / ${active ? 0.24 : 0.14}) 0%, rgb(${tint} / 0.03) 58%, transparent 100%)`,
          boxShadow: active ? `0 0 0 1px rgb(${tint} / 0.8), 0 0 30px -8px rgb(${tint} / 0.95)` : undefined,
          /*
            ⚠️ active 要排在 empty 前面。

            写成 `dimmed ? 0.25 : empty ? 0.55 : 1` 的话，
            点一个「未接入」的工序时它**还是灰的**（0.55）——
            而点它恰恰是想看清它的详情（原理、验收标准、权限）。
            最需要看清的时候它最暗，是反的。
          */
          opacity: dimmed ? 0.25 : active ? 1 : empty ? 0.55 : 1,
        } as CSSProperties
      }
      onClick={() => onPick?.(node.id)}
    >
      {/* 顶部细亮线。只有真正接入了的工序才有 ——
          灰掉的工序连这条线都不该有，否则看起来还是「活的」 */}
      {!empty && (
        <span
          aria-hidden
          className="absolute inset-x-0 top-0 h-px"
          style={{ background: `linear-gradient(90deg, transparent, rgb(${tint} / 0.9), transparent)` }}
        />
      )}

      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{ background: `rgb(${tint})`, boxShadow: empty ? undefined : `0 0 9px 1px rgb(${tint} / 0.6)` }}
          />
          <span
            data-canvas-label="major"
            className="font-mono text-[11px] font-semibold tabular-nums"
            style={{ color: `rgb(${tint})` }}
          >
            {String(node.order).padStart(2, "0")}
          </span>
        </div>
        <span
          data-stage-tone
          data-canvas-label="minor"
          className="rounded border px-1.5 py-px text-[10px] whitespace-nowrap"
          style={{
            borderColor: `rgb(${tint} / 0.5)`,
            color: `rgb(${tint})`,
            background: empty ? "none" : `rgb(${tint} / 0.12)`,
          }}
        >
          {tone.label}
        </span>
      </div>

      <div
        data-canvas-label="major"
        className="mt-2 text-[15px] leading-tight font-medium text-slate-100"
      >
        {node.name}
      </div>
      <div data-canvas-label="minor" className="mt-0.5 font-mono text-[10.5px] text-slate-500">
        {node.artifact}
      </div>

      {/* ---------- 权限 ---------- */}
      <div className="mt-2 flex flex-wrap items-center gap-1">
        <AuthorityChip node={node} dim={empty} />
        {node.approval === "human" && (
          <span
            data-stage-gate={node.gateActive ? "on" : "off"}
            data-canvas-label="minor"
            title={
              node.gateActive
                ? "这一步会停下来问人"
                : "这一步声明了要人点头，但当前设置是先放行 —— 模型会替你猜"
            }
            className="rounded px-1.5 py-px text-[10px] leading-tight whitespace-nowrap"
            style={{
              background: empty ? "none" : "rgb(249 115 22 / 0.16)",
              color: empty ? "var(--ink-6)" : "rgb(253 186 116)",
              border: `1px solid ${empty ? "var(--color-border-soft)" : "rgb(249 115 22 / 0.35)"}`,
              textDecoration: node.gateActive ? undefined : "line-through",
              opacity: node.gateActive ? 1 : 0.6,
            }}
          >
            {node.gateActive ? "要人点头" : "要人点头（已放行）"}
          </span>
        )}
      </div>

      {/* ---------- 看什么数 ---------- */}
      <div
        data-stage-watches
        data-canvas-label="minor"
        className="mt-1.5 truncate text-[10.5px] text-slate-600"
      >
        看：{node.watches.map((w) => w.label).join(" · ")}
      </div>

      {/* ---------- 花费。没接入的不显示金额，见文件头那条硬约束 ---------- */}
      {node.costCny > 0 && (
        <div
          data-canvas-label="minor"
          className="mt-1.5 border-t border-[rgb(var(--tint)/0.15)] pt-1.5 text-[10.5px] tabular-nums"
        >
          <span className="text-slate-500">花费 </span>
          <span className="text-slate-300">¥{node.costCny.toFixed(4)}</span>
        </div>
      )}

      {empty && (
        <div
          data-canvas-label="minor"
          className="mt-1.5 border-t border-[var(--color-border-soft)] pt-1.5 text-[10.5px] text-slate-600"
        >
          尚未产出契约
        </div>
      )}
    </div>
  );
}

/**
 * 谁在做、能不能改。
 *
 * 视觉重量跟着风险走：「AI · 干活」是实心的，一屏里最先被看到。
 * 这正是想让用户形成的直觉 —— 能改东西的那一步才需要盯。
 */
function AuthorityChip({ node, dim }: { node: PipelineNode; dim: boolean }) {
  const label = actorBadge(node);
  const solid = label === "AI · 干活" || label === "人";
  const color =
    label === "人"
      ? "249 115 22"
      : label === "AI · 干活"
        ? "245 158 11"
        : label === "AI · 只读"
          ? "34 211 238"
          : null;

  return (
    <span
      data-stage-actor={node.id}
      data-canvas-label="minor"
      className="rounded px-1.5 py-px text-[10px] leading-tight whitespace-nowrap"
      style={
        dim || !color
          ? { border: "1px solid var(--color-border-soft)", color: "var(--ink-6)" }
          : solid
            ? { background: `rgb(${color} / 0.85)`, color: "#1c1917", fontWeight: 500 }
            : { border: `1px solid rgb(${color} / 0.38)`, color: `rgb(${color} / 0.95)` }
      }
    >
      {label}
    </span>
  );
}

/* ============================================================
   一个子节点
   ============================================================ */

/**
 * 挂在工序下面的一个小方块 —— 「这一步内部产出了什么」。
 *
 * ── 为什么比工序卡小这么多 ──
 *   工序卡是**骨架**，六张要在一屏里都读得清，所以它是 240×156。
 *   子节点是**内容**，可能几十个 —— 每个都那么大就没法看了。
 *   168×44 只放得下一行字，那正好：一行说清"这一项是什么"，
 *   依据（凭什么说它通过了）留给悬停和详情。
 *
 * ── 颜色只表达一件事：这一项过了没有 ──
 *   绿 = 过、红 = 没过、灰 = 无所谓过不过。
 *   不表达"重要程度""归属"这些 —— 一个方块只该有一层含义，
 *   叠上第二层之后，缩小了看就只剩"一片花花绿绿"。
 */
function ChildChip({ rect, child }: { rect: NodeRect; child: StageChild }) {
  const tone =
    child.tone === "pass"
      ? "74 222 128"
      : child.tone === "fail"
        ? "248 113 113"
        : "148 163 184";

  return (
    <div
      data-canvas-child={child.id}
      data-child-tone={child.tone}
      title={child.detail}
      className="absolute overflow-hidden rounded-md border px-2.5 py-2"
      style={{
        left: rect.x,
        top: rect.y,
        width: rect.w,
        height: rect.h,
        borderColor: `rgb(${tone} / 0.42)`,
        background: `rgb(${tone} / 0.08)`,
      }}
    >
      <div className="flex items-center gap-1.5">
        <span
          aria-hidden
          className="inline-block h-1.5 w-1.5 flex-none rounded-full"
          style={{ background: `rgb(${tone})` }}
        />
        {/* data-canvas-label 让它在缩小时跟着让位，见 globals.css */}
        <span
          data-canvas-label="minor"
          className="truncate text-[11px] leading-tight text-slate-300"
        >
          {child.label}
        </span>
      </div>
    </div>
  );
}

/* ============================================================
   整张图
   ============================================================ */

/**
 * 把画布那一档几何翻译成森林布局的几何。
 *
 * 为什么要翻译而不是共用一个类型：
 *   两者关心的事不一样 —— 画布那套只说"一个方块多大、隔多远"，
 *   森林这套还要说"子节点多大、每行几个、父子隔多远"。
 *   硬合成一个类型的话，面板那一档就得凭空填一堆用不到的子树参数。
 *
 * 根的三个值直接搬过去，这样**没有子树时结果和旧布局逐像素相同**。
 */
function forestGeometryOf(g: CanvasPipelineGeometry): ForestGeometry {
  return {
    ...FOREST_GEOMETRY,
    root: { w: g.nodeW, h: g.nodeH, gapX: g.gapX, perRow: g.perRow },
    rowOffsetY: g.rowOffsetY,
    // 根节点换行时两行之间的距离，沿用画布那套的 gapY
    // （它已经保证装得下回退弧线了 —— 这正是 gapY 当年被定成 136 的原因）
    rootRowGap: g.gapY,
  };
}

export function PipelineCanvas({
  nodes,
  chain = null,
  activeId = null,
  onPick,
  geometry = PIPELINE_GEOMETRY,
  childrenByStage,
}: PipelineCanvasProps) {
  const g = geometry;
  const total = nodes.length;

  /** id → 子节点数据。渲染时按 id 查，O(1) */
  const childOf = useMemo(() => childIndex(childrenByStage ?? {}), [childrenByStage]);

  /*
    位置交给森林布局算。
    没有子节点时结果和旧的 nodeRect **逐像素相同**
    （tests/unit/canvas-forest-layout.test.ts 里有一组锚点断言钉着这件事）。

    有子节点时，根节点之间的距离会按**子树宽**自动撑开 ——
    这就是「自动扩展」，不需要任何额外的推动逻辑。
  */
  const forest = useMemo(
    () =>
      layoutForest(
        toLayoutNodes(
          nodes.map((n) => n.id),
          childrenByStage ?? {},
        ),
        forestGeometryOf(g),
      ),
    [nodes, childrenByStage, g],
  );

  const rects = useMemo(
    () => nodes.map((n) => forest.byId.get(n.id) ?? { x: 0, y: 0, w: g.nodeW, h: g.nodeH }),
    [nodes, forest, g],
  );

  /** 有聚焦点时，不在链上的压暗 —— 让链自己浮出来 */
  const hasFocus = chain !== null;
  const onChain = useCallback(
    (id: StageId) => (hasFocus ? chain!.has(id) : true),
    [hasFocus, chain],
  );

  const dimmedExcept = useCallback(
    (id: StageId) => hasFocus && !chain!.has(id),
    [hasFocus, chain],
  );

  const bounds = forest.bounds;
  /*
    ⚠️ 这里原来还有一根 `const lane = bounds.x - 32` ——
       跨行回退边共用的那根竖线。回退弧线不画了，它也就没人用了，删掉。
       （留着的话 tsc 不报错、eslint 也不一定拦得住，
        但下次有人读到这行会以为画布上还有那条线。）
  */

  return (
    <div data-canvas-pipeline className="absolute" style={{ left: 0, top: 0 }}>
      {/* ---------- 连线 ---------- */}
      <svg
        aria-hidden
        className="absolute overflow-visible"
        style={{ left: bounds.x, top: bounds.y, width: bounds.w, height: bounds.h }}
        viewBox={`${bounds.x} ${bounds.y} ${bounds.w} ${bounds.h}`}
      >
        {nodes.map((node, i) => {
          /* 顺序流转：第 i 道 → 第 i+1 道 */
          if (i >= total - 1) return null;
          const a = rects[i];
          const b = rects[i + 1];
          const lit = onChain(node.id) && onChain(nodes[i + 1].id);
          const arrow = flowArrowAt(a, b, g);

          return (
            <g key={`flow-${node.id}`} opacity={lit ? 1 : 0.18}>
              <path
                d={flowPath(a, b)}
                fill="none"
                stroke={`rgb(${tintVarAt(i)} / 0.45)`}
                strokeWidth={1.5}
              />
              {/* 箭头单独画：SVG marker 会跟着线一起缩放，
                  缩小时糊成一团、放大时变成巨大的三角 */}
              <path
                d={`M ${arrow.x - 4} ${arrow.y - 4} L ${arrow.x + 4} ${arrow.y} L ${arrow.x - 4} ${arrow.y + 4} Z`}
                fill={`rgb(${tintVarAt(i)} / 0.7)`}
              />
            </g>
          );
        })}

        {/*
          ⚠️ 这里原来画的是**失败回退的弧线 + 「失败可退回」标签**，现在不画了。

          ── 为什么删掉 ──
            回退是**流程内部的机制**，不是图上要表达的东西。
            六道工序之间那条顺序实线已经说清了「谁接谁」；
            再叠一层虚弧线，读者要先去分辨「这条虚线是什么」，
            而那件事跟他此刻要看的（跑到哪一步了、每步产出了什么）无关。

            用户原话：「这个操作只需要保持在内部即可，不需要专门显示出来」。

          ── 删掉的只是「画」，不是「有」 ──
            · node.fallbackTo 还在图上（graph.ts 建图时照建）
            · 失败时该退到哪、tracePath 怎么走，全都不变
            · 点开工序看详情时，回退目标仍然列在里面
            也就是：**机制完整保留，只是不再往画布上画一条线。**

            这也是为什么 fallbackPath / fallbackLabelAt 两个几何函数
            暂时留在 pipeline-layout 里没删 —— 它们是这条边的几何，
            留着是「随时能装回去」，不是因为还有人在调。
        */}
      </svg>

      {/* ---------- 节点 ---------- */}
      {nodes.map((node, i) => (
        <StageCard
          key={node.id}
          node={node}
          rect={rects[i]}
          tint={tintVarAt(i)}
          active={activeId === node.id}
          dimmed={dimmedExcept(node.id)}
          onPick={onPick}
        />
      ))}

      {/*
        ---------- 子节点 ----------
        挂在每道工序下面。depth > 0 的就是它们 ——
        布局只吐出位置，这里按 id 把数据找回来。
      */}
      {forest.nodes
        .filter((n) => n.depth > 0)
        .map((n) => {
          const child = childOf.get(n.id);
          if (!child) return null;
          return <ChildChip key={n.id} rect={n} child={child} />;
        })}
    </div>
  );
}