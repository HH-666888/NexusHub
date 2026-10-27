"use client";

import Link from "next/link";
import { deleteRunAction } from "@/app/actions/run";
import { RUN_STATUS_LABEL } from "@/core/domain/run";
import type { RunView } from "@/components/cockpit/run-list";

/**
 * 运行切换器（横排）。画布是主角，切换只能用一条横带，不沿用工作台那张竖排卡片列表。
 * 每条最多一行字，状态靠左边小圆点的颜色说 —— 和画布上六道工序同一套色。
 * 导出挂在每条运行上、导入挂在横带末尾：用户最担心的是换一台电脑旧项目就没了。
 */

const DOT: Record<RunView["status"], string> = {
  running: "rgb(96 165 250)",
  paused: "rgb(251 191 36)",
  done: "rgb(74 222 128)",
  failed: "rgb(248 113 113)",
  cancelled: "rgb(148 163 184)",
};

/** 提示词太长就截断，横带里放不下；完整内容在画布和生成过程里都能看到 */
function shorten(text: string, max = 24): string {
  const t = text.trim();
  return t.length <= max ? t : t.slice(0, max) + "…";
}

/**
 * 导入。用原生表单提交而不是 fetch：这条路本来就是一整条 HTTP 导航，
 * 重定向、错误页、文件上传浏览器都处理好了，fetch 还得自己再实现一遍。
 * 不记选中的文件名：原生 input 自己会显示，再接一份 state 迟早不一致。
 */
function ImportForm({ align }: { align: "right" | "inline" }) {
  return (
    <form
      action="/api/runs/import"
      method="post"
      encType="multipart/form-data"
      data-run-import
      title="把之前导出的 .nexus.json 导进来 —— 它会变成一条新的构建记录"
      className={`flex flex-none items-center gap-1.5 px-3 py-2 ${
        align === "right" ? "border-l border-[var(--color-border-soft)]" : "ml-auto"
      }`}
    >
      <input
        type="file"
        name="file"
        accept=".json,application/json"
        aria-label="选择要导入的 .nexus.json 文件"
        className="w-[150px] flex-none text-[11px] text-slate-500 file:mr-1.5 file:cursor-pointer file:rounded-full file:border file:border-[var(--color-border-soft)] file:bg-transparent file:px-2 file:py-0.5 file:text-[11px] file:text-slate-400 hover:file:border-slate-600 hover:file:text-slate-200"
      />
      <button
        type="submit"
        className="flex-none rounded-full border border-[var(--color-border-soft)] px-2.5 py-1 text-[11.5px] text-slate-400 transition hover:border-slate-600 hover:text-slate-200"
      >
        导入
      </button>
    </form>
  );
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
        {/* 空状态里也要有导入：换一台电脑打开就是这个样子，那时最需要它 */}
        <ImportForm align="inline" />
      </div>
    );
  }

  return (
    /*
      分两层：里面那层管横向滚动，外面那层把导入固定在右边。
      让导入跟着滚的话，运行一多它就被挤出可视区，用户会以为没有这个功能。
    */
    <div className="flex items-center border-b border-[var(--color-border-soft)]">
      <div className="scroll-hint flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto px-3 py-2">
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
              {/*
                主链接必须是 chip 里的第一个 <a>：e2e 用 [data-run-chip] a 取文档序第一个。
                导出那个 <a> 因此在它后面，调换顺序会让切运行的断言变成在下载文件。
              */}
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
                导出刻意不做成 hover 才出现：它是这一期真正要交付的动作，藏起来等于没有。
                删除是破坏性动作，藏着才对。
              */}
              <a
                href={`/api/runs/${run.id}/export`}
                download
                data-run-export={run.id}
                title="把这次构建导出成一个文件 —— 换一台电脑导入回来，它还在"
                className="flex-none text-[11px] text-slate-600 transition hover:text-slate-300"
              >
                导出
              </a>

              {/* 删除放在 hover 才出现的 ✕ 上：常驻会让每条变宽，也更容易误点 */}
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

      <ImportForm align="right" />
    </div>
  );
}