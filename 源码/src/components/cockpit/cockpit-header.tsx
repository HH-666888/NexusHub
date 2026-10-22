"use client";

import Link from "next/link";
import { useActionState } from "react";
import { logoutAction } from "@/app/actions/auth";
import { createRunAction, type RunFormState } from "@/app/actions/run";
import { PROMPT_MAX } from "@/core/domain/run";

const INITIAL: RunFormState = {};

/**
 * 顶栏：品牌 + 一句话输入 + 用户区
 * ============================================================
 * 输入框与服务端动作放在同一个客户端组件里，
 * 因为错误提示需要紧挨着输入框显示 —— 拆开就得把状态往上提，
 * 反而更绕。
 *
 * themeToggle 为什么要当属性传进来：
 *   主题开关需要读 Cookie 才能知道现在是黑还是白，那是服务端的事，
 *   所以它是个服务端组件。而客户端组件**不能直接 import 服务端组件** ——
 *   Next.js 支持的是反过来的方向：由服务端页面把它渲染好，
 *   再当作 ReactNode 传进来。所以这里收一个节点，不关心它是什么。
 */
export function CockpitHeader({
  user,
  themeToggle,
  seed,
  seedKey,
}: {
  user: { displayName: string; username: string };
  themeToggle?: React.ReactNode;
  /** 从空状态示例填进来的提示词。undefined 表示没点过示例 */
  seed?: string;
  /** 每次点示例递增，用作输入框的 key，强制重新挂载以更新 defaultValue */
  seedKey?: number;
}) {
  const [state, formAction, isPending] = useActionState(createRunAction, INITIAL);

  return (
    <header className="border-b border-[var(--color-border-soft)]">
      <div className="flex items-center gap-4 px-6 py-4">
        <div className="shrink-0">
          <div className="flex items-center gap-2">
            <span
              aria-hidden
              className="inline-block h-2 w-2 rounded-full bg-[var(--app-accent)]"
            />
            <span className="text-lg font-semibold tracking-tight">Nexus</span>
          </div>
          <div className="text-xs text-slate-400">一个网页里的软件工厂</div>
        </div>

        <form action={formAction} className="flex min-w-0 flex-1 items-center gap-3">
          {/*
            key 变化 → 输入框重新挂载 → defaultValue 生效。
            这是「点了示例就把文字填进去」的实现方式，
            同时打字过程完全不经过上层组件，不会引发整页重渲染。
            autoFocus 只在点过示例之后才给，避免一进页面就抢焦点。
          */}
          <input
            key={seedKey ?? "initial"}
            name="prompt"
            defaultValue={seed ?? state.value}
            autoFocus={seed !== undefined}
            maxLength={PROMPT_MAX}
            disabled={isPending}
            placeholder="用一句话描述你要做的软件，例如：做一个团队任务看板，能拖拽卡片、能标记完成、刷新后数据还在"
            className="min-w-0 flex-1 rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-surface)] px-4 py-2.5 text-sm outline-none placeholder:text-slate-500 focus:border-[var(--app-accent)] disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={isPending}
            className="shrink-0 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-500"
          >
            {isPending ? "正在创建…" : "开始构建"}
          </button>
        </form>

        <div className="flex shrink-0 items-center gap-3 border-l border-[var(--color-border-soft)] pl-4">
          {themeToggle}
          <div className="text-right">
            <div className="text-sm font-medium text-slate-200">
              {user.displayName}
            </div>
            <div className="text-[11px] text-slate-500">@{user.username}</div>
          </div>
          <Link
            href="/settings"
            title="设置"
            className="rounded-lg border border-[var(--color-border-soft)] px-3 py-1.5 text-xs text-slate-400 transition-[border-color,color] duration-150 hover:border-slate-500 hover:text-slate-200"
          >
            设置
          </Link>
          <form action={logoutAction}>
            <button
              type="submit"
              className="rounded-lg border border-[var(--color-border-soft)] px-3 py-1.5 text-xs text-slate-400 transition hover:border-slate-500 hover:text-slate-200"
            >
              退出
            </button>
          </form>
        </div>
      </div>

      {/* 输入不合规时紧贴顶栏下方提示，不打断用户视线 */}
      {state.error && (
        <div
          role="alert"
          className="border-t border-amber-900/50 bg-amber-950/30 px-6 py-2 text-xs text-amber-300"
        >
          {state.error}
        </div>
      )}
    </header>
  );
}