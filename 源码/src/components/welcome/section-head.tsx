import type { ReactNode } from "react";

/**
 * 节标题
 * ============================================================
 * 给首页建立「节」的概念：每节有一个编号、一个名字、一句副说明。
 *
 * ── 为什么需要它 ──
 *   原来的首页是「几个孤立的块飘在空白里」：首屏、流水线、行动区、特性卡，
 *   彼此之间只有零散间距，没有任何结构信号。结果是留白看起来像
 *   「这里没想好放什么」，而不是「有意的间隔」。
 *
 *   参考的几个 AI 产品官网（MiMo、MiniMax）无一例外都用了编号分节，
 *   每一节有自己的标题和密度。这是让长页面读起来「有节奏」最省力的办法。
 *
 * ── 为什么编号用等宽字体、颜色压到最淡 ──
 *   编号是**结构标记**，不是内容。它该被眼睛扫到，但不该被读进去。
 *   用主色或者加粗都会让它抢内容的注意力，那是反的。
 */
export function SectionHead({
  no,
  title,
  note,
}: {
  /** 两位编号，如 "01" */
  no: string;
  title: string;
  /** 右侧的一句补充。可选 —— 没有就不占位 */
  note?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
      <div className="flex items-baseline">
        <span className="border-r border-[var(--color-border-soft)] pr-3 font-mono text-[11px] tracking-[0.14em] text-slate-600">
          {no}
        </span>
        <span className="pl-3 text-sm font-medium tracking-[0.01em] text-slate-300">
          {title}
        </span>
      </div>
      {note && (
        <span className="text-[11px] text-slate-600">{note}</span>
      )}
    </div>
  );
}