"use client";

import { useActionState, useState } from "react";
import { createRunAction, type RunFormState } from "@/app/actions/run";

const INITIAL: RunFormState = {};

const PLACEHOLDER = "例如：一个能拖拽卡片的团队任务看板，刷新后数据还在";

/**
 * 空画布上的开工入口。首页「新建项目」落到 /canvas?new=1 时显示。
 *
 * 放在画布上层而不是替换画布：六道工序的空白骨架本身就在说明这个产品怎么跑，
 * 换掉它反而让人不知道该期待什么。
 */
export function NewProjectCta() {
  const [text, setText] = useState("");
  const [state, formAction, isPending] = useActionState(createRunAction, INITIAL);

  return (
    <div
      data-new-project
      className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center p-6"
    >
      <form
        action={formAction}
        className="pointer-events-auto w-full max-w-[540px] rounded-2xl border border-[var(--color-border-soft)] bg-[var(--color-surface)]/95 p-5 shadow-2xl backdrop-blur-sm"
      >
        <p className="text-[13px] text-slate-200">这是一个空项目</p>
        <p className="mt-1 text-[11.5px] leading-relaxed text-slate-500">
          说一句你想做的软件，六道工序会随着生成依次亮起来。也可以从上面的历史项目里挑一条。
        </p>

        <textarea
          name="prompt"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          placeholder={PLACEHOLDER}
          disabled={isPending}
          className="mt-3 w-full resize-none rounded-lg border border-[var(--color-border-soft)] bg-transparent px-3 py-2 text-[13px] leading-relaxed text-slate-200 transition-colors duration-150 outline-none placeholder:text-slate-600 focus:border-[rgb(var(--app-accent-glow)/0.7)] disabled:opacity-60"
        />

        {state.error && (
          <p className="mt-2 text-[11.5px] text-amber-400/90">{state.error}</p>
        )}

        <div className="mt-3 flex items-center justify-end">
          <button
            type="submit"
            disabled={isPending || text.trim().length === 0}
            className="rounded bg-[var(--app-accent)] px-3.5 py-1.5 text-[12px] font-medium text-white transition-opacity duration-150 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {isPending ? "正在创建…" : "开始构建"}
          </button>
        </div>
      </form>
    </div>
  );
}
