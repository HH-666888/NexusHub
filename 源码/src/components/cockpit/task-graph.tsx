"use client";

import { useCallback, useMemo, useState, type CSSProperties } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import {
  buildPipelineGraph,
  describeTrace,
  LAYOUT,
  nodeMetrics,
  nodeStatusLabel,
  nodeTone,
  tracePath,
  type NodeTone,
  type PathTrace,
  type PipelineGraph,
  type PipelineNode,
} from "@/core/pipeline/graph";
import type { RunProgressInput } from "@/core/pipeline/progress";
import { actorBadge } from "@/core/pipeline/authority";
import type { StageId } from "@/core/pipeline/stages";
import type { CostByStage } from "@/core/domain/stage-cost";

/**
 * 任务图画布
 * ============================================================
 * 用 React Flow 承载，但**只用它「看」的能力**：
 *   · 平移 / 缩放 / 适应窗口 / 小地图
 *   · 视口裁剪（节点多时比手写实现更快，有实测数据支撑）
 * 位置由 core/pipeline/graph.ts 的布局函数算出来，不依赖它的自动布局。
 *
 * ── 为什么节点也要自己画，不用它的默认样式 ──
 *   默认节点是一个朴素方框，放不下我们要表达的东西：
 *   实现状态、运行状态、契约文件名、花费。
 *   而「未接入」和「已通过」必须一眼能分辨 —— 这是这个项目的一条底线。
 */

/* ============================================================
   节点
   ============================================================ */

/** 每种色调对应一组 CSS 变量。用 tint 变量而不是写死颜色，跟随外观配置 */
const TONE_TINT: Record<NodeTone, string> = {
  planned: "var(--ink-7)",
  pending: "var(--ink-6)",
  running: "var(--tint-4)",
  passed: "var(--tint-6)",
  failed: "220 38 38",
  blocked: "217 119 6",
};

interface StageNodeData extends Record<string, unknown> {
  node: PipelineNode;
  tint: string;
  tone: NodeTone;
  /** 有聚焦点时，这个节点是否在追踪出来的链上 */
  onChain: boolean;
  /** 当前有没有聚焦点 —— 没有聚焦时所有节点一视同仁 */
  anyFocus: boolean;
}

/**
 * 谁在做、能不能改。
 *
 * ── 视觉重量跟着风险走 ──
 *   「AI · 只读」是细边线的浅色；
 *   「AI · 干活」是实心的琥珀色。
 *   两者同屏出现时，眼睛会先看到危险的那个 ——
 *   这正是想让用户形成的直觉：
 *   **这套东西里，能改东西的那一步才需要盯。**
 *
 * 文案由核心层的 actorBadge 给（那条规则不算界面的事）。
 */
function AuthorityChip({ node, dim }: { node: PipelineNode; dim: boolean }) {
  const label = actorBadge(node);

  /*
    四档的视觉重量，从轻到重：
      程序自动   细边线、灰        它只是取数，不参与判断
      AI · 只读  细边线、青        能看，改不了
      AI · 干活  **实心、琥珀**    能改，这一档要盯
      人         实心、橙         唯一能为对外动作负责的
  */
  const solid = label === "AI · 干活" || label === "人";
  const color =
    label === "人"
      ? "249 115 22" // 橙
      : label === "AI · 干活"
        ? "245 158 11" // 琥珀
        : label === "AI · 只读"
          ? "34 211 238" // 青
          : null;

  return (
    <span
      data-node-actor={node.id}
      className="rounded px-1.5 py-px text-[9.5px] leading-tight whitespace-nowrap"
      style={
        dim || !color
          ? {
              border: "1px solid var(--color-border-soft)",
              color: "var(--ink-6)",
            }
          : solid
            ? {
                background: `rgb(${color} / 0.85)`,
                color: "#1c1917",
                fontWeight: 500,
              }
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

function StageNode({ data }: NodeProps) {
  const { node, tint, tone, onChain, anyFocus } = data as StageNodeData;

  const dim = tone === "planned";
  const empty = node.implementation === "planned";
  // 有聚焦点、又不在链上 → 压暗，让链自己浮出来
  const offChain = anyFocus && !onChain;

  return (
    <div
      /*
        「正在干活」那圈光。
        用的是全局那条 working-ring（和参考图里的图例同一个东西）——
        以前跑着的节点只有一个静态外发光，和"选中"长得几乎一样；
        转起来之后，"正在跑"是唯一会动的东西，扫一眼就能找到。
      */
      className={`relative overflow-hidden rounded-xl border px-3 py-2.5 transition-[box-shadow,border-color,opacity] duration-200 ${
        tone === "running" ? "working-ring" : ""
      }`}
      style={
        {
          width: LAYOUT.nodeWidth,
          minHeight: LAYOUT.nodeHeight,
          ["--ring-color" as string]: `rgb(${tint})`,
          borderColor: `rgb(${tint} / ${onChain && anyFocus ? 0.75 : dim ? 0.3 : 0.45})`,
          backgroundColor: "var(--color-surface)",
          backgroundImage: dim
            ? undefined
            : `linear-gradient(150deg, rgb(${tint} / ${onChain && anyFocus ? 0.26 : 0.16}) 0%, rgb(${tint} / 0.04) 55%, transparent 100%)`,
          boxShadow:
            tone === "running" || (onChain && anyFocus)
              ? `0 0 0 1px rgb(${tint} / 0.8), 0 0 26px -8px rgb(${tint} / 0.95)`
              : dim
                ? undefined
                : `0 0 18px -12px rgb(${tint} / 0.9)`,
          opacity: offChain ? 0.22 : dim ? 0.55 : 1,
        } as CSSProperties
      }
    >
      {/* 顶部细亮线。只有真正接入了的工序才有 —— 
          灰掉的工序连这条线都不该有，否则看起来还是「活的」 */}
      {!dim && (
        <span
          aria-hidden
          className="absolute inset-x-0 top-0 h-px"
          style={{
            background: `linear-gradient(90deg, transparent, rgb(${tint} / 0.9), transparent)`,
          }}
        />
      )}

      <Handle
        type="target"
        position={Position.Left}
        className="!h-1.5 !w-1.5 !border-0 !bg-transparent"
      />

      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{
              background: `rgb(${tint})`,
              boxShadow: dim ? undefined : `0 0 9px 1px rgb(${tint} / 0.6)`,
            }}
          />
          <span
            className="font-mono text-[10px] font-semibold tabular-nums"
            style={{ color: `rgb(${tint})` }}
          >
            {String(node.order).padStart(2, "0")}
          </span>
        </div>
        <span
          className="rounded border px-1.5 py-px text-[9.5px] whitespace-nowrap"
          style={{
            borderColor: `rgb(${tint} / 0.5)`,
            color: `rgb(${tint})`,
            background: dim ? "none" : `rgb(${tint} / 0.12)`,
          }}
        >
          {nodeStatusLabel(node)}
        </span>
      </div>

      <div className="mt-1.5 text-[13px] leading-tight font-medium text-slate-100">
        {node.name}
      </div>
      <div className="mt-0.5 font-mono text-[9.5px] text-slate-500">
        {node.artifact}
      </div>

      {/*
        ---------- 权限 ----------
        来自「研发团队运转图」那套纪律。那张图删了，四个维度留下来长在工序上。

        ── 为什么这两样要放到节点上，而不是只放在详情面板里 ──
          因为它们表达的是**这套流程安不安全**，而安全是扫一眼就该看出来的事：
            · 谁在做（AI 还是程序还是人）
            · 能不能改东西 —— 「AI · 干活」是实心的，在一屏里最先被看到
            · 要不要人点头 —— 那是人与机器之间唯一的接口
          藏进详情面板的话，用户得逐一点开才知道"哪一步会来问我"。

        ── 未接入的工序也显示 ──
          权限是它的**定义**，不是它的进度。抹掉的话，
          用户就看不到"这一道将来会是什么样的角色"——
          而六道工序图画的本来就是完整形态。
        */}
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        <AuthorityChip node={node} dim={dim} />
        {node.approval === "human" && (
          <span
            data-node-gate={node.id}
            title="这一步会停下来问人"
            className="rounded px-1.5 py-px text-[9.5px] leading-tight whitespace-nowrap"
            style={{
              background: dim ? "none" : "rgb(249 115 22 / 0.16)",
              color: dim ? "var(--ink-6)" : "rgb(253 186 116)",
              border: `1px solid ${dim ? "var(--color-border-soft)" : "rgb(249 115 22 / 0.35)"}`,
            }}
          >
            要人点头
          </span>
        )}
      </div>

      {/*
        ---------- 看什么数 ----------
        「你凭什么说这一步做完了」。说不出来的工序多半只是走个过场。
        只显示标签，不显示具体值 —— 值是运行期的事，那是下面那排指标的位置。
      */}
      <div
        data-node-watches={node.id}
        className="mt-1 truncate text-[9.5px] text-slate-600"
      >
        看：{node.watches.map((w) => w.label).join(" · ")}
      </div>

      {nodeMetrics(node).length > 0 && (
        <div className="mt-1.5 flex gap-3 border-t border-[rgb(var(--tint)/0.15)] pt-1.5 text-[10px] tabular-nums">
          {nodeMetrics(node).map((m) => (
            <span key={m.label} className="text-slate-400">
              <span className="text-slate-500">{m.label} </span>
              {m.value}
            </span>
          ))}
        </div>
      )}

      {empty && (
        <div className="mt-1.5 border-t border-[var(--color-border-soft)] pt-1.5 text-[10px] text-slate-600">
          尚未产出契约
        </div>
      )}

      <Handle
        type="source"
        position={Position.Right}
        className="!h-1.5 !w-1.5 !border-0 !bg-transparent"
      />

      {/*
        回退边专用的底部手柄。
        为什么不能用 sourcePosition 去改边的起点 ——
        那个属性属于**节点**而不是边，写在边上类型直接不过。
        要让回退边从下方绕，就得有独立的手柄。
      */}
      <Handle
        id="fb-out"
        type="source"
        position={Position.Bottom}
        className="!h-1 !w-1 !border-0 !bg-transparent"
      />
      <Handle
        id="fb-in"
        type="target"
        position={Position.Bottom}
        className="!h-1 !w-1 !border-0 !bg-transparent"
      />
    </div>
  );
}

const nodeTypes = { stage: StageNode };

/* ============================================================
   画布
   ============================================================ */

export interface TaskGraphProps {
  run: RunProgressInput | null;
  costByStage?: CostByStage;
  /** 回退边要不要显示。默认显示 —— 这是我们的差异点 */
  showFallback?: boolean;
  className?: string;
}

function TaskGraphInner({ run, costByStage, showFallback = true, className }: TaskGraphProps) {
  const graph: PipelineGraph = useMemo(
    () => buildPipelineGraph({ run, costByStage }),
    [run, costByStage],
  );

  /*
    聚焦：鼠标悬停或点选某个节点时，把「它这条链」高亮出来。
    回答的是「这个产物是怎么来的」—— 一堆线里根本看不清哪几根连着。
    悬停给的是即时反馈，点选给的是留住不走的焦点。
  */
  const [hoveredId, setHoveredId] = useState<StageId | null>(null);
  const [selectedId, setSelectedId] = useState<StageId | null>(null);
  const focusId = hoveredId ?? selectedId;

  const trace: PathTrace | null = useMemo(
    () => (focusId ? tracePath(graph, focusId) : null),
    [graph, focusId],
  );

  // React Flow 的节点状态（拖动位置等）由它自己管，这里只做初始值
  const [baseNodes, setBaseNodes] = useState<Node[]>(() => toFlowNodes(graph, null));

  // 图数据变了（切换运行、跑完一轮）就重建节点，但保留用户拖过的位置
  const graphKey = useMemo(
    () => `${run?.stage ?? "-"}|${run?.status ?? "-"}|${JSON.stringify(costByStage ?? {})}`,
    [run, costByStage],
  );
  const [lastKey, setLastKey] = useState(graphKey);
  if (lastKey !== graphKey) {
    setLastKey(graphKey);
    setBaseNodes(toFlowNodes(graph, null));
  }

  /*
    高亮在**渲染时派生**，不写进 state。
    第一版是用 useEffect 把高亮结果 setState 回节点数组里，
    结果被 lint 拦下了 —— 在 effect 里同步 setState 会引发级联渲染。
    拦得对：派生出来的东西就不该再存一份，存两份必然要同步，
    要同步就必然多一轮渲染。现在位置在 baseNodes 里，高亮是算出来的。
  */
  const nodes: Node[] = useMemo(
    () =>
      baseNodes.map((n) => ({
        ...n,
        data: {
          ...n.data,
          onChain: trace ? trace.chain.has(n.id as StageId) : true,
          anyFocus: trace !== null,
        },
      })),
    [baseNodes, trace],
  );

  const edges: Edge[] = useMemo(
    () =>
      graph.edges
        .filter((e) => e.kind === "flow" || showFallback)
        .map((e) => {
          const fallback = e.kind === "fallback";
          const onChain = trace ? trace.edges.has(e.id) : true;
          const off = trace !== null && !onChain;

          const base = fallback
            ? { stroke: "rgba(217,119,6,.55)", strokeDasharray: "5 5", strokeWidth: 1.2 }
            : { stroke: "rgba(148,163,184,.35)", strokeWidth: 1.2 };

          const lit = fallback
            ? { stroke: "rgba(251,191,36,.95)", strokeDasharray: "5 5", strokeWidth: 1.8 }
            : { stroke: "rgba(226,232,240,.85)", strokeWidth: 2 };

          return {
            id: e.id,
            source: e.source,
            target: e.target,
            type: "smoothstep",
            // 回退边走底部手柄，从下方绕开 ——
            // 和主流程线挤在同一条水平线上会完全看不清哪条是哪条
            sourceHandle: fallback ? "fb-out" : undefined,
            targetHandle: fallback ? "fb-in" : undefined,
            label: e.label,
            labelShowBg: false,
            style: {
              ...(off ? base : onChain && trace ? lit : base),
              opacity: off ? 0.15 : 1,
              transition: "opacity .2s, stroke .2s",
            },
            // 链上的线画在上面，被压住的线不会盖住它
            zIndex: onChain && trace ? 5 : fallback ? 0 : 1,
            labelStyle: {
              fill: onChain && trace ? "var(--ink-2)" : "var(--ink-6)",
              fontSize: 9,
            },
          } satisfies Edge;
        }),
    [graph.edges, showFallback, trace],
  );

  const onNodeClick = useCallback((_: unknown, n: Node) => {
    setSelectedId(n.id as StageId);
  }, []);

  return (
    <div className={`relative h-full w-full ${className ?? ""}`}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={(changes) => {
          // 只处理位置与选中两类变化。其它变化（尺寸测量等）不落 state，
          // 否则每次测量都会触发一轮重渲染
          const positional = changes.filter(
            (c) => c.type === "position" || c.type === "select" || c.type === "dimensions",
          );
          if (positional.length === 0) return;
          setBaseNodes((prev) =>
            prev.map((n) => {
              for (const c of positional) {
                if (c.type === "position" && c.id === n.id && c.position) {
                  return { ...n, position: c.position };
                }
                if (c.type === "select" && c.id === n.id) {
                  return { ...n, selected: c.selected };
                }
              }
              return n;
            }),
          );
        }}
        onNodeClick={onNodeClick}
        onNodeMouseEnter={(_, n) => setHoveredId(n.id as StageId)}
        onNodeMouseLeave={() => setHoveredId(null)}
        onPaneClick={() => {
          setSelectedId(null);
          setHoveredId(null);
        }}
        /* 点空白处也清掉悬停态：鼠标移出画布时我们收不到 leave 事件，
           焦点会一直留在最后一个节点上 */
        onMoveStart={() => setHoveredId(null)}
        fitView
        fitViewOptions={{ padding: 0.06, maxZoom: 1.2 }}
        minZoom={0.25}
        maxZoom={1.8}
        nodesConnectable={false}
        proOptions={{ hideAttribution: false }}
        className="nexus-flow"
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="var(--color-border-soft)" />
        {/*
          控制条放右下角。
          默认是左下角 —— 而第二行第一列那道工序正好贴着画布左边缘，
          控制条直接压在「并行构建」几个字上。
        */}
        <Controls showInteractive={false} position="bottom-right" />

        {/*
          这里原本挂了一个小地图（MiniMap），已经删掉。

          删的理由：工作台中间那栏只有约 830px 宽，而图是 752px ——
          整张图本来就一眼看得全，小地图告诉你的信息你已经在看了。
          它反而固定压在「界面设计」和「验收与交付」两个节点上，
          截图里一眼就能看出来。

          加一个让界面变差的功能不叫「更自由」。
          等「并行构建」真的裂成多个模块节点、图长到一屏放不下的时候，
          它才值得回来 —— 那时候它是导航，现在它只是遮挡。
        */}
      </ReactFlow>

      {/* 点开节点后的小结。放在画布角落而不是侧栏，
          避免和右侧「产物与成本」抢同一块地方 */}
      {selectedId && (
        <NodeSummary
          node={graph.nodes.find((n) => n.id === selectedId) ?? null}
          trace={selectedId ? tracePath(graph, selectedId) : null}
          nameOf={(id) => graph.nodes.find((n) => n.id === id)?.name ?? id}
          onClose={() => {
            setSelectedId(null);
            setHoveredId(null);
          }}
        />
      )}
    </div>
  );
}

/* ============================================================
   节点小结
   ============================================================ */

function NodeSummary({
  node,
  trace,
  nameOf,
  onClose,
}: {
  node: PipelineNode | null;
  trace: PathTrace | null;
  nameOf: (id: StageId) => string;
  onClose: () => void;
}) {
  if (!node) return null;
  const tone = nodeTone(node);
  const tint = TONE_TINT[tone];
  const empty = node.implementation === "planned";

  return (
    <div
      className="absolute bottom-3 left-3 w-72 rounded-xl border bg-[var(--color-surface)]/95 p-3 backdrop-blur"
      style={{ borderColor: `rgb(${tint} / 0.4)` }}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-1.5">
            <span
              className="font-mono text-[10px] font-semibold"
              style={{ color: `rgb(${tint})` }}
            >
              {String(node.order).padStart(2, "0")}
            </span>
            <span className="text-[13px] font-medium text-slate-100">{node.name}</span>
            <span
              className="rounded border px-1.5 py-px text-[9.5px]"
              style={{ borderColor: `rgb(${tint} / 0.5)`, color: `rgb(${tint})` }}
            >
              {nodeStatusLabel(node)}
            </span>
          </div>
          <div className="mt-1 font-mono text-[10px] text-slate-500">{node.artifact}</div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-slate-600 transition-colors duration-150 hover:text-slate-300"
          aria-label="关闭"
        >
          ✕
        </button>
      </div>

      <p className="mt-2 text-[11px] leading-relaxed text-slate-400">
        {node.rationale}
      </p>

      {empty ? (
        <p className="mt-2 border-t border-[var(--color-border-soft)] pt-2 text-[10.5px] leading-relaxed text-slate-500">
          这一道工序当前不产出契约文件，正在接入中。现在由直通模式直接跳到构建。
        </p>
      ) : (
        nodeMetrics(node).length > 0 && (
          <div className="mt-2 flex gap-4 border-t border-[var(--color-border-soft)] pt-2 text-[10.5px] tabular-nums">
            {nodeMetrics(node).map((m) => (
              <span key={m.label} className="text-slate-400">
                <span className="text-slate-500">{m.label} </span>
                {m.value}
              </span>
            ))}
          </div>
        )
      )}

      {/* 路径追踪：这条链是怎么连起来的。
          回答「这个产物是怎么来的」，是这套界面最该能回答的问题。
          画布上已经用亮度标出来了，这里再用文字说一遍 ——
          颜色是给眼睛的，文字是给确认的。 */}
      {trace && (
        <div className="mt-2 border-t border-[var(--color-border-soft)] pt-2">
          <div className="text-[10px] text-slate-500">这条链</div>
          <div className="mt-1 text-[10.5px] leading-relaxed text-slate-400">
            {describeTrace(trace, nameOf)}
          </div>
          {trace.fallbacksIntoChain.length > 0 && (
            <div className="mt-1.5 text-[10px] leading-relaxed text-amber-500/80">
              {trace.fallbacksIntoChain
                .map((f) => `${nameOf(f.from)} 失败会退回 ${nameOf(f.to)}`)
                .join("；")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ============================================================
   数据转换
   ============================================================ */

function toFlowNodes(graph: PipelineGraph, trace: PathTrace | null): Node[] {
  return graph.nodes.map((n) => {
    const tone = nodeTone(n);
    return {
      id: n.id,
      type: "stage",
      position: { x: n.x, y: n.y },
      data: {
        node: n,
        tint: TONE_TINT[tone],
        tone,
        onChain: trace ? trace.chain.has(n.id) : true,
        anyFocus: trace !== null,
      } satisfies StageNodeData,
      draggable: true,
      // 让 React Flow 知道节点尺寸，省掉一次测量导致的布局跳动
      width: LAYOUT.nodeWidth,
      height: LAYOUT.nodeHeight,
    } satisfies Node;
  });
}

/* ============================================================
   导出
   ------------------------------------------------------------
   外面套一层 Provider：React Flow 的 useReactFlow 与内部状态
   需要这个上下文，直接渲染会报错。
   ============================================================ */

export function TaskGraph(props: TaskGraphProps) {
  return (
    <ReactFlowProvider>
      <TaskGraphInner {...props} />
    </ReactFlowProvider>
  );
}

/** 供外部（比如工具栏）调用「适应窗口」 */
export function useFitView() {
  const { fitView } = useReactFlow();
  return useCallback(() => void fitView({ padding: 0.18, duration: 300 }), [fitView]);
}