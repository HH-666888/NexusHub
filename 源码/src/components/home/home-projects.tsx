import Link from "next/link";
import { computeStageStatuses } from "@/core/pipeline/progress";
import { STAGES } from "@/core/pipeline/stages";
import { tintVarAt } from "@/core/domain/appearance";
import type { RunView } from "@/components/cockpit/run-list";

/**
 * 项目卡片行
 * ============================================================
 * 对应参考图里「+ 新建项目」后面那一排项目缩略图。
 * 我们这一行就是**用户自己的构建记录** —— 不是模板库，不是示例。
 *
 * ── 缩略图用什么 ──
 *   参考图上每张卡片是一张图片。我们没有图片：产物是 HTML，
 *   要截图得真的把它渲染一遍。
 *   所以缩略图画的是**这条记录的流水线进度**：六道工序，
 *   已跑过的点亮、没接入的灰着。
 *   这不是占位图，它是真实数据的另一种画法 ——
 *   扫一眼就知道这条跑到哪了，比一张成品截图信息量还大。
 *
 * ── 没有记录时不摆假卡片 ──
 *   编几条「示例项目」摆上去好看，但用户点进去会发现不存在。
 *   空着并说清楚怎么产生第一条，比摆假的强。
 */

export interface HomeProjectsProps {
  runs: RunView[];
}

const THUMB_TINTS = [0, 1, 2, 3, 4, 5] as const;

export function HomeProjects({ runs }: HomeProjectsProps) {
  // 只展示最近几条。首页这一行是「快速回到上次」，不是完整列表
  const shown = runs.slice(0, 3);

  return (
    <section className="w-full px-14 pb-16">
      <div className="mb-4 flex items-end justify-between">
        <h2 className="text-[15px] font-medium text-slate-200">我的项目</h2>
        {runs.length > 0 && (
          <Link
            href="/studio"
            className="text-[12.5px] text-slate-500 transition-colors duration-150 hover:text-slate-300"
          >
            所有项目 ›
          </Link>
        )}
      </div>

      <div className="grid grid-cols-4 gap-5">
        {/* 新建 */}
        <Link
          href="/canvas"
          data-home-new-project
          className="group flex flex-col overflow-hidden rounded-2xl border border-dashed border-[var(--color-border-soft)] transition-colors duration-150 hover:border-slate-600"
        >
          <div className="flex aspect-[3/2] items-center justify-center">
            <span className="text-3xl leading-none font-light text-slate-600 transition-colors duration-150 group-hover:text-slate-400">
              +
            </span>
          </div>
          <div className="px-3.5 pt-1 pb-3.5">
            <div className="text-[13px] text-slate-300">新建项目</div>
            <div className="mt-0.5 text-[11px] text-slate-600">从一句话开始</div>
          </div>
        </Link>

        {shown.map((run) => (
          <ProjectCard key={run.id} run={run} />
        ))}

        {/* 一条记录都没有时，把空状态说清楚，而不是摆占位卡片 */}
        {shown.length === 0 && (
          <div className="col-span-3 flex items-center rounded-2xl border border-[var(--color-border-soft)] bg-[var(--color-surface)]/40 px-5 py-4">
            <p className="text-[12.5px] leading-relaxed text-slate-500">
              还没有任何构建记录。
              <br />
              在上面那个框里说一句你想做的东西，第一条就会出现在这里。
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

function ProjectCard({ run }: { run: RunView }) {
  const statuses = computeStageStatuses(run);
  const tint = tintVarAt(THUMB_TINTS[0]);

  return (
    <Link
      href={`/studio?run=${run.id}`}
      className="group flex flex-col overflow-hidden rounded-2xl border border-[var(--color-border-soft)] bg-[var(--color-surface)]/60 transition-colors duration-150 hover:border-slate-600"
    >
      {/* 缩略图：这条记录的流水线进度 */}
      <div
        className="relative flex aspect-[3/2] flex-col justify-center gap-[5px] px-6"
        style={{
          backgroundImage: `linear-gradient(150deg, rgb(${tint} / 0.14), rgb(${tint} / 0.03) 55%, transparent)`,
        }}
      >
        {STAGES.map((s, i) => {
          const st = statuses[s.id];
          const planned = s.implementation === "planned";
          const lit = !planned && (st === "passed" || st === "running");
          const t = tintVarAt(i);
          return (
            <div
              key={s.id}
              className="h-[5px] rounded-full transition-colors duration-150"
              style={{
                width: `${100 - i * 9}%`,
                backgroundColor: planned
                  ? "var(--color-border-soft)"
                  : lit
                    ? `rgb(var(${t}) / 0.85)`
                    : `rgb(var(${t}) / 0.22)`,
              }}
            />
          );
        })}
      </div>

      <div className="flex items-start gap-2 px-3.5 pt-1 pb-3.5">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] text-slate-300">{run.prompt}</div>
          <div className="mt-0.5 truncate text-[11px] tabular-nums text-slate-600">
            {stageLabel(run.stage)} · {run.timeLabel}
          </div>
        </div>
        <span aria-hidden className="flex-none pt-1 text-slate-700">
          ⋯
        </span>
      </div>
    </Link>
  );
}

function stageLabel(stage: string): string {
  const hit = STAGES.find((s) => s.id === stage);
  return hit ? `第 ${hit.order} 阶段 · ${hit.name}` : "未开始";
}