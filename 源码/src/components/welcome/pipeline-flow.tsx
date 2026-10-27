import type { CSSProperties } from "react";
import { tintVarAt } from "@/core/domain/appearance";
import { STAGES } from "@/core/pipeline/stages";

/**
 * 首页核心视觉：一句话 → 六道工序 → 一个成品。
 *
 * 性能是硬约束：动效只改 transform 与 opacity（跳过布局与绘制，直接由 GPU 合成），
 * 「节点点亮」用覆盖层的 opacity 而不是改 background-color 或 box-shadow —— 后者每帧重绘。
 * 全场没有一张图片、没有一行动画 JS，引入库带来的几十 KB 在这里是 0。
 *
 * 阶段数据取自 core/pipeline/stages：首页讲的六道工序就是产品里真正跑的那六道。
 */
export function PipelineFlow() {
  return (
    <div className="relative mx-auto w-full max-w-3xl">
      {/* 输入：用户说的那一句话 */}
      <div className="animate-rise mx-auto max-w-xl" style={{ animationDelay: "0.15s" }}>
        <div className="flex items-center gap-3 rounded-xl border border-[var(--color-border-soft)] bg-[var(--color-surface)] px-4 py-3">
          <span aria-hidden className="text-slate-500">
            ▸
          </span>
          <p className="flex-1 truncate text-left text-sm text-slate-300">
            做一个团队任务看板，能拖拽卡片、刷新后数据还在
          </p>
          <span
            aria-hidden
            className="caret inline-block h-4 w-0.5 bg-[var(--app-accent-soft)] align-middle"
          />
        </div>
        <p className="mt-2 text-center text-[11px] text-slate-500">
          你只需要说这一句
        </p>
      </div>

      {/* ---------- 连接线 ---------- */}
      <div
        aria-hidden
        className="animate-rise mx-auto h-8 w-px bg-gradient-to-b from-[var(--color-border-soft)] to-blue-500/50"
        style={{ animationDelay: "0.3s" }}
      />

      {/* 流水线：六道工序依次点亮 */}
      <div
        className="animate-rise relative"
        style={{ animationDelay: "0.45s" }}
      >
        <ol className="relative grid grid-cols-3 gap-2 sm:grid-cols-6 sm:gap-3">
          {STAGES.map((stage, i) => (
            <li
              key={stage.id}
              className="relative"
              style={{ "--tint": tintVarAt(i) } as CSSProperties}
            >
              {/*
                点亮的覆盖层。位移量 = 索引 × 固定间隔，
                形成一道依次流过的波，视觉上就是「工厂在运转」。

                颜色用该工序自己的辅助色（第 i 个位置），而不是统一的强调色 ——
                六道工序各一色，扫过去的时候能看清「现在是第几道」。
              */}
              <span
                aria-hidden
                className="pipeline-node-glow absolute -inset-px rounded-xl"
                style={{
                  animationDelay: `${i * 0.55}s`,
                  // 用 inset box-shadow 而不是 ring 工具类，是为了能直接引用
                  // 带透明度的变量值 —— Tailwind 无法给未知变量算 alpha。
                  backgroundColor: "rgb(var(--tint) / 0.22)",
                  boxShadow: "inset 0 0 0 1px rgb(var(--tint) / 0.85)",
                }}
              />

              {/* 卡片本体：底色与彩色渐变分两层写，
                  只写渐变会让卡片透出页面底色，边界就没了 */}
              <div
                className="relative overflow-hidden rounded-xl border px-2 py-3 text-center"
                style={{
                  borderColor: "rgb(var(--tint) / 0.45)",
                  backgroundImage:
                    "linear-gradient(165deg, rgb(var(--tint) / 0.2) 0%, rgb(var(--tint) / 0.06) 55%, transparent 100%)",
                  backgroundColor: "var(--color-surface)",
                  boxShadow: "0 0 20px -10px rgb(var(--tint) / 0.75)",
                }}
              >
                {/* 顶部细亮线 ——「光亮感」的主要来源 */}
                <span
                  aria-hidden
                  className="absolute inset-x-0 top-0 h-px"
                  style={{
                    background:
                      "linear-gradient(90deg, transparent, rgb(var(--tint) / 0.95), transparent)",
                  }}
                />
                <div className="flex items-center justify-center gap-1.5">
                  <span
                    aria-hidden
                    className="tint-dot inline-block h-1.5 w-1.5 rounded-full"
                  />
                  <span
                    className="text-[10px] font-medium tabular-nums"
                    style={{ color: "rgb(var(--tint))" }}
                  >
                    {String(stage.order).padStart(2, "0")}
                  </span>
                </div>
                <div className="mt-1 text-xs font-medium text-slate-200">
                  {stage.name}
                </div>
                <div className="mt-1 truncate text-[10px] text-slate-500">
                  {stage.artifact}
                </div>
              </div>
            </li>
          ))}
        </ol>

        <p className="mt-2 text-center text-[11px] text-slate-500">
          六道工序自动跑完 · 每一步都有可校验的产物
        </p>
      </div>

      {/* ---------- 连接线 ---------- */}
      <div
        aria-hidden
        className="animate-rise mx-auto h-8 w-px bg-gradient-to-b from-blue-500/50 to-[var(--color-border-soft)]"
        style={{ animationDelay: "0.6s" }}
      />

      {/* ---------- 输出：生成的成品 ---------- */}
      <div
        className="animate-rise mx-auto max-w-md"
        style={{ animationDelay: "0.75s" }}
      >
        <div className="overflow-hidden rounded-xl border border-[var(--color-border-soft)] bg-[var(--color-surface)] shadow-2xl">
          {/* 窗口标题栏 */}
          <div className="flex items-center gap-1.5 border-b border-[var(--color-border-soft)] px-3 py-2">
            <span aria-hidden className="h-2 w-2 rounded-full bg-slate-600" />
            <span aria-hidden className="h-2 w-2 rounded-full bg-slate-600" />
            <span aria-hidden className="h-2 w-2 rounded-full bg-slate-600" />
            <span className="ml-2 text-[10px] text-slate-500">
              成品 · 可以直接点开使用
            </span>
          </div>

          {/* 一个极简的看板缩略图，纯 div 画出来，没有图片 */}
          <div className="grid grid-cols-3 gap-2 p-3">
            {[
              { title: "待办", n: 2, tone: "bg-amber-400/70" },
              { title: "进行中", n: 1, tone: "bg-blue-400/70" },
              { title: "已完成", n: 1, tone: "bg-green-400/70" },
            ].map((col) => (
              <div key={col.title} className="space-y-1.5">
                <div className="flex items-center gap-1.5">
                  <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${col.tone}`} />
                  <span className="text-[9px] text-slate-400">{col.title}</span>
                </div>
                {Array.from({ length: col.n }).map((_, i) => (
                  <div
                    key={i}
                    className="rounded border border-[var(--color-border-soft)] bg-[var(--color-surface-2)] p-1.5"
                  >
                    <div className="h-1 w-3/4 rounded-full bg-slate-600" />
                    <div className="mt-1 h-1 w-1/2 rounded-full bg-slate-700" />
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
        <p className="mt-2 text-center text-[11px] text-slate-500">
          交给你的不是一个代码压缩包，是一个能点开就用的东西
        </p>
      </div>
    </div>
  );
}