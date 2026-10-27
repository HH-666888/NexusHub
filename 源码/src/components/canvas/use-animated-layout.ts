"use client";

import { useEffect, useRef, useState } from "react";
import { isNewNode, lerpLayout, type LaidNode } from "@/core/canvas/forest-layout";

/**
 * 让布局变化动起来：子树跑起来才长出来，六个根被撑开让位。
 * 插值本身在 core 的 lerpLayout 里（纯函数，有单测），这里只决定何时调用、传什么 t。
 * 三种情形直接给终态：首次渲染、prefers-reduced-motion、目标没变。
 */

/** 动画时长。320ms：看得见在动，又不挡着下一步 */
const GROW_MS = 320;

/** ease-out：起步快、收尾慢。ease-in-out 起步那一下会发粘 */
function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/** 用户是不是要求减少动效 */
function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return true; // 服务端渲染时当真，别动
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/** 这一帧实际画在哪，以及这一帧里刚冒出来的节点 */
export interface AnimatedLayout {
  nodes: LaidNode[];
  newIds: Set<string>;
}

export function useAnimatedLayout(target: LaidNode[]): AnimatedLayout {
  /*
    prev 用 ref 而非 state：它只是“上一帧是什么”的书签，
    变它不该触发重渲染。
  */
  const prevRef = useRef<LaidNode[]>([]);
  const rafRef = useRef<number | null>(null);

  const [nodes, setNodes] = useState<LaidNode[]>(target);
  const [newIds, setNewIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    const from = prevRef.current;

    /*
      ① 首次渲染或减少动效 → 直接落终态。首次那一帧 prev 是空的，
      lerpLayout 会把每个节点当成新节点从父节点中心长出来，不是生长是爆炸。
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

    /* 这一帧里新冒出来的节点，渲染层拿去决定谁要淡入 */
    setNewIds(new Set(target.filter((n) => isNewNode(from, n.id)).map((n) => n.id)));

    const started = performance.now();

    const step = (now: number) => {
      const raw = Math.min(1, (now - started) / GROW_MS);
      setNodes(lerpLayout(from, target, easeOutCubic(raw)));

      if (raw < 1) {
        rafRef.current = requestAnimationFrame(step);
      } else {
        /*
          收尾：prev 记目标而不是最后一帧的插值 —— 记插值的话误差会一帧帧攒起来。
          同时清空 newIds，动画结束了就不该再淡入。
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
