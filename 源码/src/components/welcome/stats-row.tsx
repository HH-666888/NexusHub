import { TINT_OPTIONS } from "@/core/domain/appearance";

/**
 * 首页数字栏
 * ============================================================
 * 四个数字，**全部是实测值，不是营销数字**：
 *
 *   6 道      —— 流水线工序数，写死在 core/pipeline/stages.ts
 *   7 项      —— 成品自检项数，写死在 core/generate/prompt.ts
 *   ¥0.025    —— 一次真实生成的实测花费，见 cost_records 表
 *   23 KB     —— 实测产物大小，单文件零依赖
 *
 * ── 为什么坚持用真实值 ──
 *   参赛作品最容易被问倒的地方就是「这个数字哪来的」。
 *   写「服务 100 万用户」当场就会被追问，而写「一次生成 ¥0.025」
 *   我们能把 9 次调用记录调出来给他看。
 *
 *   这一条是硬约束：**这四个数字里任何一个变了，这里必须跟着改**，
 *   否则就变成了另一种形式的「界面写着已通过但交不出产物」。
 *
 * ── 参考来源 ──
 *   分节 + 数据行 + 卡片，来自 MiMo 与 MiniMax 首页的结构。
 *   颜色和字体完全沿用现有令牌，没有引入任何新色。
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