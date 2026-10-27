"use client";

import { tintVarAt } from "@/core/domain/appearance";
import { explainAuthority } from "@/core/pipeline/authority";
import type { PipelineNode } from "@/core/pipeline/graph";
import { describeTrace, nodeMetrics, nodeStatusLabel, type PathTrace } from "@/core/pipeline/graph";
import { STAGE_MAP, type StageId } from "@/core/pipeline/stages";

/**
 * 工序详情：点画布上的一道工序，这里展开它。
 * 画布只能表达状态和关系，「这一道为什么存在」是句子，只能写出来。
 */

export interface StageDetailProps {
  node: PipelineNode | null;
  trace: PathTrace | null;
  onClose: () => void;
}

export function StageDetail({ node, trace, onClose }: StageDetailProps) {
  if (!node) return null;

  const empty = node.implementation === "planned";
  const tint = tintVarAt(node.order - 1);
  const nameOf = (id: StageId) => STAGE_MAP[id]?.name ?? id;

  return (
    <div
      data-stage-detail
      // 画布外层挂着拖拽的指针事件，面板要收回事件 ——
        // 否则在面板上按下会开始平移画布，关闭按钮也点不准。
      className="pointer-events-auto absolute bottom-4 left-4 w-80 rounded-xl border bg-[var(--color-surface)]/95 p-3.5 backdrop-blur"
      style={{ borderColor: `rgb(${tint} / 0.4)` }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="font-mono text-[10.5px] font-semibold" style={{ color: `rgb(${tint})` }}>
              {String(node.order).padStart(2, "0")}
            </span>
            <span className="text-[14px] font-medium text-slate-100">{node.name}</span>
            <span
              className="rounded border px-1.5 py-px text-[10px] whitespace-nowrap"
              style={{ borderColor: `rgb(${tint} / 0.5)`, color: `rgb(${tint})` }}
            >
              {nodeStatusLabel(node)}
            </span>
          </div>
          <div className="mt-1 font-mono text-[10.5px] text-slate-500">{node.artifact}</div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭"
          className="flex-none text-slate-600 transition-colors duration-150 hover:text-slate-300"
        >
          ✕
        </button>
      </div>

      {/* 原理：这一道为什么存在 */}
      <p className="mt-2.5 text-[11.5px] leading-relaxed text-slate-400">{node.rationale}</p>

      {/* 权限 */}
      <div className="mt-2.5 border-t border-[var(--color-border-soft)] pt-2.5">
        <div className="text-[10px] text-slate-500">谁在做 · 能改什么</div>
        <div className="mt-1 text-[11px] leading-relaxed text-slate-400">
          {explainAuthority(node)}
        </div>
        {node.approval === "human" && (
          <div
            className={`mt-1.5 text-[10.5px] leading-relaxed ${
              node.gateActive ? "text-orange-300/90" : "text-amber-500/80"
            }`}
          >
            {node.gateActive
              ? "这一步会停下来问人，答完才继续。"
              : "⚠️ 这一步声明了要人点头，但当前设置是先放行 —— 模型会替你猜，错了要到验收才发现。"}
          </div>
        )}
      </div>

      {/* 看什么数 */}
      <div className="mt-2.5 border-t border-[var(--color-border-soft)] pt-2.5">
        <div className="text-[10px] text-slate-500">看什么数</div>
        <ul className="mt-1 space-y-0.5">
          {node.watches.map((w) => (
            <li key={w.label} className="text-[11px] text-slate-400">
              {w.label}
              {w.hint && <span className="text-slate-600">（{w.hint}）</span>}
            </li>
          ))}
        </ul>
      </div>

      {/* 花费 / 未接入 */}
      {empty ? (
        <p className="mt-2.5 border-t border-[var(--color-border-soft)] pt-2.5 text-[10.5px] leading-relaxed text-slate-500">
          这一道工序当前不产出契约文件，正在接入中。现在由直通模式直接跳到构建。
        </p>
      ) : (
        nodeMetrics(node).length > 0 && (
          <div className="mt-2.5 flex gap-4 border-t border-[var(--color-border-soft)] pt-2.5 text-[11px] tabular-nums">
            {nodeMetrics(node).map((m) => (
              <span key={m.label} className="text-slate-400">
                <span className="text-slate-500">{m.label} </span>
                {m.value}
              </span>
            ))}
          </div>
        )
      )}

      {/* 路径追踪 */}
      {trace && (
        <div className="mt-2.5 border-t border-[var(--color-border-soft)] pt-2.5">
          <div className="text-[10px] text-slate-500">这条链</div>
          <div className="mt-1 text-[11px] leading-relaxed text-slate-400">
            {describeTrace(trace, nameOf)}
          </div>
          {trace.fallbacksIntoChain.length > 0 && (
            <div className="mt-1.5 text-[10.5px] leading-relaxed text-amber-500/80">
              {trace.fallbacksIntoChain
                .map((f) => `${nameOf(f.from)} 失败会退回 ${nameOf(f.to)}`)
                .join("；")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}