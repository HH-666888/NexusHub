"use client";

import { useCallback, useMemo, useState } from "react";
import { CanvasStage } from "./canvas-stage";
import { PipelineCanvas } from "./pipeline-canvas";
import type { CostByStage } from "@/core/domain/stage-cost";
import type { GateOverride } from "@/core/pipeline/gate-policy";
import { buildPipelineGraph, tracePath } from "@/core/pipeline/graph";
import type { RunProgressInput } from "@/core/pipeline/progress";
import { pipelineBounds, PIPELINE_GEOMETRY } from "@/core/canvas/pipeline-layout";
import { STAGES } from "@/core/pipeline/stages";
import type { StageId } from "@/core/pipeline/stages";

/**
 * 画布工作台
 * ============================================================
 * 把「六道工序」画在自绘画布上。
 *
 * ── 和 /studio 里那张图的关系 ──
 *   这两处画的是同一件事，之前一处用 React Flow、一处用自绘。
 *   正在把它们合成一处：这一版做完之后 /studio 那张也会换成它，
 *   React Flow 卸掉。合成之前两处并存，是一段**有意的过渡**，
 *   不是两套设计。
 *
 * ── 为什么交互状态放在这里而不是画布里 ──
 *   画布只管"东西摆在哪、怎么平移缩放"。
 *   点了哪个节点、高亮哪条链，是这张图的业务状态 ——
 *   放进去的话，画布就不再是通用件，以后想画别的东西就得再拆一次。
 */

export interface CanvasWorkbenchProps {
  run: RunProgressInput | null;
  costByStage?: CostByStage;
  gateOverride?: GateOverride;
}

export function CanvasWorkbench({
  run,
  costByStage,
  gateOverride = "declared",
}: CanvasWorkbenchProps) {
  const [activeId, setActiveId] = useState<StageId | null>(null);

  const graph = useMemo(
    () => buildPipelineGraph({ run, costByStage, gateOverride }),
    [run, costByStage, gateOverride],
  );

  /*
    点一个节点 → 把整条上下游链都点亮。

    用 tracePath 的 `chain`（一个现成的 Set），不再自己拼 ——
    它已经处理好了"沿顺序流转边上下走、不跨越回退边"这件事。
    自己拼的话很容易把回退边也当成主链，
    于是点"验收"会连"规格化"一起点亮，而那不是它的上游。

    依赖写成 [graph, activeId] 而不是 [activeId]：
    graph 换了（切了另一次运行）而 activeId 没变时也必须重算，
    否则高亮的还是上一条运行的链。
  */
  const chain = useMemo(() => {
    if (!activeId) return null;
    return tracePath(graph, activeId).chain;
  }, [graph, activeId]);

  const bounds = useMemo(
    () => pipelineBounds(STAGES.length, PIPELINE_GEOMETRY),
    [],
  );

  const pick = useCallback(
    (id: StageId) => setActiveId((cur) => (cur === id ? null : id)),
    [],
  );

  return (
    <CanvasStage fitBounds={bounds} homeBounds={bounds}>
      <PipelineCanvas
        nodes={graph.nodes}
        chain={chain}
        activeId={activeId}
        onPick={pick}
        gateOverride={gateOverride}
      />
    </CanvasStage>
  );
}