import type { ReactNode } from "react";

/**
 * 节标题：给首页建立“节”的概念 —— 每节一个编号、一个名字、一句副说明。
 *
 * 原来的首页是几个孤立的块飘在空白里，彼此之间只有零散间距，没有任何结构信号，
 * 留白看起来像“这里没想好放什么”。编号分节是让长页面读起来有节奏最省力的办法。
 *
 * 编号是结构标记而不是内容：该被扫到，不该被读进去，所以用等宽字体、颜色压到最淡。
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
      {note && <span className="text-[11px] text-slate-600">{note}</span>}
    </div>
  );
}
