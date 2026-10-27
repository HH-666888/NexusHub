"use client";

import Link from "next/link";
import type { CSSProperties } from "react";
import { deleteRunAction } from "@/app/actions/run";
import { tintVarAt } from "@/core/domain/appearance";
import { RUN_STATUS_LABEL, type Run } from "@/core/domain/run";
import { STAGE_MAP } from "@/core/pipeline/stages";

const STATUS_STYLE: Record<Run["status"], string> = {
  running: "border-blue-700 bg-blue-950/40 text-blue-300",
  paused: "border-amber-700 bg-amber-950/40 text-amber-300",
  done: "border-green-700 bg-green-950/40 text-green-300",
  failed: "border-red-700 bg-red-950/40 text-red-300",
  cancelled: "border-slate-700 bg-slate-800/40 text-slate-400",
};

/**
 * 带展示字段的运行。「多久以前」由服务端算好再传下来，而不是客户端现场算：
 * 渲染期间调 Date.now() 会让结果不确定，而且服务端与客户端各算一次可能不一致。
 */
export interface RunView extends Run {
  timeLabel: string;
}

/**
 * 空状态里的示例提示词。三句都是真的能跑通的输入，点一下就会被填进上面的输入框。
 * 空状态要给例子而不是写一句「还没有记录」：第一次打开时，最大的障碍是不知道该说什么。
 */
const SAMPLES = [
  "做一个团队任务看板，能拖拽卡片、能标记完成、刷新后数据还在",
  "做一个记账小工具，能分类统计、能导出",
  "做一个番茄钟，能记录每天专注了多久",
] as const;

/**
 * 构建记录列表。「我交代完可以走开，回来时东西还在」这句话的物理体现 ——
 * 没有这张列表，用户关掉浏览器就什么都不剩了。
 */
export function RunList({
  runs,
  selectedRunId,
  onPickSample,
}: {
  runs: RunView[];
  selectedRunId: string | null;
  /** 点示例提示词时，把文字交给上层填进输入框 */
  onPickSample?: (prompt: string) => void;
}) {
  if (runs.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-[var(--color-border-soft)] p-6">
        <h4 className="text-sm font-medium text-slate-300">
          还没有任何构建记录
        </h4>
        <p className="mt-1.5 max-w-md text-xs leading-relaxed text-slate-500">
          在上面输入一句话，点「开始构建」就会出现在这里。
          不确定说什么的话，下面这三句可以直接用 —— 点一下就填进去。
        </p>

        <div className="mt-5 font-mono text-[10px] tracking-[0.16em] text-slate-600">
          试 试 这 三 句
        </div>

        <div className="mt-2 flex max-w-xl flex-col gap-1.5">
          {SAMPLES.map((text, i) => (
            <button
              key={text}
              type="button"
              onClick={() => onPickSample?.(text)}
              style={{ "--tint": tintVarAt(i) } as CSSProperties}
              className="group flex items-center gap-2.5 rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-surface)] px-3 py-2.5 text-left text-xs text-slate-300 transition-[border-color,transform] duration-150 ease-out hover:translate-x-0.5 hover:border-[rgb(var(--tint)/0.55)]"
            >
              <span
                aria-hidden
                className="tint-dot inline-block h-1.5 w-1.5 shrink-0 rounded-full"
              />
              <span className="flex-1 leading-relaxed">{text}</span>
              <span
                aria-hidden
                className="shrink-0 text-slate-600 transition-colors duration-150 group-hover:text-slate-300"
              >
                →
              </span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <ul className="space-y-2">
      {runs.map((run) => {
        const selected = run.id === selectedRunId;
        const stage = STAGE_MAP[run.stage];
        // 工作台在 /studio。列表里的链接必须指到这里 ——
        // 曾经写成 "/?run="，那是工作台还在首页时的旧路径，
        // 结果点「查看」会跳到首页去，而首页根本不认识 run 参数。
        const href = `/studio?run=${run.id}`;
        return (
          <li key={run.id}>
            <div
              className={`group rounded-lg border bg-[var(--color-surface)] p-3 transition ${
                selected
                  ? "border-blue-600 ring-1 ring-blue-600/30"
                  : "border-[var(--color-border-soft)] hover:border-slate-600"
              }`}
            >
              <Link href={href} className="block">
                <div className="flex items-start justify-between gap-3">
                  <p className="line-clamp-2 flex-1 text-sm leading-relaxed text-slate-200">
                    {run.prompt}
                  </p>
                  <span
                    className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] ${STATUS_STYLE[run.status]}`}
                  >
                    {RUN_STATUS_LABEL[run.status]}
                  </span>
                </div>
              </Link>

              <div className="mt-2.5 flex items-center gap-3 text-[11px] text-slate-500">
                <span>
                  第 {stage.order} 阶段 · {stage.name}
                </span>
                <span className="text-slate-700">|</span>
                <span>{run.timeLabel}</span>
                <span className="text-slate-700">|</span>
                <span className="tabular-nums">
                  ¥{run.totalCostCny.toFixed(4)}
                </span>

                <span className="ml-auto flex items-center gap-2 opacity-0 transition group-hover:opacity-100">
                  <Link
                    href={href}
                    className="text-slate-400 hover:text-slate-200"
                  >
                    查看
                  </Link>
                  <form action={deleteRunAction}>
                    <input type="hidden" name="runId" value={run.id} />
                    <button
                      type="submit"
                      className="text-slate-500 hover:text-red-400"
                    >
                      删除
                    </button>
                  </form>
                </span>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}