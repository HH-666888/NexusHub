"use client";

/**
 * 选项组
 * 一堆互斥选项的通用渲染器。抽出来的理由很实际：
 * 外观配置有 6 个维度，如果每个都手写一遍按钮组，
 * 样式和行为（选中态、键盘可达、禁用态）迟早会各走各的。
 */

export interface OptionItem {
  id: string;
  label: string;
  hint?: string;
  /** 色块预览用的颜色，只有配色类选项才需要 */
  swatch?: string;
}

export function OptionGroup({
  label,
  options,
  value,
  onChange,
  disabled,
  columns,
}: {
  label: string;
  options: readonly OptionItem[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  /** 一行放几个。默认自适应 */
  columns?: number;
}) {
  return (
    <div>
      <div className="mb-2 text-xs font-medium text-slate-300">{label}</div>
      <div
        role="radiogroup"
        aria-label={label}
        className="grid gap-1.5"
        style={{
          gridTemplateColumns: `repeat(${columns ?? options.length}, minmax(0, 1fr))`,
        }}
      >
        {options.map((opt) => {
          const selected = opt.id === value;
          return (
            <button
              key={opt.id}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={disabled}
              onClick={() => onChange(opt.id)}
              title={opt.hint}
              className={`flex items-center justify-center gap-1.5 rounded-lg border px-2 py-2 text-xs transition-[transform,border-color,background-color,color] duration-150 ease-out disabled:cursor-not-allowed disabled:opacity-50 ${
                selected
                  ? "border-[var(--app-accent)] bg-[var(--app-accent)]/15 text-white"
                  : "border-[var(--color-border-soft)] text-slate-400 hover:border-slate-500 hover:text-slate-200"
              }`}
            >
              {opt.swatch && (
                <span
                  aria-hidden
                  className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ background: opt.swatch }}
                />
              )}
              <span className="truncate">{opt.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
