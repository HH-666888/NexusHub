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
import type { StageId } from "@/core/pipeline/stages";

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
  failed: "220,38,38",
  blocked: "217,119,6",
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

function StageNode({ data }: NodeProps) {
  const { node, tint, tone, onChain, anyFocus } = data as StageNodeData;

  const dim = tone === "planned";
  const empty = node.implementation === "planned";
  // 有聚焦点、又不在链上 → 压暗，让链自己浮出来
  const offChain = anyFocus && !onChain;

  return (
    <div
      className="relative overflow-hidden rounded-xl border px-3 py-2.5 transition-[box-shadow,border-color,opacity] duration-200"
      style={
        {
          width: LAYOUT.nodeWidth,
          minHeight: LAYOUT.nodeHeight,
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
  costByStage?: Partial<Record<StageId, number>>;
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