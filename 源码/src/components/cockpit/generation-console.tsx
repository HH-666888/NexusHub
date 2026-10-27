"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GenerateEvent, GeneratePhase } from "@/core/generate/service";
import type { CheckResult } from "@/core/domain/check";
import { toStepBlocks, type StepBlock } from "@/core/planning/step-blocks";
import { ProcessBlocks } from "./process-blocks";
import { RunTimeline } from "./run-timeline";

/**
 * 实时生成控制台：连 SSE，把模型的输出、成本、检查结果摊开在用户面前。
 *
 * 收到 done / failed 后主动关连接：EventSource 在服务端正常关闭后会自动重连，
 * 不关就成了「生成完 → 重连 → 服务端说已有成品 → 关闭」的死循环。
 * 流式内容按帧批量写 state：一次生成推来三千多个片段，逐块 setState 是三千多次渲染。
 */

/*
  两张表都是 Record<GeneratePhase, …>，穷尽的：新增阶段会在编译期报错，
  逼着当场给它一个名字和一种颜色。写成 Partial 的话，新阶段会静默变成无字徽章。
*/
const PHASE_LABEL: Record<GeneratePhase, string> = {
  spec: "需求规格化",
  arch: "架构定型",
  ui: "界面设计",
  // 并行构建与装配分开：这一段是 N 个模块同时写，下一段才拼成成品
  building: "并行构建",
  awaiting: "等你确认",
  generating: "正在生成",
  checking: "正在检查",
  saving: "正在保存",
  done: "已完成",
  failed: "未通过",
};

const PHASE_TONE: Record<GeneratePhase, string> = {
  spec: "border-violet-700 bg-violet-950/40 text-violet-300",
  // 与规格化同色调：两者都是 AI 在写决策级产物，色调分的是「谁在做」不是序号
  arch: "border-violet-700 bg-violet-950/40 text-violet-300",
  // 同为决策级：这里定的变量表是第四段所有并行单元的共同口径
  ui: "border-violet-700 bg-violet-950/40 text-violet-300",
  // 并行构建是执行级（真的在写码），与 generating 同色调
  building: "border-blue-700 bg-blue-950/40 text-blue-300",
  awaiting: "border-amber-700 bg-amber-950/40 text-amber-300",
  generating: "border-blue-700 bg-blue-950/40 text-blue-300",
  checking: "border-blue-700 bg-blue-950/40 text-blue-300",
  saving: "border-blue-700 bg-blue-950/40 text-blue-300",
  done: "border-green-700 bg-green-950/40 text-green-300",
  failed: "border-amber-700 bg-amber-950/40 text-amber-300",
};

/**
 * 实时事件的号段。切块靠 seq 认身份（id 就是 `step-<起始 seq>`），
 * 而实时事件还没落库、没有 seq，所以给它们一段明显在真实号段之外的号 ——
 * 两边切出来的块 id 永远不会撞，刷新回来之后由真实块整批替换。
 */
const LIVE_SEQ_BASE = 1_000_000;

export function GenerationConsole({
  runId,
  hasArtifact,
  onSettled,
  blocks,
  currentBlockId,
}: {
  runId: string;
  /** 已经产出过成品时不自动开始，让用户自己决定要不要重跑 */
  hasArtifact: boolean;
  /** 生成结束时通知外层刷新数据 */
  onSettled: () => void;
  /**
   * 已落库、由服务端切好的步骤块。不传 = 这个上下文没接事件通道，
   * 这一栏退回一整条连续日志（退役的 /studio 就是这么用的）。
   */
  blocks?: StepBlock[];
  /** 服务端认定的"当前这一步"（/canvas 传的是最后一个块） */
  currentBlockId?: string | null;
}) {
  const [running, setRunning] = useState(false);
  /*
    每跑完一次加一，让时间轴重新拉事件 —— 刚跑完那一刻事件才写进库，
    不重新拉的话时间轴还是空的，用户会以为「录像没录上」。
  */
  const [refreshKey, setRefreshKey] = useState(0);
  /*
    规格化阶段的产出。用户要看的是「它把我的需求理解成了什么」，
    而不是「规格已就绪」。
  */
  const [spec, setSpec] = useState<{
    goal: string;
    audience: string;
    acceptance: Array<{ id: string; statement: string; verifyBy: string; level: string }>;
    outOfScope: string[];
    questions: string[];
    fallback: boolean;
  } | null>(null);

  const [draft, setDraft] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  /** 「知悉并继续」提交中 */
  const [acknowledging, setAcknowledging] = useState(false);
  const [gateMsg, setGateMsg] = useState<string | null>(null);

  /**
   * 刷新之后把门禁补回来。spec 原来只由实时 SSE 填：用户一刷新、
   * 或从列表点进那条停在门禁上的运行，就只剩下「有 3 个疑问待确认」的提示，
   * 没有任何地方能回答。
   *
   * /gate 给的是「现在到底还差哪几条」，与 decideGate 同源，所以答过的不再问第二遍。
   * 只在还没拿到规格时补（s ?? …），正在实时跑的时候不许被这次请求覆盖。
   */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/runs/${runId}/gate`);
        if (!res.ok) return;
        const json = (await res.json()) as {
          hasSpec?: boolean;
          spec?: {
            goal: string;
            audience: string;
            acceptance: Array<{ id: string; statement: string; verifyBy: string; level: string }>;
            outOfScope: string[];
            questions: string[];
          } | null;
          gate?: { pending: string[]; fallback: boolean; reason: string } | null;
        };
        if (cancelled || !json.hasSpec || !json.spec) return;
        const pending = json.gate?.pending ?? [];
        setSpec((s) =>
          s ?? {
            goal: json.spec!.goal,
            audience: json.spec!.audience,
            acceptance: json.spec!.acceptance,
            outOfScope: json.spec!.outOfScope,
            // 只放"还没答的"：答过的再问一遍，用户会以为自己没提交成功
            questions: pending,
            fallback: json.gate?.fallback ?? false,
          },
        );
        if (pending.length > 0 && json.gate?.reason) setGateMsg(json.gate.reason);
      } catch {
        // 补不回来也不该让界面崩：只是没有表单而已，正文与日志照常
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runId]);

  /**
   * 提交回答。revise = 是否同时要求按这些回答重出一版规格。
   * revise 必须显式传：它原来直挂 onClick，而 onClick 会把点击事件当第一个参数（对象 → 真值），
   * 那样每个用户都会顺手多花一次模型调用。
   */
  const submitAnswers = useCallback(
    async (revise: boolean) => {
      if (!spec || submitting) return;
      setSubmitting(true);
      setGateMsg(null);
      try {
        const res = await fetch(`/api/runs/${runId}/answers`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            answers: spec.questions.map((q) => ({ question: q, answer: draft[q] ?? "" })),
            revise,
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
        parts.push(
          revise
            ? "现在点「开始生成」—— 它会带着你的回答重出一版规格（这一趟多花一次调用）"
            : "现在点「开始生成」继续",
        );
        setGateMsg(parts.join(" · "));
      } catch (e) {
        setGateMsg(e instanceof Error ? e.message : String(e));
      } finally {
        setSubmitting(false);
      }
    },
    [spec, submitting, runId, draft],
  );

  /**
   * 「知悉并继续」：我看了这些问题，但不回答 —— 这次你替我决定。
   * 与「留空提交」的区别是它不要求逐条看完，问题一多那更像在收集噪声。
   * 代价必须写在按钮旁边：模型会替他猜，猜错了要到验收那一步才暴露。
   */
  const acknowledge = useCallback(async () => {
    if (!spec || submitting || acknowledging) return;
    setAcknowledging(true);
    setGateMsg(null);
    try {
      const res = await fetch(`/api/runs/${runId}/acknowledge`, { method: "POST" });
      const json = (await res.json()) as { ok?: boolean; error?: string; acknowledged?: number };
      if (!res.ok || !json.ok) {
        setGateMsg(json.error ?? `提交失败（HTTP ${res.status}）`);
        return;
      }
      setSpec((s) => (s ? { ...s, questions: [] } : s));
      setGateMsg(
        `已知悉 ${json.acknowledged ?? 0} 条没答的疑问 —— 现在点「开始生成」继续，模型会替你决定`,
      );
    } catch (e) {
      setGateMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setAcknowledging(false);
    }
  }, [spec, submitting, acknowledging, runId]);
  const [phase, setPhase] = useState<GeneratePhase | null>(null);
  const [phaseLabel, setPhaseLabel] = useState("");
  /**
   * 回流（07）那句提示，单独留一份：phaseLabel 会被后面一串 phase 事件顶掉，
   * 而「这一次带上了上一轮的问题」需要留在界面上。空串表示这一轮没有回流。
   */
  const [callbackNote, setCallbackNote] = useState("");
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

  /*
    运行中实时攒出来的步骤块。服务端那份 blocks 是已落库事件切的，生成过程中静止，
    而「看着它一步步往下走」正是这一栏存在的理由 ——
    所以运行期间另攒一份，喂给同一个切块函数，实时与落库后是同一套规则。

    服务端那份 blocks 换成新的一份（说明这一轮已落库、页面刷新过）时，实时块退场，
    否则同一批事件会显示两遍。判据用数组身份而不是长度：长度可能碰巧相等。
  */
  const [liveBlocks, setLiveBlocks] = useState<StepBlock[]>([]);
  const [blocksAtStart, setBlocksAtStart] = useState<StepBlock[] | null>(null);
  const liveEventsRef = useRef<{ seq: number; payload: GenerateEvent }[]>([]);
  const liveSeqRef = useRef(0);

  /* 按帧合并流式片段 */
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
    /*
      步骤块和正文同一个节拍重算。一次生成推来三千多个片段，
      逐条重算就是三千多次渲染，合并到每帧一次只剩几十次。
    */
    if (liveEventsRef.current.length > 0) {
      setLiveBlocks(toStepBlocks(liveEventsRef.current));
    }
  }, []);

  const scheduleFlush = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(flush);
  }, [flush]);

  /* 关闭连接并清理 */
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

  /* 计时器 */
  useEffect(() => {
    if (!running || startedAt === null) return;
    const timer = setInterval(() => setElapsed(Date.now() - startedAt), 200);
    return () => clearInterval(timer);
  }, [running, startedAt]);

  /* 自动滚到底 */
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [text, reasoning, showReasoning]);

  /* 发起生成 */
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
    setCallbackNote("");
    setError(null);
    setStartedAt(Date.now());
    setElapsed(0);
    pendingRef.current = { text: "", reasoning: "" };
    /*
      实时块从零开始，服务端那份 blocks 原样留着并排在前面 ——
      于是「旧的留在上方、新的追加在下方」在重新生成时同样成立。
    */
    liveEventsRef.current = [];
    liveSeqRef.current = 0;
    setLiveBlocks([]);
    setBlocksAtStart(blocks ?? null);

    const es = new EventSource(`/api/runs/${runId}/generate`);
    sourceRef.current = es;

    es.onmessage = (msg) => {
      let event: GenerateEvent;
      try {
        event = JSON.parse(msg.data) as GenerateEvent;
      } catch {
        return; // 半截数据直接跳过，不因为一行坏掉中断整条流
      }

      /*
        每条事件都进实时缓冲，正文与思考的片段也进：切块要看的是
        「这一步里所有 delta 按顺序拼起来是什么」。界面要的是逐字的实时感，不在这里合并。
      */
      liveEventsRef.current.push({
        seq: LIVE_SEQ_BASE + liveSeqRef.current++,
        payload: event,
      });
      scheduleFlush();

      switch (event.kind) {
        case "phase":
          setPhase(event.phase);
          /*
            回流（07）单独留一份：phaseLabel 会被后面一串 phase 事件顶掉，
            而「回流真的发生了」这件事需要留在固定的地方。
          */
          if (event.note === "callback") setCallbackNote(event.label);
          else setPhaseLabel(event.label);
          /*
            这里没有把 awaiting 当成结束：门禁停下时流确实结束了，
            但用户接下来要做的是回答问题 —— 所以不触发 onSettled（那会去刷新运行列表）。
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
            用量事件两个阶段都会发，花费要累加而不是覆盖 ——
            覆盖的话界面上的数字会从规格那笔变成生成那笔，总额永远少一截。
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
  }, [runId, stop, scheduleFlush, onSettled, phase, blocks]);

  /* 渲染 */
  const passed = checks?.filter((c) => c.pass).length ?? 0;
  const total = checks?.length ?? 0;
  const activeText = showReasoning ? reasoning : text;

  /*
    实时块只有服务端那份 blocks 一动不动时才算数；
    它一变（页面带着新数据刷新回来），实时块退场，理由见上面 liveBlocks 那段。
  */
  const liveVisible =
    blocks !== undefined && blocksAtStart !== null && blocksAtStart === blocks;

  /**
   * 真正摆到界面上的块列表：服务端那份（旧的，在上）+ 运行中实时攒的（新的，追加在下）。
   * 只追加、不重排、不清空 —— 老块 id 不变，React 保留同一个 DOM 节点。
   */
  const shownBlocks = useMemo<StepBlock[] | null>(() => {
    if (blocks === undefined) return null; // 通道没接：退回一条连续日志
    if (!liveVisible || liveBlocks.length === 0) return blocks;
    return [...blocks, ...liveBlocks];
  }, [blocks, liveVisible, liveBlocks]);

  /** 右侧面板该显示哪一块：运行中就是最后那个实时块，否则听服务端的 */
  const activeBlockId =
    liveVisible && liveBlocks.length > 0
      ? liveBlocks[liveBlocks.length - 1].id
      : (currentBlockId ?? null);

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

        {/*
          回流（07）的痕迹。放在状态排里而不是跟着 phase 文案一闪而过 ——
          「这一次带上了上一轮的问题」需要事后也看得到。
        */}
        {callbackNote && (
          <span
            data-callback-note
            title="上一轮没过的地方已经作为上下文喂给了模型"
            className="rounded border border-cyan-800/60 bg-cyan-950/30 px-1.5 py-px text-[10px] text-cyan-300/90"
          >
            ↻ {callbackNote}
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

      {/* 规格：用户要看的是「它把我的需求理解成了什么」，
          理解错了要在这里就发现，而不是等成品出来 */}
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
              人工门禁：全流程唯一需要人的地方。疑问做成可填写的表单，
              只提示一句「有 2 个问题」而不给回答的地方，等于把人拦在门口又不给开门。
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
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => void submitAnswers(false)}
                  disabled={submitting || acknowledging}
                  className="rounded border border-amber-700 bg-amber-900/40 px-2.5 py-1 text-[10.5px] text-amber-200 transition-colors duration-150 hover:bg-amber-900/60 disabled:opacity-50"
                >
                  {submitting ? "提交中…" : "提交回答"}
                </button>
                {/*
                  「按我的回答重出一版规格」：回答不只是确认，而是真的改进规格。
                  它多花一次规格化的钱，所以单独一个按钮并写明代价，绝不默认勾选。
                */}
                <button
                  type="button"
                  onClick={() => void submitAnswers(true)}
                  disabled={submitting || acknowledging}
                  title="提交回答，并要求模型据此重出一版规格（会多花一次规格化调用）"
                  className="rounded border border-sky-800 bg-sky-950/40 px-2.5 py-1 text-[10.5px] text-sky-300 transition-colors duration-150 hover:bg-sky-900/50 disabled:opacity-50"
                >
                  提交回答并按回答重出规格
                </button>
                {/*
                  「知悉并继续」与「提交回答」并列：它们是同一个决定的两个方向，
                  要么我把疑问答清楚，要么我认了让你替我猜。
                */}
                <button
                  type="button"
                  onClick={acknowledge}
                  disabled={submitting || acknowledging}
                  title="我看过这些问题了，但不回答 —— 这次由模型替我决定"
                  className="rounded border border-slate-600 bg-slate-800/40 px-2.5 py-1 text-[10.5px] text-slate-300 transition-colors duration-150 hover:bg-slate-700/50 disabled:opacity-50"
                >
                  {acknowledging ? "提交中…" : "知悉并继续（由模型替我决定）"}
                </button>
                <span className="text-[10px] text-amber-200/60">
                  留空也算提交 —— 那是「你替我决定」，不是没看到
                </span>
              </div>
              <div className="mt-1 text-[10px] text-slate-400/80">
                「知悉并继续」的代价：模型会替你猜这些没答的地方，猜错了要到
                <span className="text-slate-300">验收那一步</span>才看得出来 —— 那时钱已经花完了。
                <br />
                「按回答重出规格」的代价：多花一次规格化调用（约 ¥0.01 上下），
                换来的是回答真的改进规格，而不只是被记下来当确认。
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

      {/* 流式内容。接上了事件通道（有 blocks）就按步骤块显示：一步一块、旧的在上、
          新的追加在下；没接（退役的 /studio）退回一条连续日志，两条路实时性一样 */}
      {shownBlocks ? (
        <ProcessBlocks
          blocks={shownBlocks}
          currentBlockId={activeBlockId}
          prefer={showReasoning ? "reasoning" : "text"}
          running={running}
          className="flex-1"
        />
      ) : (
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
      )}

      {/*
        时间轴回放，放在实时日志下面：上面是正在发生，下面是已经发生过、可以来回拖。
        只有真正调用过模型的那一次生成才有录像，重新生成之前这里是空的。
      */}
      <div className="border-t border-[var(--color-border-soft)] px-4 py-2.5">
        <RunTimeline runId={runId} refreshKey={refreshKey} />
      </div>
    </div>
  );
}