"use client";

import { useCallback, useMemo, useState } from "react";
import { CanvasStage } from "./canvas-stage";
import { PipelineCanvas } from "./pipeline-canvas";
import { StageDetail } from "./stage-detail";
import type { CostByStage } from "@/core/domain/stage-cost";
import type { GateOverride } from "@/core/pipeline/gate-policy";
import { buildPipelineGraph, tracePath } from "@/core/pipeline/graph";
import type { RunProgressInput } from "@/core/pipeline/progress";
import { pipelineBounds, PANEL_GEOMETRY, WIDE_GEOMETRY } from "@/core/canvas/pipeline-layout";
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
  /**
   * 摆在哪儿。
   *
   *   page    整页画布（/canvas）—— 屏幕宽，一行六个
   *   panel   工作台面板（/studio?tab=graph）—— 八百来像素，三列两行
   *
   * ── 为什么必须分两档 ──
   *   一行六个是 1840 宽。放进 830 宽的面板里，自动适应会把它缩到 37% ——
   *   六个节点确实全看见了，可**字看不清**，等于白看。
   *   一行放不下就该换行，这是排版最基本的一件事。
   */
  variant?: "page" | "panel";
}

export function CanvasWorkbench({
  run,
  costByStage,
  gateOverride = "declared",
  variant = "page",
}: CanvasWorkbenchProps) {
  const [activeId, setActiveId] = useState<StageId | null>(null);
  const geometry = variant === "panel" ? PANEL_GEOMETRY : WIDE_GEOMETRY;
  /**
   * 自动适应的缩放下限。
   *
   * 面板实测是 808×371。摆成三列两行之后内容高 544，
   * 自动适应算出 48% —— 六个节点全看见了，可卡片只有 114×74，
   * **字 7 像素**。一份看不清的全景图等于没看。
   *
   * 0.62 是量出来的：卡片 240×0.62 ≈ 149 宽，15px 的标题还剩 9px，
   * 正文 11px 还剩 7px —— 刚好读得出来。再小就不行了。
   *
   * 代价是纵向要平移一下（内容 337 高、可视 259）。
   * 平移本来就是无限画布该干的事，而"读不清"是没有补救的。
   */
  const minFitScale = variant === "panel" ? 0.62 : 0;

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

  /** 选中那一道的详情。没选中就是 null */
  const detail = useMemo(() => {
    if (!activeId) return null;
    return {
      node: graph.nodes.find((n) => n.id === activeId) ?? null,
      trace: tracePath(graph, activeId),
    };
  }, [graph, activeId]);

  const bounds = useMemo(
    () => pipelineBounds(STAGES.length, geometry),
    [geometry],
  );

  const pick = useCallback(
    (id: StageId) => setActiveId((cur) => (cur === id ? null : id)),
    [],
  );

  return (
    <div className="relative h-full w-full">
      <CanvasStage fitBounds={bounds} homeBounds={bounds} minFitScale={minFitScale}>
        <PipelineCanvas
          nodes={graph.nodes}
          chain={chain}
          activeId={activeId}
          onPick={pick}
          geometry={geometry}
          gateOverride={gateOverride}
        />
      </CanvasStage>

      {/*
        详情面板浮在画布**上面**，不是画在世界坐标里 ——
        放进去的话它会跟着平移缩放一起漂，缩小时字糊成一团。
        而它是一块"读数面板"，该像 HUD 一样钉在屏幕上。
      */}
      <StageDetail node={detail?.node ?? null} trace={detail?.trace ?? null} onClose={() => setActiveId(null)} />
    </div>
  );
}