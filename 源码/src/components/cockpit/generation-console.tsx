"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { GenerateEvent, GeneratePhase } from "@/core/generate/service";
import type { CheckResult } from "@/core/domain/check";
import { RunTimeline } from "./run-timeline";

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
  spec: "需求规格化",
  awaiting: "等你确认",
  generating: "正在生成",
  checking: "正在检查",
  saving: "正在保存",
  done: "已完成",
  failed: "未通过",
};

const PHASE_TONE: Record<GeneratePhase, string> = {
  spec: "border-violet-700 bg-violet-950/40 text-violet-300",
  awaiting: "border-amber-700 bg-amber-950/40 text-amber-300",
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
  /*
    每跑完一次生成就加一，用来让时间轴重新拉取事件。
    刚跑完那一刻事件才写进库，不重新拉的话时间轴还是空的 ——
    用户会以为「录像没录上」，其实只是没去取。
  */
  const [refreshKey, setRefreshKey] = useState(0);
  /*
    规格化阶段的产出。它是这一阶段唯一值得展示的东西 ——
    用户要看的是「它把我的需求理解成了什么」，而不是「规格已就绪」。
  */
  const [spec, setSpec] = useState<{
    goal: string;
    audience: string;
    acceptance: Array<{ id: string; statement: string; verifyBy: string; level: string }>;
    outOfScope: string[];
    questions: string[];
    fallback: boolean;
  } | null>(null);

  /* ---------- 人工门禁的交互状态 ---------- */
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [gateMsg, setGateMsg] = useState<string | null>(null);

  /** 提交回答。成功后把问题从本地列表里去掉 —— 界面据此收起表单 */
  const submitAnswers = useCallback(async () => {
    if (!spec || submitting) return;
    setSubmitting(true);
    setGateMsg(null);
    try {
      const res = await fetch(`/api/runs/${runId}/answers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          answers: spec.questions.map((q) => ({ question: q, answer: draft[q] ?? "" })),
        }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        answered?: number;
        blank?: number;
        issues?: string[];
      };
      if (!res.ok || !json.ok) {
        setGateMsg(json.error ?? `提交失败（HTTP ${res.status}）`);
        return;
      }
      setSpec((s) => (s ? { ...s, questions: [] } : s));
      const parts = [`已提交 ${json.answered ?? 0} 条回答`];
      if (json.blank) parts.push(`其中 ${json.blank} 条留空（表示由你决定）`);
      if (json.issues?.length) parts.push(json.issues.join("；"));
      parts.push("现在点「开始生成」继续");
      setGateMsg(parts.join(" · "));
    } catch (e) {
      setGateMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }, [spec, submitting, runId, draft]);
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
    // 让时间轴重新拉一次事件：刚跑完这一刻事件才落库
    setRefreshKey((k) => k + 1);
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
          /*
            注意这里**没有**把 awaiting 也当成结束。
            门禁停下时流确实结束了，但用户接下来要做的是回答问题、
            不是看结果 —— 所以不触发 onSettled（那会去刷新运行列表），
            让界面停在「等你确认」这个状态上。
          */
          if (event.phase === "done" || event.phase === "failed") {
            stop();
            onSettled();
          } else if (event.phase === "awaiting") {
            stop();
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
          /*
            用量事件两个阶段都会发（规格化一次、生成一次）。
            花费要**累加**而不是覆盖 —— 覆盖的话，
            界面上的数字会从规格那笔变成生成那笔，总额永远少一截。
          */
          setCost((c) => (c ?? 0) + event.costCny);
          setLatency((l) => (l ?? 0) + event.latencyMs);
          setUsage((u) => ({
            in: (u?.in ?? 0) + event.usage.inputTokens,
            out: (u?.out ?? 0) + event.usage.outputTokens,
            think: (u?.think ?? 0) + event.usage.reasoningTokens,
          }));
          break;

        case "spec":
          setSpec({
            goal: event.spec.goal,
            audience: event.spec.audience,
            acceptance: event.spec.acceptance,
            outOfScope: event.spec.scope.outOfScope,
            questions: event.spec.questions,
            fallback: event.fallback,
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

      {/* 规格
          这是规格化阶段唯一值得展示的东西。用户要看的不是「规格已就绪」，
          而是「它到底把我的需求理解成了什么」——
          理解错了要在这里就能发现，而不是等成品出来才发现。 */}
      {spec && (
        <div className="border-b border-[var(--color-border-soft)] bg-violet-950/15 px-4 py-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded border border-violet-700/60 bg-violet-950/40 px-1.5 py-px text-[9.5px] text-violet-300">
              规格
            </span>
            <span className="text-[12px] text-slate-200">{spec.goal || "（没有给出目标）"}</span>
            {spec.fallback && (
              // 兜底必须显著标出来，否则用户会把通用硬检查当成针对自己需求的验收标准
              <span className="rounded border border-amber-700/60 bg-amber-950/40 px-1.5 py-px text-[9.5px] text-amber-300">
                兜底规格 · 模型没能给出可用规格
              </span>
            )}
          </div>

          {spec.audience && (
            <div className="mt-1 text-[11px] text-slate-500">
              给谁用：<span className="text-slate-400">{spec.audience}</span>
            </div>
          )}

          {spec.acceptance.length > 0 && (
            <div className="mt-2">
              <div className="text-[10.5px] text-slate-500">
                验收标准 {spec.acceptance.length} 条
                {spec.acceptance.some((a) => a.level === "must") && (
                  <>
                    {" "}
                    · 其中{" "}
                    <span className="text-slate-400">
                      {spec.acceptance.filter((a) => a.level === "must").length} 条必需
                    </span>
                  </>
                )}
              </div>
              <ul className="scroll-hint mt-1 max-h-28 overflow-y-auto">
                {spec.acceptance.map((a) => (
                  <li key={a.id} className="py-0.5 text-[10.5px] leading-relaxed">
                    <span
                      className={
                        a.level === "must"
                          ? "text-violet-400"
                          : "text-slate-600"
                      }
                    >
                      {a.level === "must" ? "必需" : "期望"}
                    </span>
                    <span className="ml-1.5 text-slate-300">{a.statement}</span>
                    <span className="ml-1.5 text-slate-600">— {a.verifyBy}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {spec.outOfScope.length > 0 && (
            <div className="mt-1.5 text-[10.5px] text-slate-500">
              明确不做：<span className="text-slate-400">{spec.outOfScope.join("、")}</span>
            </div>
          )}

          {spec.questions.length > 0 ? (
            /*
              人工门禁：这是全流程唯一需要人的地方。
              疑问做成可填写的表单，而不是只提示一句「有 2 个问题」——
              提示了却没有地方回答，等于把人拦在门口又不给开门。
            */
            <div className="mt-2 rounded border border-amber-900/50 bg-amber-950/25 px-2.5 py-2">
              <div className="text-[10.5px] text-amber-300">
                这些事模型没法替你决定 —— 回答之后才能继续
              </div>
              <ul className="mt-1.5 space-y-1.5">
                {spec.questions.map((q) => (
                  <li key={q}>
                    <div className="text-[10.5px] leading-relaxed text-amber-200/90">{q}</div>
                    <input
                      type="text"
                      value={draft[q] ?? ""}
                      onChange={(e) =>
                        setDraft((d) => ({ ...d, [q]: e.target.value }))
                      }
                      placeholder="留空表示由你决定"
                      className="mt-1 w-full rounded border border-amber-900/60 bg-[var(--color-surface)] px-2 py-1 text-[11px] text-slate-200 outline-none focus:border-amber-600"
                    />
                  </li>
                ))}
              </ul>
              <div className="mt-2 flex items-center gap-3">
                <button
                  type="button"
                  onClick={submitAnswers}
                  disabled={submitting}
                  className="rounded border border-amber-700 bg-amber-900/40 px-2.5 py-1 text-[10.5px] text-amber-200 transition-colors duration-150 hover:bg-amber-900/60 disabled:opacity-50"
                >
                  {submitting ? "提交中…" : "提交回答"}
                </button>
                <span className="text-[10px] text-amber-200/60">
                  留空也算提交 —— 那是「你替我决定」，不是没看到
                </span>
              </div>
              {gateMsg && (
                <div className="mt-1.5 text-[10.5px] text-emerald-400">{gateMsg}</div>
              )}
            </div>
          ) : (
            gateMsg && (
              <div className="mt-2 rounded border border-emerald-900/50 bg-emerald-950/25 px-2.5 py-1.5 text-[10.5px] text-emerald-300">
                {gateMsg}
              </div>
            )
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

      {/*
        时间轴回放。放在实时日志下面，因为它是同一件事的「事后」形态：
        上面是正在发生，下面是已经发生过、可以来回拖。
        只有真正调用过模型的那一次生成才会有录像，
        重新生成之前这里是空的 —— 空的时候会说明原因，不留一块白。
      */}
      <div className="border-t border-[var(--color-border-soft)] px-4 py-2.5">
        <RunTimeline runId={runId} refreshKey={refreshKey} />
      </div>
    </div>
  );
}