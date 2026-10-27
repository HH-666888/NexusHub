import { TINT_OPTIONS } from "@/core/domain/appearance";

/**
 * 首页数字栏。四个数字全部是实测值，不是营销数字 ——
 * 参赛作品最容易被问倒的地方就是「这个数字哪来的」。
 * 任何一个变了，这里必须跟着改，否则就成了另一种「界面写着已通过但交不出产物」。
 *
 * 分节 + 数据行 + 卡片的结构来自 MiMo 与 MiniMax 首页，颜色与字体沿用现有令牌。
 */

const STATS = [
  { value: "6", unit: "道", label: "工序自动跑完" },
  { value: "7", unit: "项", label: "成品自检必过" },
  { value: "¥0.025", unit: "", label: "一次生成实测成本" },
  { value: "23", unit: "KB", label: "单文件，零依赖" },
] as const;

export function StatsRow() {
  // 用 grid + gap 画分隔线：比给每个格子写 border 更干净，
  // 也不会在换行时留下多余的边框
  return (
    <div
      className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-[var(--color-border-soft)] bg-[var(--color-border-soft)] sm:grid-cols-4"
      style={{ "--tint": `rgb(${TINT_OPTIONS[0].colors[0]})` } as React.CSSProperties}
    >
      {STATS.map((s) => (
        <div
          key={s.label}
          className="bg-[var(--color-surface)] px-4 py-5 text-center"
        >
          <div className="text-2xl font-semibold tracking-tight text-slate-100 tabular-nums">
            {s.value}
            {s.unit && (
              <span className="ml-0.5 text-sm font-normal text-slate-400">
                {s.unit}
              </span>
            )}
          </div>
          <div className="mt-1.5 text-[11px] text-slate-500">{s.label}</div>
        </div>
      ))}
    </div>
  );
}