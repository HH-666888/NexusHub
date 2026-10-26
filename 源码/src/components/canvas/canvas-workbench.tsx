"use client";

import { useCallback, useMemo, useState } from "react";
import { CanvasStage } from "./canvas-stage";
import { PipelineCanvas } from "./pipeline-canvas";
import { StageDetail } from "./stage-detail";
import type { CostByStage } from "@/core/domain/stage-cost";
import type { GateOverride } from "@/core/pipeline/gate-policy";
import { buildPipelineGraph, tracePath } from "@/core/pipeline/graph";
import { toLayoutNodes, type ChildrenByStage } from "@/core/pipeline/forest";
import type { RunProgressInput } from "@/core/pipeline/progress";
import { PANEL_GEOMETRY, WIDE_GEOMETRY, pipelineBounds } from "@/core/canvas/pipeline-layout";
import { fitFloor } from "@/core/canvas/viewport";
import { FOREST_GEOMETRY, layoutForest } from "@/core/canvas/forest-layout";
import { STAGES } from "@/core/pipeline/stages";
import type { StageId } from "@/core/pipeline/stages";

/**
 * 画布工作台
 * ============================================================
 * 把「画布」和「这张图上的业务状态」拼在一起：
 * 平移缩放交给 CanvasStage，点了哪个节点、高亮哪条链留在这里。
 *
 * ── 为什么交互状态放在这里而不是画布里 ──
 *   画布只管「东西摆在哪、怎么平移缩放」。
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
   *   一行六个是 1860 宽。放进 808 宽的面板里，自动适应会把它缩到 55% ——
   *   六个节点确实全看见了，可字看不清，等于白看。
   *   一行放不下就该换行，这是排版最基本的一件事。
   */
  variant?: "page" | "panel";
  /**
   * 每一步**内部**产出了什么，画成挂在它下面的子节点。
   *
   * **只有整页画布会真的画出来** —— 面板那一档 808×371，
   * 塞进子树之后自动适应会掉到 40% 以下，六道工序自己都读不清了。
   * 面板只当总览用，要看内部就点进 /canvas。
   *
   * 与其在面板里画一坨看不清的东西，不如干脆不画 ——
   * 「看不清就不该假装看得清」这条规矩在这里也适用。
   */
  childrenByStage?: ChildrenByStage;
}

export function CanvasWorkbench({
  run,
  costByStage,
  gateOverride = "declared",
  variant = "page",
  childrenByStage,
}: CanvasWorkbenchProps) {
  const [activeId, setActiveId] = useState<StageId | null>(null);
  const geometry = variant === "panel" ? PANEL_GEOMETRY : WIDE_GEOMETRY;
  /** 面板不画子树，见 childrenByStage 上的说明 */
  const kids = variant === "page" ? childrenByStage : undefined;
  /**
   * 自动适应的缩放下限。
   *
   *   面板实测是 808×371。摆成三列两行之后内容高 544，
   *   自动适应算出 48% —— 六个节点全看见了，可卡片只有 114×74，
   *   **字 7 像素**。一份看不清的全景图等于没看。
   *
   * 0.62 是量出来的：卡片 240×0.62 ≈ 149 宽，15px 的标题还剩 9px，
   * 正文 11px 还剩 7px —— 刚好读得出来。再小就不行了。
   *
   * ⚠️ 四分布局之后**整页画布也有了下限**（0.45），
   *    理由是同一个：左清单 17rem + 右内容 22rem 吃掉 624px，
   *    1440 屏上画布只剩 786px，按"装下整条 1860"算出 36%，
   *    档位掉到 none —— 六张卡一个字都看不见，那不是"全景"，是色块。
   *    两条线的取值和理由都在 core/canvas/viewport.ts 的 fitFloor 里
   *    （纯函数、有单测），这里只取用，不再写一遍数字。
   */
  const minFitScale = fitFloor(variant);

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

  /*
    「打开时对准哪儿」。

    ⚠️ 分两种情况，不能一律用 pipelineBounds：

      没有子树（面板那一档，或者这次运行还没跑到验收）
        → 用旧算法。它逐像素等于改之前的布局（有单测钉着）

      有子树
        → 用**森林自己的包围盒**（含子树）。
          用只按六个根算的话，「打开时看得全」会变成
          「看得全六个根、子树全在屏幕外」—— 而子树正是要给人看的东西
  */
  const bounds = useMemo(() => {
    if (!kids || Object.keys(kids).length === 0) {
      return pipelineBounds(STAGES.length, geometry);
    }
    return layoutForest(
      toLayoutNodes(
        STAGES.map((s) => s.id),
        kids,
      ),
      FOREST_GEOMETRY,
    ).bounds;
  }, [kids, geometry]);

  const pick = useCallback(
    (id: StageId) => setActiveId((cur) => (cur === id ? null : id)),
    [],
  );

  /*
    ---------- 双击聚焦 ----------
    点一个工序的双击 → 让视口装下**它整棵子树**（区域由 PipelineCanvas
    从布局的 subtree 字段里取，见那边的说明）。

    ── 为什么要有 nonce ──
      连点同一个节点两次，bounds 是同一个值 —— 只传 bounds 的话
      第二次依赖没变、effect 不触发，看起来就是"双击没反应"。
      nonce 让每次请求都是新的一次。

    ── 为什么"回到原点"不用在这里清掉它 ──
      画布那个按钮直接 fit 到 homeBounds（整片森林），
      而 focusRequest 只在 nonce 变化时才生效 ——
      所以按回去之后，那个旧的 focusRequest 不会再把人拽回来。
      这正是把它设计成"事件"而不是"状态"的原因。
  */
  const [focusRequest, setFocusRequest] = useState<{
    bounds: { x: number; y: number; w: number; h: number };
    nonce: number;
  } | null>(null);

  const focusOn = useCallback((b: { x: number; y: number; w: number; h: number }) => {
    setFocusRequest((cur) => ({ bounds: b, nonce: (cur?.nonce ?? 0) + 1 }));
  }, []);

  return (
    <div className="relative h-full w-full">
      <CanvasStage
        fitBounds={bounds}
        homeBounds={bounds}
        minFitScale={minFitScale}
        focusRequest={focusRequest}
      >
        <PipelineCanvas
          nodes={graph.nodes}
          chain={chain}
          activeId={activeId}
          onPick={pick}
          onFocusBounds={focusOn}
          geometry={geometry}
          childrenByStage={kids}
          gateOverride={gateOverride}
        />
      </CanvasStage>

      {/*
        详情面板浮在画布**上面**，不是画在世界坐标里 ——
        放进去的话它会跟着平移缩放一起漂，缩小时字糊成一团。
        而它是一块「读数面板」，该像 HUD 一样钉在屏幕上。
      */}
      <StageDetail
        node={detail?.node ?? null}
        trace={detail?.trace ?? null}
        onClose={() => setActiveId(null)}
      />
    </div>
  );
}