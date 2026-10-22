"use client";

import { useState } from "react";
import { STAGES, type StageStatus } from "@/shared/stages";

/**
 * Nexus 驾驶舱
 * ============================================================
 * 三条信息轴，从左到右：
 *   左  = 阶段流水线（骨架、契约是否满足、成本、耗时）
 *   中  = 任务图（每一个节点都能暂停 / 改指令 / 从该点重跑）
 *   右  = 产物与成本（契约结构 + 实时花费）
 *   下  = 成品预览（能点能用）
 *
 * 当前为骨架版本：布局与阶段定义已就位，编排内核接入后此处开始驱动真实数据。
 */

const STATUS_STYLE: Record<StageStatus, { text: string; cls: string }> = {
  pending: { text: "待执行", cls: "text-slate-400 border-slate-600" },
  running: { text: "执行中", cls: "text-blue-400 border-blue-500" },
  passed: { text: "已通过", cls: "text-green-400 border-green-500" },
  failed: { text: "失败", cls: "text-red-400 border-red-500" },
  blocked: { text: "需人工", cls: "text-amber-400 border-amber-500" },
  skipped: { text: "已跳过", cls: "text-slate-500 border-slate-700" },
};

export default function CockpitPage() {
  const [prompt, setPrompt] = useState("");
  const [statuses] = useState<Record<string, StageStatus>>(
    () => Object.fromEntries(STAGES.map((s) => [s.id, "pending" as StageStatus])),
  );

  return (
    <div className="flex h-screen flex-col">
      {/* ---------- 顶栏：一句话入口 ---------- */}
      <header className="border-b border-[var(--color-border-soft)] px-6 py-4">
        <div className="flex items-center gap-4">
          <div className="shrink-0">
            <div className="text-lg font-semibold tracking-tight">Nexus</div>
            <div className="text-xs text-slate-400">一个网页里的软件工厂</div>
          </div>
          <input
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="用一句话描述你要做的软件，例如：做一个团队任务看板，能拖拽卡片、能标记完成、刷新后数据还在"
            className="min-w-0 flex-1 rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-surface)] px-4 py-2.5 text-sm outline-none placeholder:text-slate-500 focus:border-blue-500"
          />
          <button
            disabled={!prompt.trim()}
            className="shrink-0 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-500"
          >
            开始构建
          </button>
        </div>
      </header>

      {/* ---------- 主体三栏 ---------- */}
      <main className="grid min-h-0 flex-1 grid-cols-[280px_1fr_320px]">
        {/* 左：阶段流水线 */}
        <aside className="overflow-y-auto border-r border-[var(--color-border-soft)] p-3">
          <div className="mb-2 px-1 text-xs font-medium text-slate-400">
            流水线 · 六道工序
          </div>
          <ol className="space-y-2">
            {STAGES.map((s) => {
              const st = STATUS_STYLE[statuses[s.id]];
              return (
                <li
                  key={s.id}
                  className="rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-surface)] p-3"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">
                      {s.order}. {s.name}
                    </span>
                    <span className={`rounded border px-1.5 py-0.5 text-[10px] ${st.cls}`}>
                      {st.text}
                    </span>
                  </div>
                  <div className="mt-1.5 text-[11px] leading-relaxed text-slate-400">
                    {s.rationale}
                  </div>
                  <div className="mt-2 flex items-center gap-3 text-[10px] text-slate-500">
                    <span>契约 {s.artifact}</span>
                    <span>¥0.00</span>
                  </div>
                </li>
              );
            })}
          </ol>
        </aside>

        {/* 中：任务图 */}
        <section className="relative min-h-0 p-4">
          <div className="mb-2 text-xs font-medium text-slate-400">
            任务图 · 每个节点可暂停 / 改指令 / 从该点重跑
          </div>
          <div className="flex h-[calc(100%-1.5rem)] items-center justify-center rounded-lg border border-dashed border-[var(--color-border-soft)] bg-[var(--color-surface)]/40">
            <div className="text-center text-sm text-slate-500">
              <div>任务图将在编排内核接入后出现</div>
              <div className="mt-1 text-xs">
                并行的粒度是「模块」，不是「文件」
              </div>
            </div>
          </div>
        </section>

        {/* 右：产物与成本 */}
        <aside className="overflow-y-auto border-l border-[var(--color-border-soft)] p-3">
          <div className="mb-2 px-1 text-xs font-medium text-slate-400">
            产物契约与实时成本
          </div>

          <div className="rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-surface)] p-3">
            <div className="text-[11px] text-slate-400">本次运行花费</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums">¥0.00</div>
            <div className="mt-2 grid grid-cols-2 gap-2 text-[10px] text-slate-500">
              <div>输入 token 0</div>
              <div>输出 token 0</div>
              <div>思考 token 0</div>
              <div>缓存命中 0</div>
            </div>
          </div>

          <div className="mt-3 space-y-2">
            {STAGES.map((s) => (
              <div
                key={s.id}
                className="rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-surface)] p-3"
              >
                <div className="text-[11px] font-medium text-slate-300">
                  {s.artifact}
                </div>
                <ul className="mt-1.5 space-y-1">
                  {s.acceptance.map((a, i) => (
                    <li key={i} className="text-[10px] leading-relaxed text-slate-500">
                      · {a}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </aside>
      </main>

      {/* ---------- 底部：成品预览 ---------- */}
      <footer className="border-t border-[var(--color-border-soft)]">
        <div className="flex items-center justify-between px-4 py-2 text-xs text-slate-400">
          <span>成品预览</span>
          <span className="text-slate-500">
            预览端口不对外裸露，统一由服务端代理转发
          </span>
        </div>
        <div className="flex h-40 items-center justify-center border-t border-[var(--color-border-soft)] bg-[var(--color-surface)]/40 text-sm text-slate-500">
          生成完成后，这里出现可以直接点击使用的成品
        </div>
      </footer>
    </div>
  );
}