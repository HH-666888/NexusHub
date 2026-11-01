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
  TREE_LEVELS,
  layoutForest,
  treeLinks,
  type ForestGeometry,
} from "@/core/canvas/forest-layout";
import {
  childIndex,
  summarizeChildren,
  toForestNodes,
  toLayoutNodes,
  type ChildrenByStage,
  type StageChild,
} from "@/core/pipeline/forest";
import {
  TONE_RGB,
  statusLabel,
  statusTone,
  type TaskPointStatus,
} from "@/core/planning/task-point";
import type { StageId } from "@/core/pipeline/stages";
import { useAnimatedLayout } from "../hooks/use-animated-layout";

/**
 * 画布上的六道工序：位置由 core/canvas 的纯函数给出，画布只画它拿到的那棵树。
 * 不用 React Flow：回退边能画成一条二次贝塞尔，节点坐标也是能断言的数。
 * 未接入的工序照画，但状态如实标“未接入”，不参与进度推算。
 */

/** 一级 Agent 根节点。status 必须来自真实投影（core/planning/from-run.ts），调用方不许写死 */
export interface CanvasRootCard {
  id: string;
  title: string;
  subtitle?: string;
  status: TaskPointStatus;
}

export interface PipelineCanvasProps {
  nodes: readonly PipelineNode[];
  /** 高亮的节点：点一个节点后，整条上下游链都算在内 */
  chain?: ReadonlySet<StageId> | null;
  activeId?: StageId | null;
  onPick?: (id: StageId) => void;
  /** 双击工序 → 聚焦到它整棵子树。传区域而不是节点 id：画布不认识森林数据结构 */
  onFocusBounds?: (bounds: { x: number; y: number; w: number; h: number }) => void;
  gateOverride?: GateOverride;
  /** 摆几行。整页给 WIDE（一行六个），830 宽的工作台面板给 PANEL（三列两行） */
  geometry?: CanvasPipelineGeometry;
  /** 每步内部的产物，画成挂在工序下的子节点。目前只有“验收与交付”的七项检查 */
  childrenByStage?: ChildrenByStage;
  /** 一级 Agent 根节点。三个使用场景看到的树不同，由调用方决定画几层；不传时走旧路径，逐像素不变 */
  rootCard?: CanvasRootCard;
}

/**
 * 四档状态的文案与颜色。第五档“未接入”由 toneOf 单独返回，不在这张表里：
 * 它和“待执行”看着都像还没跑，但一个是代码都没写，一个只是还没轮到 ——
 * 合并成一档，用户会以为再等等它就会跑。
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
  // 直通模式单独标注：直接显示“已通过”会让人以为各阶段产物都在
  if (node.implementation === "direct" && node.status === "passed") {
    return { ...base, label: "已通过 · 直通" };
  }
  return base;
}

/**
 * 一道工序的卡。绝对定位 + transform 摆放，尺寸由布局给定：
 * 布局按固定的 240×156 算位置，所以文字多了是截断而不是换行。
 */
function StageCard({
  node,
  rect,
  tint,
  active,
  dimmed,
  failedKids,
  onPick,
  onFocus,
}: {
  node: PipelineNode;
  /** 这一帧画在哪。实际传入的是 LaidNode，角标要用它的 childCount */
  rect: NodeRect & { childCount?: number };
  tint: string;
  active: boolean;
  dimmed: boolean;
  /** 子树里未通过的项数，用于右上角角标 */
  failedKids: number;
  onPick?: (id: StageId) => void;
  /** 双击聚焦到此树，区域由布局给出 */
  onFocus?: () => void;
}) {
  const empty = node.implementation === "planned";
  const tone = toneOf(node);
  const running = node.status === "running" && !empty;

  // 子树孩子数，大于 0 才画角标
  const childCount = rect.childCount ?? 0;
  // 全过为绿，有一项没过为红
  const kidsTone = failedKids === 0 ? "74 222 128" : "248 113 113";

  return (
    <div
      // 属性名不能与画布本体的 data-canvas-stage 重名：两个同名的话，
      // 按属性计数会把画布本身也算进去，六道工序变成七道，而画面上看不出来。
      data-pipeline-stage={node.id}
      data-stage-status={node.status}
      // 世界坐标层是 pointer-events-none（拖着空白处才能平移画布），
      // 节点自己把事件收回来，点击才落得到它身上。
      className={`pointer-events-auto absolute cursor-pointer overflow-hidden rounded-xl border px-3.5 py-3 transition-[border-color,opacity] duration-200 ${
        running ? "working-ring" : ""
      }`}
      style={
        {
          // 用 transform 而非 left/top：动画每帧都改位置，left/top 会每帧触发布局重算。
          // 配 transform-origin: 0 0，translate(x,y) 和 left/top 落在同一个位置上。
          transform: `translate(${rect.x}px, ${rect.y}px)`,
          transformOrigin: "0 0",
          width: rect.w,
          height: rect.h,
          ["--ring-color" as string]: `rgb(${tint})`,
          borderColor: `rgb(${tint} / ${active ? 0.8 : empty ? 0.28 : 0.45})`,
          backgroundColor: "var(--color-surface)",
          backgroundImage: empty
            ? undefined
            : `linear-gradient(150deg, rgb(${tint} / ${active ? 0.24 : 0.14}) 0%, rgb(${tint} / 0.03) 58%, transparent 100%)`,
          boxShadow: active
            ? `0 0 0 1px rgb(${tint} / 0.8), 0 0 30px -8px rgb(${tint} / 0.95)`
            : undefined,
          // active 排在 empty 前：写成 empty 优先的话，点“未接入”的工序时它还是灰的，
          // 而点它恰恰是为了看清详情
          opacity: dimmed ? 0.25 : active ? 1 : empty ? 0.55 : 1,
        } as CSSProperties
      }
      onClick={() => onPick?.(node.id)}
      // 单击用于点亮上下游链，聚焦属于换视角，用双击区分
      onDoubleClick={(e) => {
        e.stopPropagation(); // 避免冒泡到画布
        onFocus?.();
      }}
      title="单击高亮上下游链 · 双击聚焦到这棵树"
    >
      {/* 顶部亮线只有已接入的工序才有 */}
      {!empty && (
        <span
          aria-hidden
          className="absolute inset-x-0 top-0 h-px"
          style={{
            background: `linear-gradient(90deg, transparent, rgb(${tint} / 0.9), transparent)`,
          }}
        />
      )}

      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{
              background: `rgb(${tint})`,
              boxShadow: empty ? undefined : `0 0 9px 1px rgb(${tint} / 0.6)`,
            }}
          />
          <span
            data-canvas-label="major"
            className="font-mono text-[11px] font-semibold tabular-nums"
            style={{ color: `rgb(${tint})` }}
          >
            {String(node.order).padStart(2, "0")}
          </span>
        </div>
        {/* 子树角标，无子树时不画 */}
        <div className="flex items-center gap-1">
          {/* 子树角标：7/7 全过、6/7 有一项没过。没有子树（childCount 为 0）就不画 */}
          {childCount > 0 && (
            <span
              data-stage-kids
              data-canvas-label="minor"
              className="rounded border px-1.5 py-px text-[10px] whitespace-nowrap tabular-nums"
              style={{
                borderColor: `rgb(${kidsTone} / 0.5)`,
                color: `rgb(${kidsTone})`,
                background: `rgb(${kidsTone} / 0.12)`,
              }}
              title={`子树 ${childCount} 项，${failedKids} 项未过`}
            >
              {`${childCount - failedKids}/${childCount}`}
            </span>
          )}
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
      </div>

      <div
        data-canvas-label="major"
        className="mt-2 text-[15px] leading-tight font-medium text-slate-100"
      >
        {node.name}
      </div>
      <div
        data-canvas-label="minor"
        className="mt-0.5 font-mono text-[10.5px] text-slate-500"
      >
        {node.artifact}
      </div>

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

      <div
        data-stage-watches
        data-canvas-label="minor"
        className="mt-1.5 truncate text-[10.5px] text-slate-600"
      >
        看：{node.watches.map((w) => w.label).join(" · ")}
      </div>

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

/** 谁在做、能不能改。视觉重量跟着风险走：能改东西的那一步才需要盯 */
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
            : {
                border: `1px solid rgb(${color} / 0.38)`,
                color: `rgb(${color} / 0.95)`,
              }
      }
    >
      {label}
    </span>
  );
}

/**
 * 画布最上面那张卡。边框、渐变、状态胶囊照着 StageCard 抄，改那边时要一起看 ——
 * 层级感由结构和连线给，不靠样式区分。
 *
 * 标识是 AGENT 而不是序号：它不是第 0 道工序，是管这六道的那一个。
 * 也没有权限、看什么数、花费 —— 那些都是工序的属性，它这一期不产出。
 */
function RootCard({
  card,
  rect,
  entering = false,
}: {
  card: CanvasRootCard;
  rect: NodeRect & { childCount?: number };
  entering?: boolean;
}) {
  const tone = statusTone(card.status);
  const rgb = TONE_RGB[tone];
  // 用现成的 animate-pulse + motion-reduce:animate-none，而不是自己写 keyframes：
  // prefers-reduced-motion 下必须不动，而现成变体不会忘。
  const running = card.status === "running";
  /** 下辖工序数，来自布局的 childCount */
  const stages = rect.childCount ?? 0;

  return (
    <div
      // 和工序卡的 data-pipeline-stage 分开：共用一个属性名会让“六道工序”数成七个
      data-pipeline-root={card.id}
      // 原始状态写进 DOM：便于直接断言，不必从颜色反推
      data-root-status={card.status}
      data-root-tone={tone}
      // 状态色值也写进 DOM：胶囊在缩小时文字透明，读计算样式会读到 rgba(0,0,0,0)
      data-root-rgb={rgb}
      data-root-entering={entering ? "1" : undefined}
      className="pointer-events-auto absolute overflow-hidden rounded-xl border px-3.5 py-3 transition-[border-color,opacity] duration-200"
      style={{
        /* 同 StageCard：transform 而不是 left/top，动画时不触发布局重算 */
        transform: `translate(${rect.x}px, ${rect.y}px)`,
        transformOrigin: "0 0",
        width: rect.w,
        height: rect.h,
        borderColor: `rgb(${rgb} / 0.45)`,
        backgroundColor: "var(--color-surface)",
        backgroundImage: `linear-gradient(150deg, rgb(${rgb} / 0.14) 0%, rgb(${rgb} / 0.03) 58%, transparent 100%)`,
        opacity: entering ? 0.25 : 1,
        // 淡入与尺寸插值一起做，否则像是“弹出”而不是“长出”
      }}
    >
      <span
        aria-hidden
        className="absolute inset-x-0 top-0 h-px"
        style={{
          background: `linear-gradient(90deg, transparent, rgb(${rgb} / 0.9), transparent)`,
        }}
      />

      {/* 标识 + 状态胶囊。根节点不是第 0 道工序，标识用 AGENT 而不是序号 */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="inline-block text-[11px] leading-none"
            style={{ color: `rgb(${rgb})`, textShadow: `0 0 8px rgb(${rgb} / 0.6)` }}
          >
            ◆
          </span>
          <span
            data-canvas-label="major"
            className="font-mono text-[11px] font-semibold tracking-wider"
            style={{ color: `rgb(${rgb})` }}
          >
            AGENT
          </span>
        </div>
        <span
          data-root-pill
          data-canvas-label="minor"
          className={`rounded border px-1.5 py-px text-[10px] whitespace-nowrap ${
            running ? "animate-pulse motion-reduce:animate-none" : ""
          }`}
          style={{
            borderColor: `rgb(${rgb} / 0.5)`,
            color: `rgb(${rgb})`,
            background: `rgb(${rgb} / 0.12)`,
          }}
        >
          {statusLabel(card.status)}
        </span>
      </div>

      {/* 标题与副标题 */}
      <div
        data-root-title
        data-canvas-label="major"
        className="mt-2 text-[15px] leading-tight font-medium text-slate-100"
      >
        {card.title}
      </div>
      {card.subtitle && (
        <div
          data-root-subtitle
          data-canvas-label="minor"
          className="mt-0.5 font-mono text-[10.5px] text-slate-500"
        >
          {card.subtitle}
        </div>
      )}

      {/* 内层两个 span 也要标 data-canvas-label，否则缩放时不受 tier 规则约束 */}
      <div
        data-root-stages
        data-canvas-label="minor"
        className="mt-2 border-t pt-1.5 text-[10.5px] tabular-nums"
        style={{ borderColor: `rgb(${rgb} / 0.15)` }}
      >
        <span data-canvas-label="minor" className="text-slate-500">
          下辖{" "}
        </span>
        <span data-canvas-label="minor" className="text-slate-300">
          {stages} 道工序
        </span>
      </div>
    </div>
  );
}

/**
 * 挂在工序下的子方块。工序卡是骨架，六张要在一屏里读得清；子节点是内容，
 * 可能几十个，所以只给 168×44：一行说清这一项是什么，依据留给悬停和详情。
 * 颜色只表达“过没过”这一层含义，叠上第二层之后缩小看就只剩一片花花绿绿。
 */
function ChildChip({
  rect,
  child,
  entering = false,
}: {
  rect: NodeRect;
  child: StageChild;
  entering?: boolean;
}) {
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
      data-child-entering={entering ? "1" : undefined}
      title={child.detail}
      className="pointer-events-auto absolute overflow-hidden rounded-xl border px-3 py-2.5 transition-opacity duration-200"
      style={{
        transform: `translate(${rect.x}px, ${rect.y}px)`,
        transformOrigin: "0 0",
        width: rect.w,
        height: rect.h,
        // 尺寸插值之外还要淡入，否则像是“弹出”而不是“长出”
        opacity: entering ? 0.25 : 1,
        borderColor: `rgb(${tone} / 0.45)`,
        backgroundColor: "var(--color-surface)",
        backgroundImage: `linear-gradient(150deg, rgb(${tone} / 0.14) 0%, rgb(${tone} / 0.03) 58%, transparent 100%)`,
      }}
    >
      <span
        aria-hidden
        className="absolute inset-x-0 top-0 h-px"
        style={{
          background: `linear-gradient(90deg, transparent, rgb(${tone} / 0.9), transparent)`,
        }}
      />

      <div className="flex items-start justify-between gap-2">
        <span
          aria-hidden
          className="mt-1 inline-block h-1.5 w-1.5 flex-none rounded-full"
          style={{
            background: `rgb(${tone})`,
            boxShadow: `0 0 9px 1px rgb(${tone} / 0.6)`,
          }}
        />
        <span
          data-child-status
          data-canvas-label="minor"
          className="rounded border px-1.5 py-px text-[10px] whitespace-nowrap"
          style={{
            borderColor: `rgb(${tone} / 0.5)`,
            color: `rgb(${tone})`,
            background: `rgb(${tone} / 0.12)`,
          }}
        >
          {child.statusLabel}
        </span>
      </div>

      <div
        data-canvas-label="major"
        className="mt-1.5 truncate text-[13px] leading-tight font-medium text-slate-100"
      >
        {child.label}
      </div>

      {/* 判定依据。两行截断：证据长短不一，不截会把卡片撑破（高度由布局算死） */}
      <div
        data-child-detail
        data-canvas-label="minor"
        className="mt-0.5 line-clamp-2 text-[10.5px] leading-snug text-slate-500"
      >
        {child.detail}
      </div>

      {/* 关键字胶囊。当前是占位符“——”，见 core/pipeline/forest.ts 的 CHILD_PLACEHOLDER */}
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        {child.chips.map((c, i) => (
          <span
            key={i}
            data-canvas-label="minor"
            className="rounded px-1.5 py-px text-[10px] leading-tight text-slate-600"
            style={{ border: "1px solid var(--color-border-soft)" }}
          >
            {c}
          </span>
        ))}
      </div>

      {/* 数值，同样是占位符 */}
      <div
        data-child-metric
        data-canvas-label="minor"
        className="mt-1.5 border-t pt-1 text-[10.5px] text-slate-500 tabular-nums"
        style={{ borderColor: `rgb(${tone} / 0.15)` }}
      >
        {child.metric}
      </div>
    </div>
  );
}

/**
 * 画布几何 → 森林几何。两者字段不同：森林那套还要说子节点多大、每行几个、
 * 父子隔多远，硬合成一个类型的话，面板那一档得凭空填一堆用不到的参数。
 *
 * 根的三个值直接搬过去，所以没有子树时结果和旧布局逐像素相同。
 */
function forestGeometryOf(
  g: CanvasPipelineGeometry,
  threeLayer: boolean,
): ForestGeometry {
  return {
    ...FOREST_GEOMETRY,
    root: { w: g.nodeW, h: g.nodeH, gapX: g.gapX, perRow: g.perRow },
    rowOffsetY: g.rowOffsetY,
    // 根节点换行的行距沿用 gapY（它已保证装得下回退弧线）
    rootRowGap: g.gapY,
    // 只有三层树才出现 levels 这个键。按深度覆盖而不是改 FOREST_GEOMETRY：
    // 第 1 层的六道工序必须保持主卡尺寸，改 g.child 会把第 2 层一起放大。
    ...(threeLayer ? { levels: TREE_LEVELS } : {}),
  };
}

export function PipelineCanvas({
  nodes,
  chain = null,
  activeId = null,
  onPick,
  onFocusBounds,
  geometry = PIPELINE_GEOMETRY,
  childrenByStage,
  rootCard,
}: PipelineCanvasProps) {
  const g = geometry;
  const total = nodes.length;
  const threeLayer = rootCard !== undefined;

  /** id → 子节点，渲染时 O(1) 查 */
  const childOf = useMemo(() => childIndex(childrenByStage ?? {}), [childrenByStage]);

  /*
    位置交给森林布局算。没有子节点时结果和旧的 nodeRect 逐像素相同；
    有根节点时喂进去的是“一级 Agent → 六道工序 → 子节点”的三层树，
    布局本身不用改 —— 它一直都支持任意深度，变的只是喂进去的形状。
  */
  const forest = useMemo(
    () =>
      layoutForest(
        threeLayer && rootCard
          ? toForestNodes(
              rootCard.id,
              nodes.map((n) => n.id),
              childrenByStage ?? {},
            )
          : toLayoutNodes(
              nodes.map((n) => n.id),
              childrenByStage ?? {},
            ),
        forestGeometryOf(g, threeLayer),
      ),
    [nodes, childrenByStage, g, threeLayer, rootCard],
  );

  // 往下画的是 animatedNodes（这一帧的实际位置），不是 forest.nodes（目标位置）
  const animated = useAnimatedLayout(forest.nodes);
  const animatedNodes = animated.nodes;

  // 渲染坐标：优先取动画态，动画首帧还没进入插值时才退回布局的目标位置
  const rects = useMemo(
    () =>
      nodes.map(
        (n) =>
          animatedNodes.find((a) => a.id === n.id) ??
          forest.byId.get(n.id) ?? { x: 0, y: 0, w: g.nodeW, h: g.nodeH },
      ),
    [nodes, animatedNodes, forest, g],
  );

  // 根卡与六道工序共用同一套坐标。换运行时整棵树都在动，
  // 用目标位置的话根卡会先落在终点，看起来和自己的孩子脱节。
  const rootRect = rootCard
    ? (animatedNodes.find((a) => a.id === rootCard.id) ??
      forest.byId.get(rootCard.id) ??
      null)
    : null;

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

  /**
   * 层级下限按这棵树有几层算。没有根节点时六道工序是 depth 0，
   * 有根节点时掉到 depth 1 —— 写死 0 会把它们也卷进子方块的渲染循环，
   * 现在只是靠 childOf 查不到兜住，那种正确很脆。
   */
  const childDepthFloor = threeLayer ? 1 : 0;

  return (
    <div data-canvas-pipeline className="absolute" style={{ left: 0, top: 0 }}>
      {/* 顺序流转的实线与箭头 */}
      <svg
        aria-hidden
        className="absolute overflow-visible"
        style={{ left: bounds.x, top: bounds.y, width: bounds.w, height: bounds.h }}
        viewBox={`${bounds.x} ${bounds.y} ${bounds.w} ${bounds.h}`}
      >
        {nodes.map((node, i) => {
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
              {/* 箭头单独画：SVG marker 会跟着线缩放，缩小时糊成一团 */}
              <path
                d={`M ${arrow.x - 4} ${arrow.y - 4} L ${arrow.x + 4} ${arrow.y} L ${arrow.x - 4} ${arrow.y + 4} Z`}
                fill={`rgb(${tintVarAt(i)} / 0.7)`}
              />
            </g>
          );
        })}

        {/* 失败回退边不再绘制：回退是流程内部的机制，不是图上要表达的东西。
            机制仍在 graph 里（fallbackTo 照建），几何函数留在 pipeline-layout 备用 */}

        {/* 父子连线交给 core 的 treeLinks：躯干从父卡底边中点往下，每个孩子一根短横枝。
            脊线走父卡中心，恰好是两块子卡区的中缝，所以不会从方块底下穿过。
            svg 先于卡片渲染，端口被遮住也不用裁剪 */}
        {/* 连线也用动画态，否则动画期间线头已经跳到终点、和卡片对不上 */}
        {treeLinks(animatedNodes).map((l) => (
          <g key={`tree-${l.parentId}`}>
            {/* 躯干：一条竖线，不属于任何一个孩子，单独标记 */}
            <path
              data-canvas-tree-trunk={l.parentId}
              d={`M ${l.trunk.x} ${l.trunk.y1} V ${l.trunk.y2}`}
              fill="none"
              stroke="rgb(148 163 184 / 0.38)"
              strokeWidth={1.2}
            />
            {/* 横枝：一个孩子一根，各带 data-canvas-tree-link，用于断言条数。
                退化情形（横枝长度为 0）也要渲染，filter 掉会让计数误报“有孤儿方块” */}
            {l.branches.map((b) => (
              <path
                key={b.childId}
                data-canvas-tree-link={b.childId}
                data-canvas-tree-link-degenerate={b.degenerate ? "1" : undefined}
                d={`M ${b.x1} ${b.y} H ${b.x2}`}
                fill="none"
                stroke="rgb(148 163 184 / 0.38)"
                strokeWidth={1.2}
              />
            ))}
          </g>
        ))}
      </svg>

      {/* 根卡先于六道工序渲染，DOM 顺序与树形一致 */}
      {rootCard && rootRect && (
        <RootCard
          card={rootCard}
          rect={rootRect}
          entering={animated.newIds.has(rootCard.id)}
        />
      )}

      {nodes.map((node, i) => (
        <StageCard
          key={node.id}
          node={node}
          rect={rects[i]}
          tint={tintVarAt(i)}
          active={activeId === node.id}
          dimmed={dimmedExcept(node.id)}
          // 角标的分子分母。rects 整个照旧交给 rect，childCount 本来就在里面
          failedKids={summarizeChildren(childrenByStage?.[node.id] ?? []).failed}
          onPick={onPick}
          // 聚焦区域取 forest.byId 的 subtree：它是这棵树最终占多大地方，是个稳定目标。
          // 取动画态的话，动画没跑完时会聚焦到一个正在移动、偏小的区域。
          onFocus={
            onFocusBounds
              ? () => {
                  const target = forest.byId.get(node.id);
                  if (target) onFocusBounds(target.subtree);
                }
              : undefined
          }
        />
      ))}

      {/* 子节点：比 childDepthFloor 深的都是，按 id 把数据找回来。
          坐标用动画态，新出现的带 entering 淡入 —— 只插位置会像“弹出”而不是“长出” */}
      {animatedNodes
        .filter((n) => n.depth > childDepthFloor)
        .map((n) => {
          const child = childOf.get(n.id);
          if (!child) return null;
          return (
            <ChildChip
              key={n.id}
              rect={n}
              child={child}
              entering={animated.newIds.has(n.id)}
            />
          );
        })}
    </div>
  );
}
