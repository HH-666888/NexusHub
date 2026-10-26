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
import { useAnimatedLayout } from "./use-animated-layout";

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

/**
 * 一级 Agent 根节点 —— 三层树最上面那一层。
 *
 * ⚠️ 这里的 status **必须来自真实投影**，调用方不许写死。
 *    它是 core/planning/from-run.ts 从这条运行的事件里投影出来的
 *    那个任务点的状态（task-point.ts 的 TaskPointStatus 八档之一）。
 *    一级 Agent 的"总规划"这一步真接入了没有，就显示成什么样：
 *    投影说 pending 就画 pending 的样子 —— **那是实话，不是缺陷**。
 *    画一个好看的「已完成」，而它其实一行规划都没跑过，
 *    是这个项目最不能接受的那类谎（见文件头那条硬约束）。
 */
export interface CanvasRootCard {
  id: string;
  title: string;
  subtitle?: string;
  status: TaskPointStatus;
}

export interface PipelineCanvasProps {
  nodes: readonly PipelineNode[];
  /** 高亮的节点。点了某个节点之后，整条上下游链上的都是它 */
  chain?: ReadonlySet<StageId> | null;
  activeId?: StageId | null;
  onPick?: (id: StageId) => void;
  /**
   * 双击一个工序 → 请画布聚焦到它**整棵子树**。
   *
   * 为什么传区域而不是传节点 id：
   *   区域是布局算出来的（LaidNode.subtree，"含自己整棵子树"那个字段），
   *   而画布只负责"把这块区域装进视口"。让画布自己去查布局的话，
   *   它就得认识森林数据结构 —— 那是业务，不是画布该知道的事。
   */
  onFocusBounds?: (bounds: { x: number; y: number; w: number; h: number }) => void;
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
  /**
   * 一级 Agent 根节点。**不传 = 还是现在的六根并列**（面板等旧用法不受影响）。
   *
   * ── 为什么做成可选 prop，而不是"画布自此就是三层树" ──
   *   画布有三个使用者，它们看到的树**不是同一棵**：
   *     /canvas 整页   —— 选中一条运行时，它有一级 Agent，是三层树
   *     工作台面板     —— 退役页面的总览，只有六道工序
   *     没选中运行的整页 —— 连"这次运行"都还没有，谈不上根节点
   *   把"是不是三层"做成画布的内部约定，上面三种情况就有两种要造假：
   *   要么凭空画一个不存在的一级 Agent，要么把一棵完整的树拆掉一层。
   *   做成入参之后，**画布只负责画它拿到的那棵树**，
   *   "这棵树该长什么样"留在有事实的那一层（服务端的投影）。
   *
   * ── 不传时逐像素不变 ──
   *   这条不是口号：布局走的是原来那条 toLayoutNodes + 不带 levels 的路，
   *   连 `levels` 这个键都不出现（有单测钉着「不传 levels ≡ 传 levels: {}」）。
   */
  rootCard?: CanvasRootCard;
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
  failedKids,
  onPick,
  onFocus,
}: {
  node: PipelineNode;
  /**
   * 这一帧画在哪。
   *
   * 类型写的是 NodeRect，但**实际传进来的是 LaidNode** ——
   * 布局多给了一句 childCount（这棵树有几个孩子），角标要用它。
   * 这里顺手把它标进类型里，免得渲染层去 as 一把。
   */
  rect: NodeRect & { childCount?: number };
  tint: string;
  active: boolean;
  dimmed: boolean;
  /** 子树里没通过几项。由 summarizeChildren 算好，见下面角标那段 */
  failedKids: number;
  onPick?: (id: StageId) => void;
  /** 双击 —— 聚焦到这棵树。区域由外面给（只有布局知道子树多大） */
  onFocus?: () => void;
}) {
  const empty = node.implementation === "planned";
  const tone = toneOf(node);
  const running = node.status === "running" && !empty;

  /** 子树有几个孩子（没有子树就是 0）。角标只在大于 0 时才画 */
  const childCount = rect.childCount ?? 0;
  /** 全过是绿的，有一项没过就是红的 —— 和子方块、状态胶囊同一套颜色 */
  const kidsTone = failedKids === 0 ? "74 222 128" : "248 113 113";

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
          /*
            ⚠️ 用 transform 而不是 left/top —— 和子卡同一个理由：
            动画每帧都要改位置，left/top 会每帧触发布局重算。
            配 transform-origin: 0 0，translate(x,y) 和 left:x; top:y
            落在同一个位置上，坐标含义不变。
          */
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
      /*
        双击聚焦到这棵树。

        ── 为什么是双击而不是单击 ──
          单击已经用来"点亮整条上下游链"了（那是查看依赖）。
          聚焦是**换视角**，动作更重，给双击正合适 ——
          而且它和"双击进入文件夹"是同一个肌肉记忆。
      */
      onDoubleClick={(e) => {
        e.stopPropagation(); // 别让双击穿透到画布（那里也可能有双击回全局）
        onFocus?.();
      }}
      title="单击高亮上下游链 · 双击聚焦到这棵树"
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
        {/* 右边这一组：子树角标 + 状态胶囊（角标在胶囊左边，紧挨着） */}
        <div className="flex items-center gap-1">
          {/*
            ---------- 子树角标 ----------
            挂在「验收」下面的七项检查，不展开子树就看不见结论。
            这个角标把结论直接写在卡上：7/7 全过，6/7 有一项没过。

            ⚠️ 这两个数**早就有人算好了**。
               core/pipeline/forest.ts 的 summarizeChildren 从写下那天起
               就在算"过了几项、错了几项"，注释里也写明
               「画布上要用它给「验收」那张卡加一个角标（"7/7"）」——
               但**从来没有人调用过它**。布局那边的 childCount 一样，
               注释写着「界面上要显示「8 条」这种角标」，也没人渲染。
               所以这里补的不是新功能，是把一根早就铺好的线接上。

            没有子树（childCount 为 0）就整个不画 ——
            画一个「0/0」等于给六张卡都添一句废话。
          */}
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
   一级 Agent（三层树的根）
   ============================================================ */

/**
 * 画布最上面那张卡 —— 一级 Agent。
 *
 * ── 为什么它和 StageCard 长得一样，却不是一个组件 ──
 *   一样的部分（**必须一样**）：边框、底色渐变、顶部那条细亮线、圆角、
 *   状态胶囊、用 transform 摆放。用户的原话是「只是位置上的区分，
 *   卡片样式先不区分」—— 层级感由**结构和连线**给，不由样式给。
 *   所以下面那些 class 是照着 StageCard 抄的，改那边的时候要一起看。
 *
 *   不一样的部分（**必须不一样**）：它没有 01..06 那种序号，也不该有。
 *   序号是"这是第几道工序"的意思，而根节点不是第 0 道工序 ——
 *   它是**管这六道的那一个**。所以标识换成 ◆ AGENT。
 *   另外它没有权限胶囊、没有"看什么数"、没有花费：那些都是工序的属性，
 *   一级 Agent 这一期还不产出这些东西，硬填上去就是编。
 *
 * ── 状态色是算出来的，不是挑出来的 ──
 *   颜色走内核对所有视图唯一的那一份映射（status → statusTone → TONE_RGB），
 *   和左侧清单那一行是同一个色值。所以"清单里蓝的、画布上也是蓝的"
 *   这件事不靠约定，靠它俩调的是同一个函数。
 *
 * ── 关于 pending ──
 *   一级 Agent 的"总规划"这一步目前还没有真接入。它真实的状态就是
 *   投影算出来的那个（常常是 pending）—— **照实画**。
 *   一个灰的「待执行」比一个假的「已完成」有价值得多：
 *   前者告诉你这块还没接上，后者让你以为可以验收了。
 */
function RootCard({
  card,
  rect,
  entering = false,
}: {
  card: CanvasRootCard;
  /** 这一帧画在哪。和 StageCard 一样，实际传进来的是 LaidNode（要它的 childCount） */
  rect: NodeRect & { childCount?: number };
  entering?: boolean;
}) {
  const tone = statusTone(card.status);
  const rgb = TONE_RGB[tone];
  /*
    正在跑的那一档给一点脉冲。
    用 Tailwind 现成的 animate-pulse + motion-reduce:animate-none，
    而不是自己写 keyframes：**prefers-reduced-motion 下必须不动**，
    而"自己写动画就忘了关"是这个项目里反复出现过的毛病
    （见 globals.css 那一节）。现成的 motion-reduce: 变体让这条不可能被忘掉。
  */
  const running = card.status === "running";
  /** 它管着几道工序。这个数是布局给的（LaidNode.childCount），不是写死的 6 */
  const stages = rect.childCount ?? 0;

  return (
    <div
      /*
        ⚠️ 属性名是 data-pipeline-root，和工序卡的 data-pipeline-stage 分开。
        e2e 数「六道工序」用的是后者 —— 两张卡共用一个属性名的话，
        "恰好六个"会变成七个，而那种错只有数数才发现（和 StageCard 那段同一个坑）。
      */
      data-pipeline-root={card.id}
      /*
        状态**原样**写进 DOM，连 statusTone 都不参与 ——
        好让"界面上显示的到底是哪一档"可以被直接读出来断言，
        而不是从颜色上反推。反推的话，"颜色配错了"和"状态传错了"
        在测试里长得一模一样。
      */
      data-root-status={card.status}
      data-root-tone={tone}
      /*
        这张卡为状态挑的那个色值（TONE_RGB 里的三段），原样写进 DOM。
        为什么不靠读计算样式：胶囊是 `data-canvas-label="minor"`，
        缩到一定档位时它的文字本来就是**透明的**（"缩小时字让位"，
        见 globals.css）—— 那时候读到的颜色是 rgba(0,0,0,0)，
        而"状态色配错了"和"现在这一档把字藏了"在测试里长得一模一样。
        写出来之后，e2e 可以直接拿它和左侧清单里同状态那一行的色点比。
      */
      data-root-rgb={rgb}
      data-root-entering={entering ? "1" : undefined}
      /*
        pointer-events-auto 的理由和工序卡一样：
        世界坐标那层是 pointer-events-none（拖着空白处才能平移画布）。
      */
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
        // 刚长出来的时候从透明淡入 —— 和子方块同一个理由（见 ChildChip）
      }}
    >
      {/* 顶部细亮线。和工序卡、子方块是同一件事：说明这一格是"活的" */}
      <span
        aria-hidden
        className="absolute inset-x-0 top-0 h-px"
        style={{ background: `linear-gradient(90deg, transparent, rgb(${rgb} / 0.9), transparent)` }}
      />

      {/* ---------- 第一行：标识 + 状态胶囊 ----------
          和 StageCard 那一行同构，只是把「点 + 序号 01」换成「◆ AGENT」 */}
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

      {/* ---------- 标题 / 副标题 ---------- */}
      <div
        data-root-title
        data-canvas-label="major"
        className="mt-2 text-[15px] leading-tight font-medium text-slate-100"
      >
        {card.title}
      </div>
      {card.subtitle && (
        <div data-root-subtitle data-canvas-label="minor" className="mt-0.5 font-mono text-[10.5px] text-slate-500">
          {card.subtitle}
        </div>
      )}

      {/* ---------- 它管着几道工序 ----------
          数字来自布局，不是写死的 6 —— 树形变了这里自己就跟着变。
          没有它的话卡片下半截是一片空，而"它是这六道的上一层"
          这件事就只剩位置在表达了。

          ⚠️ 里面两个 span **也**标 data-canvas-label="minor"。
             tier 规则靠的就是这个属性（globals.css 里那条选择器只认
             `[data-canvas-label="minor"]`，而且必须 !important 才压得住内联色）；
             只标外层的话，内层这两个带文字颜色的 span 不在选择器射程里，
             缩小到 62% 以下它们**照样显示** —— 一行 4 像素的暗色小字，
             正是"缩小时字让位"要消灭的那种灰渣。
             （StageCard 的花费那一行是同样的结构、同样的毛病，
               属于既有代码，这一次没动它。） */}
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
function ChildChip({
  rect,
  child,
  entering = false,
}: {
  rect: NodeRect;
  child: StageChild;
  /** 这一帧刚冒出来 —— 要淡入 */
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
      /*
        pointer-events-auto 的理由和主卡一样：
        世界坐标那层是 pointer-events-none（为了拖着空白处能平移画布），
        子卡得自己把事件收回来。
      */
      className="pointer-events-auto absolute overflow-hidden rounded-xl border px-3 py-2.5 transition-opacity duration-200"
      style={{
        /*
          ⚠️ 用 transform 而不是 left/top —— 和主卡同一个理由。

          两个好处：
            一、left/top 的动画会**每帧触发布局重算**（reflow），
                而 transform 只走合成层，三十个方块同时动也不掉帧；
            二、生长动画本身就是位移，用 left/top 写等于每帧重排一次版。
          配 transform-origin: 0 0，坐标含义和 left/top 完全一致 ——
          translate(x, y) 落在同一个位置上。
        */
        transform: `translate(${rect.x}px, ${rect.y}px)`,
        transformOrigin: "0 0",
        width: rect.w,
        height: rect.h,
        /*
          刚冒出来的方块从透明淡入。
          光有尺寸插值不够 —— 一个从 0 长到 172×112 的方块如果
          一上来就是全不透明，看起来像"弹出来"而不是"长出来"。
        */
        opacity: entering ? 0.25 : 1,
        borderColor: `rgb(${tone} / 0.45)`,
        backgroundColor: "var(--color-surface)",
        backgroundImage: `linear-gradient(150deg, rgb(${tone} / 0.14) 0%, rgb(${tone} / 0.03) 58%, transparent 100%)`,
      }}
    >
      {/* 顶部细亮线。和主卡同一件事：说明这一格是"活的" */}
      <span
        aria-hidden
        className="absolute inset-x-0 top-0 h-px"
        style={{ background: `linear-gradient(90deg, transparent, rgb(${tone} / 0.9), transparent)` }}
      />

      {/* ---------- 第一行：状态点 + 状态胶囊 ----------
          和主卡那一行同构（主卡是「点 + 序号 01」+ 状态胶囊）。
          点和胶囊都在说同一个 tone，看着重复 —— 但主卡也是这么重复的，
          而用户要的正是"同一套"，所以这里保持一致而不是自作主张去掉一个。 */}
      <div className="flex items-start justify-between gap-2">
        <span
          aria-hidden
          className="mt-1 inline-block h-1.5 w-1.5 flex-none rounded-full"
          style={{ background: `rgb(${tone})`, boxShadow: `0 0 9px 1px rgb(${tone} / 0.6)` }}
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

      {/* ---------- 名称。对应主卡的「规格化」那一行 ---------- */}
      <div
        data-canvas-label="major"
        className="mt-1.5 truncate text-[13px] leading-tight font-medium text-slate-100"
      >
        {child.label}
      </div>

      {/* ---------- 判定依据。对应主卡的「产物名 / 看什么数」----------
          两行截断：依据有长有短，不截会把卡片撑破（高度是布局算死的）。 */}
      <div
        data-child-detail
        data-canvas-label="minor"
        className="mt-0.5 line-clamp-2 text-[10.5px] leading-snug text-slate-500"
      >
        {child.detail}
      </div>

      {/* ---------- 关键字胶囊。对应主卡那排「AI·干活」「要人点头」----------
          ★ 现在是占位符「——」，见 core/pipeline/forest.ts 的 CHILD_PLACEHOLDER。 */}
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

      {/* ---------- 分隔线 + 数值。对应主卡的「花费 ¥0.0082」----------
          ★ 同样是占位符。 */}
      <div
        data-child-metric
        data-canvas-label="minor"
        className="mt-1.5 border-t pt-1 text-[10.5px] tabular-nums text-slate-500"
        style={{ borderColor: `rgb(${tone} / 0.15)` }}
      >
        {child.metric}
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
 *
 * @param threeLayer 画的是不是三层树（也就是有没有一级 Agent 根节点）。
 *   只有它为 true 时才会带上 levels —— 见下面那段。
 */
function forestGeometryOf(g: CanvasPipelineGeometry, threeLayer: boolean): ForestGeometry {
  return {
    ...FOREST_GEOMETRY,
    root: { w: g.nodeW, h: g.nodeH, gapX: g.gapX, perRow: g.perRow },
    rowOffsetY: g.rowOffsetY,
    // 根节点换行时两行之间的距离，沿用画布那套的 gapY
    // （它已经保证装得下回退弧线了 —— 这正是 gapY 当年被定成 136 的原因）
    rootRowGap: g.gapY,
    /*
      ---------- 三层树才有 levels ----------
      ⚠️ 不画根节点时**连这个键都不出现**（不是 levels: undefined）：
         「不传 levels ≡ 传 levels: {}」那条单测守的是同一个意思，
         但"键在不在"这件事读代码时一眼就能看出来，比 null 值清楚。

      ── 为什么按深度覆盖，而不是改 FOREST_GEOMETRY ──
        第 1 层的六道工序和画布原来的根节点**必须一模一样大**（240×156）。
        直接改 g.child 的话，第 2 层往后那七个执行任务点会跟着一起变大 ——
        子树横向撑宽，六道工序被挤到看不清（那笔宽度账见 forest-layout 文件头）。
        只有"按深度"这一个维度能同时满足这两件事：第 0、1 层主卡尺寸，
        第 2 层起子卡尺寸。数字本身在 core 里（TREE_LEVELS），
        和 CanvasWorkbench 算"打开时看得全"用的是同一份。
    */
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

  /** id → 子节点数据。渲染时按 id 查，O(1) */
  const childOf = useMemo(() => childIndex(childrenByStage ?? {}), [childrenByStage]);

  /*
    位置交给森林布局算。
    没有子节点时结果和旧的 nodeRect **逐像素相同**
    （tests/unit/canvas-forest-layout.test.ts 里有一组锚点断言钉着这件事）。

    有子节点时，根节点之间的距离会按**子树宽**自动撑开 ——
    这就是「自动扩展」，不需要任何额外的推动逻辑。

    ⚠️ 有根节点时走的是**另一棵树**：
       toForestNodes 把「一级 Agent → 六道工序 → 各自的子节点」
       拼成一棵三层树。布局本身完全没变 —— 它一直都支持任意深度，
       变的是喂进去的形状。连线的自动出现也是同一个道理：
       treeLinks 按 parentId 分组，多一层父节点就多一条躯干。
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

  /*
    ⚠️ 从这一行往下，画面上用的是 **animated.nodes**，不是 forest.nodes。

    区别：forest 是"这一刻应该长成什么样"（目标），
    animated 是"这一帧实际画在哪"（可能是插值中的中间态）。

    子树长出来的那 320ms 里，两者不同 —— 六个根正在被撑开、
    七个方块正在从父卡里往外长。动画结束后两者收敛到同一个值。

    `animatedNodes` 这个别名是为了让下面的代码读起来不用一直写 .nodes，
    同时**显式地**告诉读的人：这里用的是动画态。
  */
  const animated = useAnimatedLayout(forest.nodes);
  const animatedNodes = animated.nodes;

  const rects = useMemo(
    () =>
      nodes.map(
        (n) => animatedNodes.find((a) => a.id === n.id) ?? forest.byId.get(n.id) ?? { x: 0, y: 0, w: g.nodeW, h: g.nodeH },
      ),
    [nodes, animatedNodes, forest, g],
  );

  /*
    一级 Agent 那张卡画在哪。

    和六道工序用**同一套坐标**：优先取动画态（理由见上面的 animated 段），
    找不到才退回布局的目标位置。

    为什么不是"反正它不动，直接用 forest.byId"：
      换运行的瞬间整棵树都在动 —— 从"六根并列"切到"三层树"时，
      六道工序会往下让位、根卡从无到有。这时候根卡如果用的是目标位置，
      它会**先落在终点**，而它下面那六张还在半路上 —— 看起来像根卡
      和自己的孩子脱节了。跟同一套坐标走才不会。
  */
  const rootRect = rootCard
    ? (animatedNodes.find((a) => a.id === rootCard.id) ?? forest.byId.get(rootCard.id) ?? null)
    : null;

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

  /**
   * 往下第几层起才画成子方块。
   *
   * ── 这个下限不是可有可无的 ──
   *   没有根节点时，六道工序是**根**（depth 0），所以"depth > 0 的都是子节点"成立。
   *   有了根节点之后，六道工序掉到了 depth 1 —— 再按 `depth > 0` 过滤，
   *   它们会**全都进子方块的渲染循环**。
   *   现在之所以没出事，只是因为 childOf 里查不到工序的 id（有一步 `if (!child) return null`
   *   兜住了）。靠着"查不到"来正确，是会很脆的：哪天想给工序也挂一份子数据
   *   （比如"这一步的产物"），六张工序卡会当场变成六个小方块。
   *   所以层级下限按**这棵树有几层**算，不靠兜底。
   */
  const childDepthFloor = threeLayer ? 1 : 0;
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

        {/*
          ---------- 父子连线 ----------
          **这是让子树读起来像「树」的东西。**

          起因：子节点画出来了，但和父工序之间没有连线 ——
          结果七个方块看着是**漂在下面的另一堆卡片**。
          用户原话：「为什么没有树节点的效果」。

          ── 第一版的做法是错的 ──
            第一版让每个孩子各自从父节点连一条线（父底 → 下去 → 横过去 → 子顶）。
            一排孩子时没问题，但孩子是**两列四行**的：
            第 2/3/4 行的竖线必须从第 1 行的方块底下穿过，
            而方块画在线**上面**，于是那些线全被盖住 ——
            **只有第一行看起来连着。**

          ── 现在的做法 ──
            几何全交给 core 的 treeLinks（纯函数，7 条单测钉着）：
            一条**躯干**从父卡底边中点往下拉，每个孩子一根**短横枝**
            从躯干插到孩子朝向躯干那条边的中点。

            脊线走父卡中心，而那恰好是两块子卡区的中缝 ——
            **所以它永远不会从任何方块底下穿过。**
            这一点由单测保证（对 n=1/2/3/4/5/7 逐行验过）。

          ── 画在节点**下面** ──
            这段在 <svg> 里，卡片和子方块是 svg 之后渲染的 ——
            线从卡片底下穿过，端口自然被遮住，不用手动裁剪。
        */}
        {/*
          ⚠️ 连线也必须用**动画态**（animatedNodes），不能用 forest.nodes。

          否则动画那 320ms 里会出现最难看的错位：
          卡片正在被撑开滑向新位置，而连线**已经跳到终点**了 ——
          于是线头和卡片对不上，看起来像断的。

          连线本来就是"从这一帧的父卡连到这一帧的子卡"，
          所以它跟着同一套坐标走才是对的。
        */}
        {treeLinks(animatedNodes).map((l) => (
          <g key={`tree-${l.parentId}`}>
            {/* 躯干：一条竖线。它不属于任何一个孩子，单独标记 */}
            <path
              data-canvas-tree-trunk={l.parentId}
              d={`M ${l.trunk.x} ${l.trunk.y1} V ${l.trunk.y2}`}
              fill="none"
              stroke="rgb(148 163 184 / 0.38)"
              strokeWidth={1.2}
            />
            {/*
              横枝：**一个孩子一根**，各带 data-canvas-tree-link。
              断言「连线条数 === 子方块数」靠的就是它。

              ⚠️ 退化情形（孩子横跨脊线）**也要渲染，不能 filter 掉**。
                 那种孩子（两列排布时最后一行只有 1 个、居中摆）
                 正好坐在脊线上，横枝长度为 0 —— 视觉上它靠躯干连着
                 （躯干一直伸到它的顶边），本来就看不见横枝。
                 但过滤掉的话 DOM 里就少一个标记，断言会误报「有孤儿方块」
                 ——**测试的红绿就不再对应事实**。
                 画一根零长度的线不花代价，却让计数保持诚实。
            */}
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

      {/* ---------- 一级 Agent（三层树最上面那一层）----------
          不传 rootCard 时这里什么都不画 —— 旧用法（六根并列）逐像素不变。
          渲染顺序放在六道工序**前面**：DOM 顺序和树形顺序一致，
          调试时 querySelectorAll 出来的第一张卡就是最上面那张。 */}
      {rootCard && rootRect && (
        <RootCard
          card={rootCard}
          rect={rootRect}
          entering={animated.newIds.has(rootCard.id)}
        />
      )}

      {/* ---------- 节点 ---------- */}
      {nodes.map((node, i) => (
        <StageCard
          key={node.id}
          node={node}
          rect={rects[i]}
          tint={tintVarAt(i)}
          active={activeId === node.id}
          dimmed={dimmedExcept(node.id)}
          /*
            子树里有几项没过 —— 右上角那个角标的分子分母。
            只算给卡片的数字，`rects` 照旧整个交给 rect（角标要的
            childCount 本来就在里面，它是 LaidNode）。
          */
          failedKids={summarizeChildren(childrenByStage?.[node.id] ?? []).failed}
          onPick={onPick}
          /*
            聚焦区域用 **forest.byId 的 subtree**，不是 animatedNodes 的。

            为什么：subtree 是"这棵树最终占多大地方"，是个**稳定的目标**。
            动画途中 animatedNodes 上的位置是插值中间态，
            拿它当聚焦区域的话，双击时如果动画还没跑完，
            聚焦到的会是一个"正在移动中的、偏小的"区域。
          */
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

      {/*
        ---------- 子节点 ----------
        挂在每道工序下面。比 `childDepthFloor` 深的就是它们 ——
        布局只吐出位置，这里按 id 把数据找回来。

        ⚠️ 下限由 childDepthFloor 给，不是写死的 0：
           有根节点时六道工序在 depth 1，写死 0 会把它们也卷进这个循环
           （现在只靠"childOf 里查不到"侥幸没出事，见那个常量的说明）。

        ⚠️ 用 animatedNodes（动画态），理由同上面的连线。
        另外带上 `entering`：这一帧里刚冒出来的方块要淡入 ——
        光有位置插值不够，一个从 0 尺寸长到 172×112 的方块
        如果一上来就是全不透明，看起来像"弹出来"而不是"长出来"。
      */}
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
