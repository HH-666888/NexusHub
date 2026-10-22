"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { GenerateEvent, GeneratePhase } from "@/core/generate/service";
import type { CheckResult } from "@/core/domain/check";

/**
 * 实时生成控制台
 * ============================================================
 * 连上 SSE 接口，把模型的输出、成本、检查结果实时摊开在用户面前。
 *
 * 这是整个产品定位「把过程完全摊开」最直接的体现：
 *   用户不需要盯着转圈图标猜它在干什么 —— 模型正在写什么、
 *   这一步花了多少钱、已经通过了几项检查，全都看得见。
 *
 * 两个实现上的关键点：
 *
 *   ① 收到的 `done` / `failed` 阶段事件后**主动关闭连接**。
 *      浏览器原生的 EventSource 在连接被服务端正常关闭后会**自动重连**，
 *      不关的话就会变成「生成完了 → 重连 → 服务端说已有成品 → 关闭 → 再重连」
 *      这样一条无限循环。虽然服务端有幂等保护不会重复花钱，
 *      但会一直打请求，日志也会被刷满。
 *
 *   ② 流式内容按帧批量写入 state，而不是收到一块写一次。
 *      一次生成会推来三千多个片段，逐块 setState 会造成三千多次渲染。
 *      用 requestAnimationFrame 合并成每帧一次，渲染次数降到几十次。
 */

const PHASE_LABEL: Record<GeneratePhase, string> = {
  generating: "正在生成",
  checking: "正在检查",
  saving: "正在保存",
  done: "已完成",
  failed: "未通过",
};

const PHASE_TONE: Record<GeneratePhase, string> = {
  generating: "border-blue-700 bg-blue-950/40 text-blue-300",
  checking: "border-blue-700 bg-blue-950/40 text-blue-300",
  saving: "border-blue-700 bg-blue-950/40 text-blue-300",
  done: "border-green-700 bg-green-950/40 text-green-300",
  failed: "border-amber-700 bg-amber-950/40 text-amber-300",
};

export function GenerationConsole({
  runId,
  hasArtifact,
  onSettled,
}: {
  runId: string;
  /** 已经产出过成品时不自动开始，让用户自己决定要不要重跑 */
  hasArtifact: boolean;
  /** 生成结束时通知外层刷新数据 */
  onSettled: () => void;
}) {
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState<GeneratePhase | null>(null);
  const [phaseLabel, setPhaseLabel] = useState("");
  const [text, setText] = useState("");
  const [reasoning, setReasoning] = useState("");
  const [cost, setCost] = useState<number | null>(null);
  const [latency, setLatency] = useState<number | null>(null);
  const [usage, setUsage] = useState<{ in: number; out: number; think: number } | null>(null);
  const [checks, setChecks] = useState<CheckResult[] | null>(null);
  const [error, setError] = useState<{ message: string; hint?: string } | null>(null);
  const [showReasoning, setShowReasoning] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);

  const sourceRef = useRef<EventSource | null>(null);
  const scrollRef = useRef<HTMLPreElement | null>(null);
  /** 待写入的片段。累积到下一帧再一次性合并进 state */
  const pendingRef = useRef({ text: "", reasoning: "" });
  const rafRef = useRef<number | null>(null);

  /* ---------- 按帧合并流式片段 ---------- */
  const flush = useCallback(() => {
    rafRef.current = null;
    const pending = pendingRef.current;
    if (pending.text) {
      const chunk = pending.text;
      pending.text = "";
      setText((prev) => prev + chunk);
    }
    if (pending.reasoning) {
      const chunk = pending.reasoning;
      pending.reasoning = "";
      setReasoning((prev) => prev + chunk);
    }
  }, []);

  const scheduleFlush = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(flush);
  }, [flush]);

  /* ---------- 关闭连接并清理 ---------- */
  const stop = useCallback(() => {
    sourceRef.current?.close();
    sourceRef.current = null;
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    flush();
    setRunning(false);
  }, [flush]);

  // 组件卸载时一定要断开，否则离开页面后连接还挂着
  useEffect(() => stop, [stop]);

  /* ---------- 计时器 ---------- */
  useEffect(() => {
    if (!running || startedAt === null) return;
    const timer = setInterval(() => setElapsed(Date.now() - startedAt), 200);
    return () => clearInterval(timer);
  }, [running, startedAt]);

  /* ---------- 自动滚到底 ---------- */
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [text, reasoning, showReasoning]);

  /* ---------- 发起生成 ---------- */
  const start = useCallback(() => {
    if (sourceRef.current) return;

    setRunning(true);
    setPhase("generating");
    setPhaseLabel("正在连接…");
    setText("");
    setReasoning("");
    setCost(null);
    setLatency(null);
    setUsage(null);
    setChecks(null);
    setError(null);
    setStartedAt(Date.now());
    setElapsed(0);
    pendingRef.current = { text: "", reasoning: "" };

    const es = new EventSource(`/api/runs/${runId}/generate`);
    sourceRef.current = es;

    es.onmessage = (msg) => {
      let event: GenerateEvent;
      try {
        event = JSON.parse(msg.data) as GenerateEvent;
      } catch {
        return; // 半截数据直接跳过，不因为一行坏掉中断整条流
      }

      switch (event.kind) {
        case "phase":
          setPhase(event.phase);
          setPhaseLabel(event.label);
          if (event.phase === "done" || event.phase === "failed") {
            stop();
            onSettled();
          }
          break;

        case "text":
          pendingRef.current.text += event.delta;
          scheduleFlush();
          break;

        case "reasoning":
          pendingRef.current.reasoning += event.delta;
          scheduleFlush();
          break;

        case "usage":
          setCost(event.costCny);
          setLatency(event.latencyMs);
          setUsage({
            in: event.usage.inputTokens,
            out: event.usage.outputTokens,
            think: event.usage.reasoningTokens,
          });
          break;

        case "check":
          setChecks(event.results);
          break;

        case "artifact":
          // 产物事件只是通知，预览区由外层刷新后自行加载
          break;

        case "error":
          setError({ message: event.message, hint: event.hint });
          break;
      }
    };

    es.onerror = () => {
      // 服务端正常收尾也会触发 onerror。如果已经在终态，忽略即可。
      if (phase === "done" || phase === "failed") {
        stop();
        return;
      }
      setError({
        message: "连接中断",
        hint: "可能是服务器重启或网络抖动。已有产物仍然保留。",
      });
      stop();
      onSettled();
    };
  }, [runId, stop, scheduleFlush, onSettled, phase]);

  /* ---------- 渲染 ---------- */
  const passed = checks?.filter((c) => c.pass).length ?? 0;
  const total = checks?.length ?? 0;
  const activeText = showReasoning ? reasoning : text;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 状态条 */}
      <div className="flex flex-wrap items-center gap-3 border-b border-[var(--color-border-soft)] px-4 py-2 text-xs">
        {running || phase ? (
          <span
            className={`rounded border px-2 py-0.5 text-[11px] ${
              PHASE_TONE[phase ?? "generating"]
            }`}
          >
            {PHASE_LABEL[phase ?? "generating"]}
            {phaseLabel ? ` · ${phaseLabel}` : ""}
          </span>
        ) : (
          <span className="rounded border border-[var(--color-border-soft)] px-2 py-0.5 text-[11px] text-slate-400">
            {hasArtifact ? "已有成品" : "还没生成过"}
          </span>
        )}

        {running && (
          <span className="tabular-nums text-slate-500">
            {(elapsed / 1000).toFixed(1)} 秒
          </span>
        )}

        {cost !== null && (
          <span className="tabular-nums text-slate-400">
            本次 ¥{cost.toFixed(4)}
          </span>
        )}
        {latency !== null && (
          <span className="tabular-nums text-slate-500">
            模型耗时 {(latency / 1000).toFixed(1)} 秒
          </span>
        )}

        {total > 0 && (
          <span
            className={`tabular-nums ${
              passed === total ? "text-green-400" : "text-amber-400"
            }`}
          >
            检查 {passed}/{total} 通过
          </span>
        )}

        <div className="ml-auto flex items-center gap-2">
          {(text || reasoning) && (
            <button
              type="button"
              onClick={() => setShowReasoning((v) => !v)}
              className="rounded border border-[var(--color-border-soft)] px-2 py-0.5 text-[11px] text-slate-400 transition-colors duration-150 hover:border-slate-500 hover:text-slate-200"
            >
              {showReasoning ? "看正文" : "看思考"}
            </button>
          )}
          {running ? (
            <button
              type="button"
              onClick={stop}
              className="rounded border border-amber-800 bg-amber-950/40 px-2.5 py-0.5 text-[11px] text-amber-300 transition-colors duration-150 hover:bg-amber-950/70"
            >
              叫停
            </button>
          ) : (
            <button
              type="button"
              onClick={start}
              className="rounded bg-[var(--app-accent)] px-3 py-1 text-[11px] font-medium text-white transition-[transform,background-color] duration-150 ease-out hover:-translate-y-px hover:opacity-90"
            >
              {hasArtifact ? "重新生成（会再花一次钱）" : "开始生成"}
            </button>
          )}
        </div>
      </div>

      {/* 用量明细 */}
      {usage && (
        <div className="flex flex-wrap gap-3 border-b border-[var(--color-border-soft)] px-4 py-1.5 text-[11px] text-slate-500">
          <span className="tabular-nums">输入 {usage.in}</span>
          <span className="tabular-nums">输出 {usage.out}</span>
          <span className="tabular-nums">其中思考 {usage.think}</span>
          {usage.think === 0 && (
            <span className="text-slate-600">
              （思考已关闭 —— 实测这类任务关掉更快也更完整）
            </span>
          )}
        </div>
      )}

      {/* 错误 */}
      {error && (
        <div
          role="alert"
          className="border-b border-amber-900/50 bg-amber-950/30 px-4 py-2 text-[11px] text-amber-300"
        >
          {error.message}
          {error.hint && (
            <span className="ml-2 text-amber-400/70">建议：{error.hint}</span>
          )}
        </div>
      )}

      {/* 检查失败项 */}
      {checks && passed < total && (
        <ul className="border-b border-amber-900/40 bg-amber-950/20 px-4 py-2 text-[11px] text-amber-300/90">
          {checks
            .filter((c) => !c.pass)
            .map((c) => (
              <li key={c.name}>
                · {c.name}：{c.detail}
              </li>
            ))}
        </ul>
      )}

      {/* 流式内容 */}
      <pre
        ref={scrollRef}
        className="scroll-hint min-h-0 flex-1 overflow-auto px-4 py-3 pb-0 text-[11px] leading-relaxed whitespace-pre-wrap text-slate-400"
      >
        {activeText || (
          <span className="text-slate-600">
            {running
              ? "等待模型返回…"
              : hasArtifact
                ? "这次构建已经生成过成品。想看过程可以点「重新生成」，或在下面切到「预览」直接看结果。"
                : "点右上角「开始生成」，这里会实时显示模型写的内容。"}
          </span>
        )}
      </pre>
    </div>
  );
}