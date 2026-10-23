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
  LAYOUT,
  nodeMetrics,
  nodeStatusLabel,
  nodeTone,
  type NodeTone,
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
  selected: boolean;
}

function StageNode({ data }: NodeProps) {
  const { node, tint, tone } = data as StageNodeData;

  const dim = tone === "planned";
  const empty = node.implementation === "planned";

  return (
    <div
      className="relative overflow-hidden rounded-xl border px-3 py-2.5 transition-[box-shadow,border-color] duration-150"
      style={
        {
          width: LAYOUT.nodeWidth,
          minHeight: LAYOUT.nodeHeight,
          borderColor: `rgb(${tint} / ${dim ? 0.3 : 0.45})`,
          backgroundColor: "var(--color-surface)",
          backgroundImage: dim
            ? undefined
            : `linear-gradient(150deg, rgb(${tint} / 0.16) 0%, rgb(${tint} / 0.04) 55%, transparent 100%)`,
          boxShadow:
            tone === "running"
              ? `0 0 0 1px rgb(${tint} / 0.8), 0 0 26px -8px rgb(${tint} / 0.95)`
              : dim
                ? undefined
                : `0 0 18px -12px rgb(${tint} / 0.9)`,
          opacity: dim ? 0.55 : 1,
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

  // React Flow 的节点状态（拖动位置等）由它自己管，这里只做初始值
  const [nodes, setNodes] = useState<Node[]>(() => toFlowNodes(graph));
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // 图数据变了（切换运行、跑完一轮）就重建节点，但保留用户拖过的位置
  const graphKey = useMemo(
    () => `${run?.stage ?? "-"}|${run?.status ?? "-"}|${JSON.stringify(costByStage ?? {})}`,
    [run, costByStage],
  );
  const [lastKey, setLastKey] = useState(graphKey);
  if (lastKey !== graphKey) {
    setLastKey(graphKey);
    setNodes(toFlowNodes(graph));
  }

  const edges: Edge[] = useMemo(
    () =>
      graph.edges
        .filter((e) => e.kind === "flow" || showFallback)
        .map((e) => {
          const fallback = e.kind === "fallback";
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
            style: fallback
              ? { stroke: "rgba(217,119,6,.55)", strokeDasharray: "5 5", strokeWidth: 1.2 }
              : { stroke: "rgba(148,163,184,.35)", strokeWidth: 1.2 },
            labelStyle: { fill: "var(--ink-6)", fontSize: 9 },
            zIndex: fallback ? 0 : 1,
          } satisfies Edge;
        }),
    [graph.edges, showFallback],
  );

  const onNodeClick = useCallback((_: unknown, n: Node) => {
    setSelectedId(n.id);
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
          setNodes((prev) =>
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
        onPaneClick={() => setSelectedId(null)}
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
      </ReactFlow>

      {/* 点开节点后的小结。放在画布角落而不是侧栏，
          避免和右侧「产物与成本」抢同一块地方 */}
      {selectedId && (
        <NodeSummary
          node={graph.nodes.find((n) => n.id === selectedId) ?? null}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}

/* ============================================================
   节点小结
   ============================================================ */

function NodeSummary({ node, onClose }: { node: PipelineNode | null; onClose: () => void }) {
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
    </div>
  );
}

/* ============================================================
   数据转换
   ============================================================ */

function toFlowNodes(graph: PipelineGraph): Node[] {
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
        selected: false,
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