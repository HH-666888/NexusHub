"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CanvasStage } from "./canvas-stage";
import { PipelineCanvas, type CanvasRootCard } from "./pipeline-canvas";
import { StageDetail } from "./stage-detail";
import type { CostByStage } from "@/core/domain/stage-cost";
import type { GateOverride } from "@/core/pipeline/gate-policy";
import { buildPipelineGraph, tracePath } from "@/core/pipeline/graph";
import { toForestNodes, toLayoutNodes, type ChildrenByStage } from "@/core/pipeline/forest";
import type { RunProgressInput } from "@/core/pipeline/progress";
import { PANEL_GEOMETRY, WIDE_GEOMETRY, pipelineBounds } from "@/core/canvas/pipeline-layout";
import { fitFloor } from "@/core/canvas/viewport";
import { FOREST_GEOMETRY, TREE_LEVELS, layoutForest } from "@/core/canvas/forest-layout";
import {
  freshFocusFollow,
  markUserMoved,
  planFocusFollow,
  type FocusFollowMemory,
} from "@/core/canvas/focus-follow";
import { boundsFor } from "@/core/planning/viewport-policy";
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
  /**
   * 一级 Agent 根节点。**原样透传给 PipelineCanvas**，这里不加任何判断 ——
   * 「这棵树该长什么样」是调用方（服务端的投影）的事实，
   * 工作台只负责把它连同视口一起摆好。
   *
   * 唯一的另一处用途是算「打开时对准哪儿」：有根节点时，
   * 整棵三层树才是该被装进视口的东西（见下面 bounds 那段）。
   */
  rootCard?: CanvasRootCard;
  /**
   * 这一步**正在执行**的工序。它变了，视口就跟着聚焦过去。
   * 不传（或传 null）= 不自动聚焦。
   *
   * ── 为什么是"工序"而不是"节点 id" ──
   *   聚焦的目标是**那道工序整棵子树**（工序卡 + 它下面长出来的执行点）。
   *   子树的区域只有布局知道（LaidNode.subtree），所以这里给一个业务 id，
   *   由这一层去布局里查 —— 和双击聚焦走的是同一条路、同一块区域。
   *
   * ── 为什么"变了才聚焦"，而不是"每次渲染都对准它" ──
   *   每一次重渲染（服务端刷新、子树长大、窗口尺寸变化）都对准的话，
   *   用户永远没法把视口挪到别处 —— 手一松就被拽回去。
   *   这条规矩的判据、以及"用户动过之后就不跟了"那条，
   *   都在 core/canvas/focus-follow.ts 里（纯函数，有单测钉着）。
   */
  focusStageId?: StageId | null;
  /**
   * 这一次运行的**身份**。变了 = 换了另一次运行 → 自动跟随的记忆重置。
   *
   * ── 为什么不直接看 run 这个 prop ──
   *   调用方传的是一个**字面量对象**（`{ stage, status }`），每次渲染都是新的
   *   引用。拿它当 effect 的依赖，效果就是"每次重渲染都重置一次记忆"——
   *   而重置意味着"还没开始过"，于是自动聚焦永远等不到第二次变化，
   *   功能静默失效（画面不报错，只是永远不动）。
   *   所以身份要由调用方显式给：run 的 id 才是身份，stage/status 是它的内容。
   *
   * ── 重置的语义 ──
   *   换了运行 = 从头开始：用户之前在新运行上没动过视口，
   *   而且**第一个拿到的工序不算推进**（和挂载同一条规矩，见 focus-follow.ts）。
   */
  runKey?: string;
}

export function CanvasWorkbench({
  run,
  costByStage,
  gateOverride = "declared",
  variant = "page",
  childrenByStage,
  rootCard,
  focusStageId = null,
  runKey,
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

    ⚠️ 分三种情况，不能一律用 pipelineBounds：

      有根节点（三层树）
        → 用**整棵树**的包围盒（一级 Agent + 六道工序 + 各自的子树）。
          少了根的话，最上面那一层开局就在屏幕外 —— 详见下面那段

      没有根节点、但有子树
        → 用**森林自己的包围盒**（含子树）。
          用只按六个根算的话，「打开时看得全」会变成
          「看得全六个根、子树全在屏幕外」—— 而子树正是要给人看的东西

      两者都没有（面板那一档，或者这次运行还没跑到验收）
        → 用旧算法。它逐像素等于改之前的布局（有单测钉着）
  */
  const tree = useMemo(() => {
    /*
      ⚠️ 有根节点时**必须先算这一条**，不能落到下面那两条上去。

      下面那条"有子树"用的是六棵根（toLayoutNodes）的包围盒 ——
      它**不含一级 Agent**。一头扎进去的话，打开画布时自动适应装下的是
      "六道工序那片区域"，而根卡在它上面 212 像素处 ——
      于是三层树最上面那一层**开局就在屏幕外**，
      要用户自己往上拖才看得见（"还有东西在上面"这件事，不拖是看不出来的）。

      几何用的是和 PipelineCanvas 同一份（FOREST_GEOMETRY + TREE_LEVELS）：
      两边算的不是同一个东西的话，视口会"对准"一个画布上并不存在的位置。
      这也是 TREE_LEVELS 住在 core 而不是某个组件里的原因。
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
   * 整棵树的世界包围盒。三个用途，都是"整棵树"这一个意思：
   *   fitBounds   打开时对准它（默认视图）
   *   homeBounds  「回到原点」回到它
   *   fitAllBounds「看全」装下它（**忽略下限**，见 CanvasStage 的说明）
   *
   * ── 为什么在这里才落到 pipelineBounds ──
   *   它是"没有根、也没有子树"时的旧算法：那时这棵树就是六个根排成一行，
   *   pipelineBounds 逐像素等于改之前的布局（有单测钉着）。
   *   注意它用的是**当前档位的几何**（面板三列两行 / 整页一行六个）——
   *   面板上换成森林布局算会把它排成一行六个，那是另一个视图，不是这一档。
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

  /*
    ---------- 自动跟随：推进到下一步时跟过去 ----------
    规矩本身（什么时候跟、什么时候不跟）全在 core/canvas/focus-follow.ts，
    这里只做三件事：喂进去、接住答案、把答案变成一次 focusRequest。
  */
  const followRef = useRef<FocusFollowMemory>(freshFocusFollow());

  /** 用户自己动了视口 —— 由 CanvasStage 上报（拖、滚、按钮、看全） */
  const onUserMoved = useCallback(() => {
    followRef.current = markUserMoved(followRef.current);
  }, []);

  /**
   * 发一次聚焦请求（值 + nonce）。**只发请求，不判断是谁要的** ——
   * 判断留给下面两个调用方，因为"谁要的"决定了要不要关掉自动跟随。
   */
  const requestFocus = useCallback((b: { x: number; y: number; w: number; h: number }) => {
    setFocusRequest((cur) => ({ bounds: b, nonce: (cur?.nonce ?? 0) + 1 }));
  }, []);

  const focusOn = useCallback(
    (b: { x: number; y: number; w: number; h: number }) => {
      requestFocus(b);
      /*
        双击聚焦**也是用户动过视口**（他挑了一个要看的视角）。
        不记这一笔的话，他刚双击钻进某道工序，下一步一推进就被拽走 ——
        而"拽走"在这里格外难解释：进去容易出来难的视角切换没人敢用。

        ⚠️ 这一笔只能记在"用户双击"这条路上。
          自动跟随也走 requestFocus，但它**不是**用户动的手 ——
          记在这里的话，第一次自动聚焦就会把自己关掉（跟一次就再也不跟了），
          而症状是"功能只生效一次"，看起来像别的问题。
      */
      followRef.current = markUserMoved(followRef.current);
    },
    [requestFocus],
  );

  /*
    换了运行 = 从头开始。
    ⚠️ 依赖是 runKey（调用方给的运行 id），**不是 run 那个对象** ——
       run 是每次渲染都新建的字面量，拿它当依赖会把记忆每次重渲染都清一遍，
       于是"从 undefined 走到第一个值"永远成立、自动聚焦永远不触发。详见 runKey 的说明。
  */
  useEffect(() => {
    followRef.current = freshFocusFollow();
  }, [runKey]);

  useEffect(() => {
    const step = planFocusFollow(followRef.current, focusStageId);
    followRef.current = step.next;
    if (!step.focus) return;

    /*
      聚焦的区域是**布局里的 subtree**（含自己整棵子树），和双击聚焦同一块 ——
      两处要是各算各的，同一次推进和一次双击会落在两个不同的取景上。

      查不到就什么都不做（换运行的一瞬间、或者面板那一档没有森林）：
      这时候"该聚焦到哪儿"没有事实依据，宁可不动，也不猜一个位置。
    */
    const target = tree?.byId.get(step.focus);
    if (!target) return;

    /*
      走一下唯一的策略函数再设置视口。
      focus 模式下它是恒等的（返回 focusOn 本身）—— 这一行不是为了算出新值，
      而是让「自动聚焦属于 focus 模式」这件事挂在那个**唯一**的地方：
      将来加 batch 模式时，改的是 boundsFor 一个函数，
      而这里的自动聚焦会跟着它一起变成"退到看全整棵树"。
    */
    requestFocus(boundsFor("focus", target.subtree, bounds));
  }, [focusStageId, tree, bounds, requestFocus]);

  return (
    <div className="relative h-full w-full">
      <CanvasStage
        fitBounds={bounds}
        homeBounds={bounds}
        /*
          「看全」装下的是**整棵树**：有根时含根，没根时就是那片森林。
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
          nodes={graph.nodes}
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