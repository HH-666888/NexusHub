"use client";

import { useActionState, useState } from "react";
import { createRunAction, type RunFormState } from "@/app/actions/run";
import { NAV_GUTTER } from "@/components/shell/gutter";

/**
 * 首页主区：标题 + 类型分段 + 输入框。这一屏是整页的重心，占了将近一半高度。
 *
 * 留白是内容的一部分：标题上方、输入框下方都有大片空白，为的是把注意力压到中间那条线上。
 * 填上公告、数据、引导反而会让这一屏失去焦点。
 *
 * 提交按钮用的是 /studio 顶栏同一个服务端动作（createRunAction），
 */

/** 产物类型。对应参考图上的“创作 / 短剧 / 互动影游”三个分段 */
const KINDS = [
  { id: "web", label: "网页应用", hint: "能开、能点、数据存得住" },
  { id: "tool", label: "小工具", hint: "单页解决一件事" },
  { id: "game", label: "小游戏", hint: "有交互、有反馈" },
] as const;

const PLACEHOLDER =
  "描述你想做的软件，例如：一个能拖拽卡片的团队任务看板，刷新后数据还在";

const INITIAL: RunFormState = {};

export function HomeHero() {
  const [kind, setKind] = useState<(typeof KINDS)[number]["id"]>("web");
  const [text, setText] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  /*
    提交走服务端动作。isPending 用来把按钮变成“正在创建…”并禁用 ——
    否则连点两下会建出两次运行，那就是两次钱。
  */
  const [state, formAction, isPending] = useActionState(createRunAction, INITIAL);

  /** 真正还没接的功能。点了给一句明确的说明，而不是什么都不发生 */

  /*
    文案优先级：还没接的说明 > 服务端返回的错误。两件事不会同时发生，
    但写清楚顺序，免得以后有人调换。
  */
  const shown = notice ?? state.error ?? null;

  return (
    <section className={`w-full ${NAV_GUTTER}`}>
      {/* ---------- 大标题 ---------- */}
      <h1 className="pt-16 pb-7 text-center text-[42px] leading-tight font-semibold tracking-tight text-slate-100">
        说一句，做出来
      </h1>

      {/* ---------- 产物类型 ---------- */}
      <div className="flex justify-center pb-8">
        <div className="flex items-center gap-1 rounded-full border border-[var(--color-border-soft)] bg-[var(--color-surface)]/70 p-1">
          {KINDS.map((k) => (
            <button
              key={k.id}
              type="button"
              onClick={() => setKind(k.id)}
              title={k.hint}
              className={`rounded-full px-5 py-1.5 text-[13px] transition-colors duration-150 ${
                kind === k.id
                  ? "bg-slate-700/60 text-slate-100"
                  : "text-slate-500 hover:text-slate-300"
              }`}
            >
              {k.label}
            </button>
          ))}
        </div>
      </div>

      {/* ---------- 输入框 ---------- */}
      <form action={formAction} className="mx-auto max-w-[900px]">
        <div className="rounded-[22px] border border-[var(--color-border-soft)] bg-[var(--color-surface)]/80 p-5 transition-colors duration-200 focus-within:border-[rgb(var(--app-accent-glow)/0.7)]">
          {/*
            name="prompt" 是必须的 —— 服务端动作靠它取值。
            受控组件和 form action 可以共存：提交那一刻 React 从 DOM 读值。
          */}
          <textarea
            name="prompt"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setNotice(null);
            }}
            rows={4}
            placeholder={PLACEHOLDER}
            disabled={isPending}
            className="w-full resize-none bg-transparent text-[14px] leading-relaxed text-slate-200 outline-none placeholder:text-slate-500 disabled:opacity-60"
          />

          <div className="mt-3 flex items-center gap-2">
            {/* 上传入口。参考图上是左下角那个“+” */}

            <div className="ml-auto flex items-center gap-2">
              {/*
                真正的 submit：没写内容时由服务端动作返回错误（不是前端拦截，
                这样两条路径的校验逻辑只有一份）；提交中禁用，防连点建出两次运行。
              */}
              <button
                type="submit"
                disabled={isPending || text.trim().length === 0}
                aria-label="开始构建"
                title={isPending ? "正在创建…" : "开始构建"}
                className="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-[var(--app-accent)] text-white transition-opacity duration-150 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {isPending ? "…" : "↑"}
              </button>
            </div>
          </div>
        </div>

        {/* 提示条。还没接的功能 / 服务端返回的错误，都走这里 */}
        {shown && (
          <p className="mt-2.5 text-center text-[11.5px] text-amber-400/90">{shown}</p>
        )}
      </form>
    </section>
  );
}
