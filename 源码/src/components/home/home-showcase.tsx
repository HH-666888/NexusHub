import Link from "next/link";

/**
 * 能力展示
 * ============================================================
 * 参考图下半部分是「最近上新」—— 一排很大的图片卡片。
 *
 * ── 为什么我们这块不能照做 ──
 *   那是一排作品图。我们没有作品图可放：产物是 HTML，
 *   要出图得把每一条都渲染一遍。
 *   而且就算做了，那一块讲的也是「别人做了什么」，
 *   对我们来说不是重点。
 *
 * ── 换成讲「我们怎么工作」 ──
 *   这个产品的差异点全在过程上：图上看得见依赖、过程能回放、
 *   每一步花了多少钱。这三件事正好是三张卡片。
 *   每一张都对应一个**已经做出来的界面**，不是设想 ——
 *   点进去就能看到实物。
 *
 * 卡片里的小图是**用 DOM 画的示意图**，不是截图。
 *   截图会随界面改动过期，而且多几 MB 体积；
 *   示意图不会过期，也不会因为界面微调就变得对不上。
 */

interface Capability {
  href: string;
  tint: string;
  title: string;
  desc: string;
  /** 卡片下半部分那幅示意图 */
  art: "graph" | "timeline" | "cost";
}

const CAPS: Capability[] = [
  {
    href: "/studio?tab=graph",
    tint: "--tint-4",
    title: "任务图",
    desc: "六道工序的依赖与失败回退画成一张图，点一个节点就能看清它是怎么来的。",
    art: "graph",
  },
  {
    href: "/studio",
    tint: "--tint-1",
    title: "时间轴回放",
    desc: "生成过程会录下来。拖滑块回到任意一刻，看那一刻已经写了多少、花了多少。",
    art: "timeline",
  },
  {
    href: "/studio",
    tint: "--tint-6",
    title: "成本明细",
    desc: "每一次模型调用都单独记账，按阶段分开。钱花在哪一步，一眼看得到。",
    art: "cost",
  },
];

export function HomeShowcase() {
  return (
    <section className="mx-auto w-full max-w-[1400px] px-8 pb-24">
      <h2 className="mb-4 text-[15px] font-medium text-slate-200">它是怎么工作的</h2>

      <div className="grid grid-cols-3 gap-5">
        {CAPS.map((c) => (
          <Link
            key={c.title}
            href={c.href}
            className="group flex flex-col overflow-hidden rounded-2xl border border-[var(--color-border-soft)] transition-colors duration-150 hover:border-slate-600"
            style={{
              backgroundColor: "var(--color-surface)",
              backgroundImage: `linear-gradient(160deg, rgb(var(${c.tint}) / 0.1), transparent 55%)`,
            }}
          >
            {/* 示意图 */}
            <div className="flex h-44 items-center justify-center px-7">
              <Art kind={c.art} tint={c.tint} />
            </div>

            <div className="px-5 pt-1 pb-5">
              <div className="flex items-center gap-2">
                <span
                  aria-hidden
                  className="inline-block h-1.5 w-1.5 rounded-full"
                  style={{ background: `rgb(var(${c.tint}))` }}
                />
                <span className="text-[14px] font-medium text-slate-100">{c.title}</span>
              </div>
              <p className="mt-1.5 text-[12px] leading-relaxed text-slate-500">{c.desc}</p>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}

/* ============================================================
   示意图。全部用 div 画，不引图片也不引图表库
   ============================================================ */

function Art({ kind, tint }: { kind: Capability["art"]; tint: string }) {
  // 任务图那张自己带六道工序各自的颜色，用不到卡片的主色
  if (kind === "graph") return <GraphArt />;
  if (kind === "timeline") return <TimelineArt tint={tint} />;
  return <CostArt tint={tint} />;
}

/** 任务图：六个小方块与连线，画的是流水线本身的结构 */
function GraphArt() {
  const tints = ["--tint-1", "--tint-2", "--tint-3", "--tint-4", "--tint-5", "--tint-6"];
  return (
    <div className="w-full">
      <div className="grid grid-cols-3 gap-2.5">
        {tints.map((t, i) => (
          <div
            key={t}
            className="flex h-11 items-center gap-1.5 rounded-lg border px-2"
            style={{
              borderColor: `rgb(var(${t}) / 0.45)`,
              backgroundColor: `rgb(var(${t}) / 0.1)`,
            }}
          >
            <span
              aria-hidden
              className="inline-block h-1 w-1 rounded-full"
              style={{ background: `rgb(var(${t}))` }}
            />
            <span
              className="font-mono text-[9px] font-semibold"
              style={{ color: `rgb(var(${t}))` }}
            >
              {String(i + 1).padStart(2, "0")}
            </span>
          </div>
        ))}
      </div>
      {/* 失败回退：一条从下往上的虚线，说明流程不是单向瀑布 */}
      <div className="mt-2 flex items-center gap-2 px-1">
        <span
          aria-hidden
          className="h-px flex-1"
          style={{
            backgroundImage:
              "repeating-linear-gradient(90deg, rgba(217,119,6,.6) 0 4px, transparent 4px 8px)",
          }}
        />
        <span className="text-[9px] text-amber-600/80">失败可退回</span>
      </div>
    </div>
  );
}

/** 时间轴：一条带滑块的进度条，画的是「可以拖回任意一刻」 */
function TimelineArt({ tint }: { tint: string }) {
  return (
    <div className="w-full">
      <div className="flex items-center gap-3">
        <span
          aria-hidden
          className="flex h-6 w-6 flex-none items-center justify-center rounded-md text-[9px] text-white"
          style={{ background: `rgb(var(${tint}) / 0.85)` }}
        >
          ▶
        </span>
        <div className="relative h-1 flex-1 rounded-full bg-[var(--color-border-soft)]">
          <div
            className="absolute inset-y-0 left-0 rounded-full"
            style={{ width: "62%", background: `rgb(var(${tint}))` }}
          />
          <span
            aria-hidden
            className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[var(--color-canvas)]"
            style={{ left: "62%", background: "var(--ink-1)" }}
          />
        </div>
        <span className="flex-none font-mono text-[9px] tabular-nums text-slate-600">
          8.2s
        </span>
      </div>
      {/* 刻度：让人看出这是一条时间轴而不是普通进度条 */}
      <div className="mt-2.5 flex justify-between px-9">
        {["0.0", "2.0", "4.0", "6.0", "8.2"].map((t) => (
          <span key={t} className="font-mono text-[8.5px] text-slate-700">
            {t}
          </span>
        ))}
      </div>
    </div>
  );
}

/** 成本：几条横条，画的是「按阶段分开记账」 */
function CostArt({ tint }: { tint: string }) {
  const rows = [
    { label: "规格化", pct: 18, t: "--tint-3" },
    { label: "并行构建", pct: 100, t: tint },
    { label: "验收", pct: 9, t: "--tint-6" },
  ];
  return (
    <div className="w-full space-y-2.5">
      {rows.map((r) => (
        <div key={r.label} className="flex items-center gap-3">
          <span className="w-14 flex-none text-[10.5px] text-slate-500">{r.label}</span>
          <div className="h-1.5 flex-1 rounded-full bg-[var(--color-border-soft)]">
            <div
              className="h-full rounded-full"
              style={{ width: `${r.pct}%`, background: `rgb(var(${r.t}) / 0.85)` }}
            />
          </div>
        </div>
      ))}
      <div className="pt-1 text-right font-mono text-[10px] tabular-nums text-slate-600">
        合计 ¥0.0256
      </div>
    </div>
  );
}