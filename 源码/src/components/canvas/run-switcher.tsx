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
 *
 * ── 导出 / 导入为什么长在这条横带上 ──
 *   用户提过的担心是「换一个地方旧项目就没有了，或者打开是空的」。
 *   要治这一点，导出就不能藏进设置页 —— 它得在**看着自己项目的地方**、
 *   伸手就够得着：导出挂在每一条运行上（导出的就是"这一条"），
 *   导入挂在横带末尾（导入进来的会变成新的一条，和别的并排）。
 *
 *   ⚠️ 导入在**没有运行的空状态里也要有**。
 *      那正是"换了一台电脑"的样子：一条记录都没有。
 *      偏偏那时候最需要导入 —— 而它如果只长在"有运行"的分支里，
 *      空状态下就永远找不到入口，用户会以为这个功能不存在。
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

/**
 * 导入。
 *
 * ── 为什么是原生表单提交，不是 fetch + 前端状态 ──
 *   提交之后服务端要拿这个文件写库、再跳去画布 ——
 *   这条路本来就是一整条 HTTP 导航。用 fetch 的话，
 *   重定向、错误页、浏览器对文件上传的处理全都得自己再实现一遍，
 *   而最后还是要 `location.href = ...` 跳一次。
 *   原生表单把这件事交回给浏览器，行为与"点了就会跳"完全一致。
 *
 * ── 为什么不用 useState 记住选中的文件名 ──
 *   原生 `<input type=file>` 自己会显示选中的文件名。
 *   再接一份 state 只是把它抄一遍，而两份显示迟早会不一致
 *   （比如用户取消选择之后）。
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
        {/* 空状态里的导入：换一台电脑打开就是这个样子，那时最需要它 */}
        <ImportForm align="inline" />
      </div>
    );
  }

  return (
    /*
      ⚠️ 分成两层：里面那层管横向滚动，外面那层把导入固定在右边。
         如果让导入跟着横带一起滚（和运行卡片平级），
         运行一多它就被挤到滚动区最右边 —— 而"右边还有东西"
         在横带里是看不出来的，用户会以为没有导入这个功能。
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
                ⚠️ 主链接必须是这个 chip 里的**第一个** <a>。
                   e2e 里用 `[data-run-chip="…"] a` 点它来切运行，
                   querySelector 取的就是文档序里的第一个。
                   导出那个 <a> 因此在它后面 —— 调换顺序会让
                   "切换运行"的几条断言变成在下载文件。
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
                导出：一个普通的 <a download>。
                ⚠️ 刻意**不**做成 hover 才出现（删除 ✕ 是那样）：
                   导出是"把这个项目带走"，是这一期真正要交付的动作，
                   藏起来等于没有。删除是破坏性动作，藏着才对。
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

      <ImportForm align="right" />
    </div>
  );
}