"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CanvasStage } from "./canvas-stage";
import { PipelineCanvas, type CanvasRootCard } from "./pipeline-canvas";
import { StageDetail } from "./stage-detail";
import type { CostByStage } from "@/core/domain/stage-cost";
import type { GateOverride } from "@/core/pipeline/gate-policy";
import { buildPipelineGraph, tracePath } from "@/core/pipeline/graph";
import {
  toForestNodes,
  toLayoutNodes,
  type ChildrenByStage,
} from "@/core/pipeline/forest";
import type { RunProgressInput } from "@/core/pipeline/progress";
import {
  PANEL_GEOMETRY,
  WIDE_GEOMETRY,
  pipelineBounds,
} from "@/core/canvas/pipeline-layout";
import { fitFloor } from "@/core/canvas/viewport";
import {
  FOREST_GEOMETRY,
  TREE_LEVELS,
  layoutForest,
} from "@/core/canvas/forest-layout";
import {
  freshFocusFollow,
  markUserMoved,
  planFocusFollow,
  planUserFocus,
  type FocusFollowMemory,
  type FocusRequestMemory,
} from "@/core/canvas/focus-follow";
import { boundsFor } from "@/core/planning/viewport-policy";
import { STAGES } from "@/core/pipeline/stages";
import type { StageId } from "@/core/pipeline/stages";

/**
 * 画布工作台：把画布和这张图上的业务状态拼在一起。
 * 平移缩放交给 CanvasStage，点了哪个节点、高亮哪条链留在这里 ——
 * 交互状态放进画布的话，画布就不再是通用件。
 */

export interface CanvasWorkbenchProps {
  run: RunProgressInput | null;
  costByStage?: CostByStage;
  gateOverride?: GateOverride;
  /**
   * 摆在哪儿。page 是整页画布（屏幕宽，一行六个），panel 是工作台面板（八百来像素，三列两行）。
   * 一行六个是 1860 宽，放进 808 宽的面板里会缩到 55%：全都看见了，字却读不清。
   */
  variant?: "page" | "panel";
  /**
   * 每步内部的产物，画成挂在工序下的子节点。只有整页画布真的画 ——
   * 面板那一档 808×371，塞进子树之后自动适应会掉到 40% 以下，看不清楚就不该假装看得清。
   */
  childrenByStage?: ChildrenByStage;
  /**
   * 一级 Agent 根节点，原样透传给 PipelineCanvas：这棵树该长什么样是服务端投影的事实。
   * 这里唯一的另一处用途是算“打开时对准哪儿”—— 有根节点时装进视口的是整棵三层树。
   */
  rootCard?: CanvasRootCard;
  /**
   * 这一步正在执行的工序，变了视口就聚焦过去。给的是业务 id 而不是节点 id：
   * 聚焦目标是那道工序的整棵子树，区域只有布局知道（LaidNode.subtree）。
   *
   * 只在“变了”的时候聚焦。每次渲染都对准的话，用户永远没法把视口挪到别处 ——
   * 手一松就被拽回去。判据在 core/canvas/focus-follow.ts（纯函数，有单测）。
   */
  focusStageId?: StageId | null;
  /**
   * 这一次运行的身份。变了 = 换了另一次运行，自动跟随的记忆重置。
   * 不能拿 run 这个 prop 当身份：调用方传的是字面量对象，每次渲染都是新引用，
   * 拿它当依赖等于每次重渲染都重置一次记忆，自动聚焦永远等不到第二次变化。
   */
  runKey?: string;
  /**
   * 用户在左侧清单里点名要看的那一个任务点（`?focus=<节点 id>`）。
   *
   * 它和 focusStageId 是两个概念：那个是自动跟随，没人要求视角变化，所以必须让着用户，
   * 用户一动过视口就不许再跟；这个是用户自己点了清单里的一行，是“我要看这个”本身。
   * 后者必须无视前者那条禁令 —— 否则用户拖过画布再点清单，点了没反应，
   * 他会以为清单坏了。点名同时记一笔“用户动过视口”，把这一趟的自动跟随关掉。
   *
   * 找不到对应节点时什么都不做：清单里有些行在画布上没有卡片（比如规格化产出的
   * 验收条目），URL 也可能被手写成一个不存在的 id。猜一个位置比不动更坏。
   */
  focusRequestId?: string | null;
  /**
   * 空画布：还没有任何选中的运行时不画工序卡。
   * 六道工序是"这次运行的六道工序"，连运行都没有的时候画出来，
   * 等于替用户先承诺了一件还没发生的事。
   */
  empty?: boolean;
}

export function CanvasWorkbench({
  run,
  costByStage,
  gateOverride = "declared",
  variant = "page",
  childrenByStage,
  rootCard,
  focusStageId = null,
  focusRequestId = null,
  runKey,
  empty = false,
}: CanvasWorkbenchProps) {
  const [activeId, setActiveId] = useState<StageId | null>(null);
  const geometry = variant === "panel" ? PANEL_GEOMETRY : WIDE_GEOMETRY;
  /** 面板不画子树，见 childrenByStage 上的说明 */
  const kids = variant === "page" ? childrenByStage : undefined;
  /**
   * 自动适应的缩放下限。面板 808×371 摆成三列两行后内容高 544，
   * 自动适应算出 48%，卡片只剩 114×74、字 7 像素 —— 看不清的全景等于没看。
   * 0.62 是量出来的：240×0.62 ≈ 149 宽，15px 标题还剩 9px，正文 11px 还剩 7px。
   * 四分布局之后整页画布也有下限（0.45），取值都在 core/canvas/viewport.ts 的 fitFloor 里。
   */
  const minFitScale = fitFloor(variant);

  const graph = useMemo(
    () => buildPipelineGraph({ run, costByStage, gateOverride }),
    [run, costByStage, gateOverride],
  );

  /*
    点一个节点 → 把整条上下游链都点亮。用 tracePath 的 chain，它已经处理好
    “沿顺序流转边上下走、不跨越回退边”—— 自己拼很容易把回退边当成主链。
    依赖带上 graph：切了另一次运行而 activeId 没变时也必须重算。
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
    “打开时对准哪儿”分三种情况：有根节点用整棵树的包围盒（少了根，最上面那层
    开局就在屏幕外）；没有根但有子树用森林自己的包围盒（否则子树全在屏幕外）；
    两者都没有才用旧算法，它逐像素等于改之前的布局。
  */
  const tree = useMemo(() => {
    /*
      有根节点时必须先算这一条。下面那条“有子树”用的是六棵根（toLayoutNodes）的
      包围盒，不含一级 Agent —— 一头扎进去的话根卡开局就在屏幕外 212 像素处。

      几何和 PipelineCanvas 用同一份（FOREST_GEOMETRY + TREE_LEVELS）：
      两边算的不是同一个东西的话，视口会“对准”一个画布上并不存在的位置。
    */
    if (rootCard) {
      return layoutForest(
        toForestNodes(
          rootCard.id,
          STAGES.map((s) => s.id),
          kids ?? {},
        ),
        { ...FOREST_GEOMETRY, levels: TREE_LEVELS },
      );
    }

    /* 面板那一档，或者这次运行还没跑到验收 → 没有三层树可算，见下面 bounds 那条 */
    if (!kids || Object.keys(kids).length === 0) return null;

    return layoutForest(
      toLayoutNodes(
        STAGES.map((s) => s.id),
        kids,
      ),
      FOREST_GEOMETRY,
    );
  }, [kids, rootCard]);

  /**
   * 整棵树的世界包围盒。三个用途都是“整棵树”这一个意思：
   * fitBounds 打开时对准它，homeBounds 回到它，fitAllBounds 看全它（忽略下限）。
   *
   * 落到 pipelineBounds 时用的是当前档位的几何（面板三列两行 / 整页一行六个）——
   * 面板上换成森林布局算会把它排成一行六个，那是另一个视图。
   */
  const bounds = useMemo(
    () => tree?.bounds ?? pipelineBounds(STAGES.length, geometry),
    [tree, geometry],
  );

  const pick = useCallback(
    (id: StageId) => setActiveId((cur) => (cur === id ? null : id)),
    [],
  );

  /*
    双击聚焦：让视口装下它整棵子树（区域由 PipelineCanvas 从布局的 subtree 取）。
    带 nonce 是因为连点同一个节点两次 bounds 是同一个值，只看值第二次不触发。

    “回到原点”不用清掉它：画布那个按钮直接 fit 到 homeBounds，
    而 focusRequest 只在 nonce 变化时生效 —— 这正是把它设计成事件而不是状态的原因。
  */
  const [focusRequest, setFocusRequest] = useState<{
    bounds: { x: number; y: number; w: number; h: number };
    nonce: number;
  } | null>(null);

  /*
    自动跟随：推进到下一步时跟过去。规矩（什么时候跟、什么时候不跟）全在
    core/canvas/focus-follow.ts，这里只喂进去、接住答案、把答案变成一次 focusRequest。
  */
  const followRef = useRef<FocusFollowMemory>(freshFocusFollow());

  /** 用户自己动了视口 —— 由 CanvasStage 上报（拖、滚、按钮、看全） */
  const onUserMoved = useCallback(() => {
    followRef.current = markUserMoved(followRef.current);
  }, []);

  /**
   * 发一次聚焦请求（值 + nonce）。只发请求，不判断是谁要的 ——
   * 判断留给调用方，因为“谁要的”决定了要不要关掉自动跟随。
   */
  const requestFocus = useCallback(
    (b: { x: number; y: number; w: number; h: number }) => {
      setFocusRequest((cur) => ({ bounds: b, nonce: (cur?.nonce ?? 0) + 1 }));
    },
    [],
  );

  const focusOn = useCallback(
    (b: { x: number; y: number; w: number; h: number }) => {
      requestFocus(b);
      /*
        双击聚焦也是用户动过视口（他挑了一个要看的视角）。不记这一笔的话，
        他刚双击钻进某道工序，下一步一推进就被拽走。

        这一笔只能记在“用户双击”这条路上：自动跟随也走 requestFocus，
        记在那里的话第一次自动聚焦就会把自己关掉，症状是“功能只生效一次”。
      */
      followRef.current = markUserMoved(followRef.current);
    },
    [requestFocus],
  );

  /*
    换了运行 = 从头开始。依赖是 runKey（调用方给的运行 id），不是 run 那个对象 ——
    run 是每次渲染都新建的字面量，拿它当依赖会把记忆每次都清一遍，自动聚焦永远不触发。
  */
  useEffect(() => {
    followRef.current = freshFocusFollow();
  }, [runKey]);

  useEffect(() => {
    const step = planFocusFollow(followRef.current, focusStageId);
    followRef.current = step.next;
    if (!step.focus) return;

    /*
      聚焦区域是布局里的 subtree（含自己整棵子树），和双击聚焦同一块 ——
      两处各算各的，同一次推进和一次双击会落在两个不同的取景上。
      查不到就什么都不做：换运行的一瞬间、或者面板那一档没有森林。
    */
    const target = tree?.byId.get(step.focus);
    if (!target) return;

    /*
      走一下唯一的策略函数再设置视口。focus 模式下它是恒等的 ——
      这一行是为了让“自动聚焦属于 focus 模式”挂在唯一的地方：
      将来加 batch 模式时改 boundsFor 一个函数，这里会跟着变。
    */
    requestFocus(boundsFor("focus", target.subtree, bounds));
  }, [focusStageId, tree, bounds, requestFocus]);

  /*
    用户点名：点清单里的一行，视口聚焦到那个任务点。
    完整理由写在 focusRequestId 那个 prop 上，判据在 planUserFocus 里（有单测）。
    这里的形状和上面那条自动跟随相同，是故意的：差别在判据里，不在形状里。
  */
  const userFocusRef = useRef<FocusRequestMemory>(null);

  useEffect(() => {
    const step = planUserFocus(userFocusRef.current, focusRequestId);
    userFocusRef.current = step.next;
    if (!step.go) return;

    /*
      查不到就什么都不做：清单里有、画布上没画的行（规格化的验收条目），
      以及 URL 被手写成不存在的 id，都不是故障。
      这时连“用户动过视口”都不记 —— 什么都没发生时不该留下任何痕迹。
    */
    const target = tree?.byId.get(step.go);
    if (!target) return;

    /*
      先记一笔“用户动过视口”，再发请求。这不是绕过那条禁令，而是“用户说了算之后，
      这一趟就由他说了算”：他刚点进某个执行点看细节，下一步一推进就被拽走的话，
      点名这个功能就等于白点。

      这一笔只能记在用户点名这条路上。记在 requestFocus 里就错了 ——
      自动跟随也走那儿，那样记一下等于“跟一次就再也不跟”。
    */
    followRef.current = markUserMoved(followRef.current);

    /*
      只走 boundsFor("focus", …) 这一条策略，区域是 target.subtree
      （含自己整棵子树，见 LaidNode.subtree）——
      和双击、自动跟随是同一块。三处要是各算各的，
      同一次点名和一次双击会落在两个不同的取景上。
    */
    requestFocus(boundsFor("focus", target.subtree, bounds));
  }, [focusRequestId, tree, bounds, requestFocus]);

  return (
    <div className="relative h-full w-full">
      <CanvasStage
        fitBounds={bounds}
        homeBounds={bounds}
        /*
          “看全”装下的是**整棵树**：有根时含根，没根时就是那片森林。
          它和 fitBounds 是同一个值 —— 区别不在区域，在**下限**：
          默认路径传 minFitScale（宁可切掉边角也要读得清），
          看全把它传成 0（用户明确要看全局）。取舍写在 canvas-stage 的 fitAll 上。
        */
        fitAllBounds={bounds}
        minFitScale={minFitScale}
        focusRequest={focusRequest}
        onUserMoved={onUserMoved}
      >
        <PipelineCanvas
          nodes={empty ? [] : graph.nodes}
          chain={chain}
          activeId={activeId}
          onPick={pick}
          onFocusBounds={focusOn}
          geometry={geometry}
          childrenByStage={kids}
          gateOverride={gateOverride}
          rootCard={rootCard}
        />
      </CanvasStage>

      {/*
        详情面板浮在画布**上面**，不是画在世界坐标里 ——
        放进去的话它会跟着平移缩放一起漂，缩小时字糊成一团。
        而它是一块“读数面板”，该像 HUD 一样钉在屏幕上。
      */}
      <StageDetail
        node={detail?.node ?? null}
        trace={detail?.trace ?? null}
        onClose={() => setActiveId(null)}
      />
    </div>
  );
}
