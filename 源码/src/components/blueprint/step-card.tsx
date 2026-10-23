import { tintVarAt } from "@/core/domain/appearance";
import { actorBadge, type LoopStep } from "@/core/blueprint/loop";

/**
 * 闭环里的一张步骤卡
 * ============================================================
 * 版式照参考图：编号 + 名字 + 权限徽章 / 正文 / 原理条。
 *
 * ── 一块卡片里最要紧的不是名字，是底下那条「原理」──
 *   参考图上每一步底下都有一条黄标签：
 *     02  只看不碰店铺：看错了，最多写错一句话
 *     04  上新、下架、对外回复，只有人能点头
 *   那一条回答的是**为什么这么分工**。
 *   抽掉它，这一屏就退化成一张普通的流程图 ——
 *   而普通流程图到处都是，不缺我们这一张。
 *   所以它不是可选装饰，是这张卡的主干。
 *
 * ── 徽章的可视重量跟着风险走 ──
 *   「AI · 只读」是细边线的浅色小标签；
 *   「AI · 干活」是实心的琥珀色。
 *   两者在同一屏里出现时，眼睛会先看到危险的那个 ——
 *   这正是我们想让用户形成的直觉：
 *   **这套东西里，能改东西的那一步才是需要盯的。**
 */

export interface StepCardProps {
  step: LoopStep;
  /** 用第几号配色。按步骤在圈里的位置分配 */
  tintIndex?: number;
  /** 高亮状态。悬停或选中时用 */
  active?: boolean;
  /** 变暗。有别的步骤被选中时，其余降透明度 */
  dimmed?: boolean;
  className?: string;
}

export function StepCard({
  step,
  tintIndex = 0,
  active = false,
  dimmed = false,
  className = "",
}: StepCardProps) {
  const tint = tintVarAt(tintIndex);

  return (
    <article
      data-step-card={step.id}
      className={`rounded-xl border p-3 transition-[opacity,border-color] duration-200 ${className}`}
      style={{
        // 边框和底色都从这个位置的配色来 —— 边上那六块各有各的颜色，
        // 是为了让"哪一块在动"在一屏里能被认出来
        borderColor: active ? `rgb(${tint} / 0.75)` : `rgb(${tint} / 0.28)`,
        backgroundColor: active ? `rgb(${tint} / 0.09)` : "var(--color-surface)",
        opacity: dimmed ? 0.35 : 1,
      }}
    >
      {/* ---------- 头部：编号 + 名字 + 权限 ---------- */}
      <header className="flex items-center gap-2">
        <span
          className="flex-none font-mono text-[11px] leading-none font-semibold"
          style={{ color: `rgb(${tint})` }}
        >
          {String(step.order).padStart(2, "0")}
        </span>
        <h3 className="min-w-0 flex-1 truncate text-[13px] leading-tight font-medium text-slate-100">
          {step.name}
        </h3>
        <ActorBadge step={step} className="flex-none" />
      </header>

      {/* ---------- 正文：这一步具体干什么 ---------- */}
      <p className="mt-2 text-[11.5px] leading-relaxed text-slate-400">{step.duty}</p>

      {/* ---------- 看什么数（有的步骤有） ---------- */}
      {step.watches && step.watches.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {step.watches.map((w) => (
            <span
              key={w.label}
              className="rounded border border-[var(--color-border-soft)] px-1.5 py-0.5 text-[10px] text-slate-500"
            >
              {w.label}
              {w.hint && <span className="ml-1 text-slate-600">{w.hint}</span>}
            </span>
          ))}
        </div>
      )}

      <RationaleBar text={step.rationale} />
    </article>
  );
}

/* ============================================================
   原理条
   ============================================================ */

/**
 * 那条黄标签的「原理」。
 *
 * 单独抽出来是因为**它在别处也要用**：
 * 放大看某一步时（点格放大）、走通的例子里，
 * 同一个原理会在不同的位置再出现一次。
 * 内联在卡片里的话，那两处就得各写一遍，然后慢慢长得不一样。
 */
export function RationaleBar({ text, className = "" }: { text: string; className?: string }) {
  return (
    <div
      data-rationale
      className={`mt-2.5 flex gap-2 rounded-lg border border-dashed border-[var(--color-border-soft)] px-2.5 py-2 ${className}`}
    >
      {/*
        标签用实心琥珀，是这一屏里唯一一个"实心"的小色块 ——
        它在一片细边线里会被眼睛先抓到。
        这是刻意的：这句话比卡片上任何别的字都更值得读。
      */}
      <span className="h-fit flex-none rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] leading-tight font-medium text-amber-300">
        原理
      </span>
      <p className="text-[10.5px] leading-relaxed text-slate-400">{text}</p>
    </div>
  );
}

/* ============================================================
   权限徽章
   ============================================================ */

/**
 * 这个角色能干什么。
 *
 * 文案由核心层的 actorBadge 给（那条规则不算界面的事，
 * 见 loop.ts 里的说明），这里只负责把它画成对应的重量。
 */
export function ActorBadge({
  step,
  className = "",
}: {
  step: Pick<LoopStep, "actor" | "mode">;
  className?: string;
}) {
  const label = actorBadge(step);

  /*
    四档的视觉重量，从轻到重：
      程序自动  细边线、灰        —— 它只是取数，不参与判断
      AI · 只读 细边线、青        —— 能看，改不了
      AI · 干活 **实心、琥珀**    —— 能改，这一档要盯
      人        实心、橙 + 图标   —— 唯一能为对外动作负责的
  */
  const style: Record<string, string> = {
    程序自动: "border border-[var(--color-border-soft)] text-slate-500",
    "AI · 只读": "border border-cyan-500/35 text-cyan-300/90",
    "AI · 干活": "bg-amber-500/85 text-amber-950 font-medium",
    人: "bg-orange-500/90 text-orange-950 font-medium",
  };

  return (
    <span
      data-actor-badge={label}
      className={`rounded px-1.5 py-0.5 text-[10px] leading-tight whitespace-nowrap ${style[label] ?? style.程序自动} ${className}`}
    >
      {label === "人" && <span aria-hidden>◇ </span>}
      {label}
    </span>
  );
}