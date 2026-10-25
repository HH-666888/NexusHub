"use client";

import Link from "next/link";
import { useActionState } from "react";
import { logoutAction } from "@/app/actions/auth";
import { createRunAction, type RunFormState } from "@/app/actions/run";
import { PROMPT_MAX } from "@/core/domain/run";
import { AppNav } from "@/components/shell/app-nav";

const INITIAL: RunFormState = {};

/**
 * 工作台顶栏
 * ============================================================
 * ⚠️ 它**不再自己写一个 header** —— 品牌、右侧那组、页边距
 * 全部来自全局的 AppNav，这里只负责往中间塞那个一句话输入框。
 *
 * 原来这里是第二套顶栏（px-6，和首页那套的 px-8 不一样），
 * 于是换页面时导航会横向跳一下。现在两头一模一样，
 * 只有中间不一样 —— 而中间本来就该不一样。
 *
 * ── 输入框与服务端动作为什么还留在这一层 ──
 *   错误提示需要紧挨着输入框显示 —— 拆开就得把状态往上提，反而更绕。
 *   而 AppNav 收的是一个 ReactNode，它不关心那是什么。
 */
export function CockpitHeader({
  user,
  spentCny,
  themeToggle,
  seed,
  seedKey,
}: {
  user: { displayName: string; username: string };
  /** 累计已花费。null 表示还没花过 */
  spentCny: number | null;
  themeToggle?: React.ReactNode;
  /** 从空状态示例填进来的提示词。undefined 表示没点过示例 */
  seed?: string;
  /** 每次点示例递增，用作输入框的 key，强制重新挂载以更新 defaultValue */
  seedKey?: number;
}) {
  const [state, formAction, isPending] = useActionState(createRunAction, INITIAL);

  return (
    <AppNav
      spentCny={spentCny}
      user={user}
      themeToggle={themeToggle}
      tagline="一个网页里的软件工厂"
      center={
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
            className="min-w-0 flex-1 rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-surface)] px-4 py-2 text-[13px] outline-none placeholder:text-slate-500 focus:border-[var(--app-accent)] disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={isPending}
            className="shrink-0 rounded-lg bg-blue-600 px-5 py-2 text-[13px] font-medium text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-500"
          >
            {isPending ? "正在创建…" : "开始构建"}
          </button>
        </form>
      }
      actions={
        <>
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
        </>
      }
      notice={
        state.error ? (
          <div
            role="alert"
            className="border-t border-amber-900/50 bg-amber-950/30 px-14 py-2 text-xs text-amber-300"
          >
            {state.error}
          </div>
        ) : null
      }
    />
  );
}