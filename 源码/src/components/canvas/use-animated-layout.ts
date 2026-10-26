"use client";

import { useEffect, useRef, useState } from "react";
import { isNewNode, lerpLayout, type LaidNode } from "@/core/canvas/forest-layout";

/* ============================================================
   生长动画
   ============================================================ */

/**
 * 让布局变化动起来
 * ============================================================
 * 子树是**跑起来才长出来的**：一开始六个根节点挨在一起，跑到验收时
 * 「验收」下面突然多出七个方块，六道工序被撑开让位。
 *
 * 不做动画的话这些位移是**瞬间**发生的 —— 看起来像"闪了一下换了一张图"，
 * 而不是"东西长出来了"。用户要的「动态效果拉满」，一半就落在这里。
 *
 * ── 为什么它曾经住在组件文件里 ──
 *   它本该一开始就待在自己的文件里。但当初这个文件**建不出来** ——
 *   那时的环境有个行为：**新建的未跟踪文件会被删掉**
 *   （`git add` 都追不上它），当时已经撞过好几次。
 *   而"改一个已有文件"是好的。
 *
 *   所以它一度寄住在 pipeline-canvas.tsx 里 —— 反正唯一的使用者
 *   就是那个组件。现在环境正常了，它搬回了本该在的地方，
 *   也就是你正在读的这一份。
 *
 *   ⚠️ 当时留下的那句「等环境正常了应该挪回单独的文件」已经兑现 ——
 *      一个 hook 混在组件文件里只是权宜之计，不是设计。
 *
 * ── 插值本身不在这里 ──
 *   在 core 的 lerpLayout 里（纯函数，8 条单测钉着）。
 *   这个 hook 只负责**什么时候调用它、传什么 t**。
 *
 * ── 三个必须处理的情形 ──
 *   ① 首次渲染：没有上一帧，直接给终态。否则六个根会从中心"炸开"
 *   ② prefers-reduced-motion：直接给终态，一帧都不插
 *   ③ 目标没变：不动。省掉一次没意义的 rAF 循环
 */

/** 动画时长。320ms 是"看得见在动"又"不挡着下一步"的折中 */
const GROW_MS = 320;

/**
 * ease-out：起步快、收尾慢。
 * 用 ease-in-out 的话起步那一下会显得"粘"，而这里要的正是"弹出来"。
 */
function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/** 用户是不是要求减少动效 */
function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return true; // 服务端渲染时当真，别动
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/**
 * 这个 hook 的返回值：这一帧实际画在哪（nodes），
 * 以及这一帧里刚冒出来的节点是谁（newIds，渲染层拿去决定谁要淡入）。
 */
export interface AnimatedLayout {
  nodes: LaidNode[];
  newIds: Set<string>;
}

export function useAnimatedLayout(target: LaidNode[]): AnimatedLayout {
  /*
    prev 用 ref 而不是 state：它只是"上一帧是什么"的书签，
    变它不该触发重渲染 —— 触发重渲染的只有当前这一帧。
  */
  const prevRef = useRef<LaidNode[]>([]);
  const rafRef = useRef<number | null>(null);

  const [nodes, setNodes] = useState<LaidNode[]>(target);
  const [newIds, setNewIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    const from = prevRef.current;

    /*
      ① 首次渲染，或者用户要求减少动效 → 直接落终态。
         首次那一帧不能动：那时 prev 是空的，lerpLayout 会把
         每个节点都当成"新节点"从父节点中心长出来 ——
         整片森林会从中间炸开，那不是"生长"，是"爆炸"。
    */
    if (from.length === 0 || prefersReducedMotion()) {
      prevRef.current = target;
      setNodes(target);
      setNewIds(new Set());
      return;
    }

    /* 目标没变就不动 */
    const same =
      from.length === target.length &&
      target.every(
        (n, i) => n.id === from[i]?.id && n.x === from[i]?.x && n.y === from[i]?.y,
      );
    if (same) return;

    /* 这一帧里新冒出来的节点。渲染层拿去决定谁要淡入 */
    setNewIds(new Set(target.filter((n) => isNewNode(from, n.id)).map((n) => n.id)));

    const started = performance.now();

    const step = (now: number) => {
      const raw = Math.min(1, (now - started) / GROW_MS);
      setNodes(lerpLayout(from, target, easeOutCubic(raw)));

      if (raw < 1) {
        rafRef.current = requestAnimationFrame(step);
      } else {
        /*
          收尾：把 prev 记成**目标**（不是最后一帧的插值）。
          记插值的话，下一次动画会从一个"差一点点"的状态出发，
          误差会一帧帧攒起来。
          同时把 newIds 清空 —— 动画结束了就不该再淡入。
        */
        prevRef.current = target;
        rafRef.current = null;
        setNewIds(new Set());
      }
    };

    rafRef.current = requestAnimationFrame(step);

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [target]);

  return { nodes, newIds };
}
