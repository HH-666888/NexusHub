"use client";

import Link from "next/link";
import { deleteRunAction } from "@/app/actions/run";
import { RUN_STATUS_LABEL } from "@/core/domain/run";
import type { RunView } from "@/components/cockpit/run-list";

/**
 * 运行切换器（横排）
 * ============================================================
 * 画布是主角，所以切换运行只能用**一条横带**，不能沿用工作台那张
 * 竖排卡片列表 —— 那会把画布挤掉一半。
 *
 * ── 为什么不复用 RunList ──
 *   RunList 是竖排、每张卡三行的布局，塞进一条横带里要么变形、
 *   要么就得重写。**这里要的是"切换"，那边要的是"浏览"** ——
 *   两件事，两个组件，比一个组件硬撑两种形态干净。
 *
 * ── 状态用点和颜色表达，不占字数 ──
 *   横带里每条最多给一行字。跑没跑完、失败没失败，靠左边那个
 *   小圆点的颜色说 —— 和画布上那六道工序用的是同一套色。
 */

const DOT: Record<RunView["status"], string> = {
  running: "rgb(96 165 250)",
  paused: "rgb(251 191 36)",
  done: "rgb(74 222 128)",
  failed: "rgb(248 113 113)",
  cancelled: "rgb(148 163 184)",
};

/** 提示词太长就截断 —— 横带里放不下，而完整内容在画布和生成过程里都能看到 */
function shorten(text: string, max = 24): string {
  const t = text.trim();
  return t.length <= max ? t : t.slice(0, max) + "…";
}

export function RunSwitcher({
  runs,
  selectedRunId,
}: {
  runs: RunView[];
  selectedRunId: string | null;
}) {
  if (runs.length === 0) {
    return (
      <div className="flex items-center gap-2 border-b border-[var(--color-border-soft)] px-4 py-2 text-[11.5px] text-slate-500">
        <span>还没有任何构建记录。</span>
        <Link href="/" className="text-slate-400 underline-offset-2 hover:text-slate-200 hover:underline">
          在上面输入一句话
        </Link>
        <span>点「↑」就开始。</span>
      </div>
    );
  }

  return (
    <div className="scroll-hint flex items-center gap-1.5 overflow-x-auto border-b border-[var(--color-border-soft)] px-3 py-2">
      {runs.map((run) => {
        const selected = run.id === selectedRunId;
        return (
          <div
            key={run.id}
            data-run-chip={run.id}
            className={`group flex flex-none items-center gap-2 rounded-full border px-2.5 py-1 text-[11.5px] transition ${
              selected
                ? "border-blue-600 bg-blue-950/30"
                : "border-[var(--color-border-soft)] hover:border-slate-600"
            }`}
          >
            <Link href={`/canvas?run=${run.id}`} className="flex items-center gap-2">
              <span
                aria-hidden
                data-run-status={run.status}
                className="inline-block h-1.5 w-1.5 flex-none rounded-full"
                style={{ background: DOT[run.status] }}
              />
              <span className={selected ? "text-slate-100" : "text-slate-400"}>
                {shorten(run.prompt)}
              </span>
              <span className="flex-none text-[10px] text-slate-600">
                {RUN_STATUS_LABEL[run.status]}
              </span>
            </Link>

            {/*
              删除放在 hover 才出现的小 ✕ 上。
              横带很窄，常驻一个删除按钮会让每条都变宽、也更容易误点。
            */}
            <form action={deleteRunAction} className="flex-none">
              <input type="hidden" name="runId" value={run.id} />
              <button
                type="submit"
                aria-label="删除这次构建"
                title="删除这次构建"
                className="text-[11px] text-slate-600 opacity-0 transition group-hover:opacity-100 hover:text-red-400"
              >
                ✕
              </button>
            </form>
          </div>
        );
      })}
    </div>
  );
}