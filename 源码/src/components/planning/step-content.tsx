"use client";

import { useState } from "react";
import { blockHasContent, type StepBlock } from "@/core/planning/step-blocks";

/** 语气色：error 红 / ok 绿 / normal 中性（和下面「生成过程」的块头同一套值） */
const TONE_COLOR: Record<StepBlock["tone"], string> = {
  normal: "rgb(148, 163, 184)",
  ok: "rgb(74, 222, 128)",
  error: "rgb(248, 113, 113)",
};

/** 检查项的两个色值。和画布、清单用的是同一套状态色 */
const PASS_COLOR = "rgb(74, 222, 128)";
const FAIL_COLOR = "rgb(248, 113, 113)";

/**
 * 右侧「这一步的内容」面板。数据显示真实事件：上面那一步模型想了什么、写了什么、
 * 检查过几项、花了多少钱，全部来自落库的 RunEvent，经 step-blocks.ts 切块后传进来。
 *
 * 思考与结果是两件事：两个页签分别是 reasoning 与 text 的 delta，来自不同的 kind。
 * 「思考」为空时必须明说，既不能留白也不能拿正文顶上 —— 用户是拿思考判断它靠不靠谱的。
 * 花费只显示 usage 事件真实带回来的数，没收到过就整段不显示（0 会被读成「没花钱」）。
 *
 * 默认停的块是最后一个有内容的块，不是最后一块：收尾的 done 没有任何输出。
 * 往前选仍然诚实，靠的是标题写明第几步、并在后面还有块时明说它们没有输出。
 */
export function StepContent({
  blocks,
  currentBlockId,
}: {
  /** 服务端按真实事件切好的步骤块 */
  blocks: StepBlock[];
  /** 当前该显示哪一块。口径见 /canvas 上那段注释 */
  currentBlockId: string | null;
}) {
  /*
    默认停在「思考」：用户点开这一步，第一个想知道的是它怎么想的，
    而「生成过程」那一栏正在实时滚正文。切页签、切步骤都不清空用户的选择。
  */
  const [tab, setTab] = useState<"reasoning" | "result">("reasoning");

  const index = currentBlockId === null ? -1 : blocks.findIndex((b) => b.id === currentBlockId);
  /*
    currentBlockId 没给、或者指的块不在列表里时退回最后一块：
    它是「这一步走到哪了」的答案，而不是随便挑一块。
  */
  const position = index >= 0 ? index : blocks.length > 0 ? blocks.length - 1 : -1;
  const block = position >= 0 ? blocks[position] : null;

  /*
    当前显示的不是最后一步时必须明说：服务端选的是最后一个有内容的块，
    用户会以为面板上这块就是最后一步，所以补一句后面还剩几块、它们没有输出。
    判据用 blockHasContent()，和选块用的是同一个函数。
  */
  const laterBlocks = position >= 0 ? blocks.slice(position + 1) : [];
  const laterSilent = laterBlocks.filter((b) => !blockHasContent(b)).length;
  const notLast = laterBlocks.length > 0;

  return (
    <aside
      data-step-content
      /* 和左侧清单同一套理由：固定宽度 + shrink-0（宽度随窗口变会让代码块反复折行） */
      className="flex h-full min-h-0 w-[22rem] shrink-0 flex-col border-l border-[var(--color-border-soft)] bg-[var(--color-surface)]"
    >
      <header className="flex-none border-b border-[var(--color-border-soft)] px-3.5 py-3">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-[12.5px] font-semibold text-[var(--ink-1)]">这一步的内容</h2>
          {block && (
            /*
              第几步 / 共几步：这两个数都来自**真实切出来的块**。
              只有一个孤零零的标题时，用户不知道这条运行一共走了几步。
            */
            <span data-step-position className="text-[10.5px] text-[var(--ink-5)] tabular-nums">
              第 {position + 1} 步 / 共 {blocks.length} 步
            </span>
          )}
        </div>
        {block ? (
          <p
            data-step-title
            className="mt-1 text-[11px] leading-relaxed"
            /* 语气色和下面「生成过程」的块头是同一套：error 红 / ok 绿 / normal 中性 */
            style={{ color: TONE_COLOR[block.tone] }}
          >
            {block.title}
          </p>
        ) : (
          <p className="mt-1 text-[10.5px] leading-relaxed text-[var(--ink-5)]">
            这次运行还没有产生任何过程事件
          </p>
        )}
        {/*
          小字、贴着标题：见上面那段说明。
          `data-step-not-last` 是给界面之外的读者（端到端）用的把手 ——
          "这一栏不是最后一步"必须能被**明确读到**，而不是只能靠人去比对标题。
        */}
        {block && notLast && (
          <p
            data-step-not-last
            data-step-not-last-count={laterBlocks.length}
            className="mt-1 text-[10.5px] leading-relaxed text-[var(--ink-4)]"
          >
            {laterSilent === laterBlocks.length
              ? `后面还有 ${laterBlocks.length} 步没有输出 —— 这里停在最后一个有内容的步骤`
              : `后面还有 ${laterBlocks.length} 步 —— 这一步不是最后一步`}
          </p>
        )}
      </header>

      {block && (
        <div
          role="tablist"
          className="flex flex-none items-center gap-1 border-b border-[var(--color-border-soft)] px-2.5 py-1.5"
        >
          {(
            [
              ["reasoning", "思考"],
              ["result", "结果"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              data-step-tab={key}
              /*
                选中态用一个**属性**表达（不只是类名）：
                颜色可以随主题漂，而"现在选的是哪一个"必须能被明确读到。
              */
              {...(tab === key ? { "data-step-tab-active": "" } : {})}
              onClick={() => setTab(key)}
              className={`rounded-md px-2.5 py-1 text-[11px] transition-colors duration-150 ${
                tab === key
                  ? "bg-slate-700/60 text-slate-100"
                  : "text-slate-500 hover:text-slate-300"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      <div
        data-step-body
        className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3 font-mono text-[11px] leading-relaxed"
      >
        {!block ? (
          /*
            空态不写「尚未接入」—— 通道已经接上了，现在为空是「这次运行还没有过程事件」。
            也不放示例代码、假 token、假耗时：任何像读数的东西都不放。
          */
          <div
            data-step-content-placeholder
            className="rounded-xl border border-dashed border-[var(--color-border-soft)] bg-[var(--color-surface-2)] px-3 py-3.5"
          >
            <p className="font-sans text-[11.5px] text-[var(--ink-3)]">
              这次运行还没有产生任何过程事件
            </p>
            <p className="mt-2 font-sans text-[10.5px] leading-relaxed text-[var(--ink-5)]">
              这一栏显示的是真实事件：这一步的思考、正文、检查结果与花费。
              还没开跑（或者这条运行还没选中）的时候，它就该是空的 ——
              空着是实话，填上占位数据才是假话。
            </p>
            <p className="mt-2.5 border-t border-dashed border-[var(--color-border-soft)] pt-2.5 font-sans text-[10.5px] text-[var(--ink-5)]">
              点下面「生成过程」里的「开始生成」，这一步的内容会跟着一起长出来。
            </p>
          </div>
        ) : tab === "reasoning" ? (
          <ReasoningBody block={block} />
        ) : (
          <ResultBody block={block} />
        )}
      </div>
    </aside>
  );
}

/* 思考 */

function ReasoningBody({ block }: { block: StepBlock }) {
  if (block.reasoning.trim().length === 0) {
    /*
      没有思考就明说没有：不许留白，更不许拿正文顶上 ——
      这里只回答「这一步想了什么」，答案是：什么都没返回。
    */
    return (
      <div data-step-reasoning-empty className="font-sans">
        <p className="text-[11.5px] text-[var(--ink-3)]">这一步没有返回思考内容</p>
        <p className="mt-2 text-[10.5px] leading-relaxed text-[var(--ink-5)]">
          事件流里这一步一条 reasoning 片段都没有。这不是加载中，
          也不是面板没接上 —— 很多步骤（尤其关掉思考的那几次调用）就是不返回。
          正文在「结果」那一页，两者不是一回事，这里不拿它顶替。
        </p>
      </div>
    );
  }
  return (
    <pre
      data-step-reasoning
      className="font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-slate-300"
    >
      {block.reasoning}
    </pre>
  );
}

/* 结果 */

function ResultBody({ block }: { block: StepBlock }) {
  const checks = block.checks;
  const passed = checks?.filter((c) => c.pass).length ?? 0;
  const total = checks?.length ?? 0;

  return (
    <div className="flex flex-col gap-3">
      <section>
        <p className="font-sans text-[10.5px] text-[var(--ink-5)]">正文</p>
        {block.text.trim().length === 0 ? (
          <p data-step-text-empty className="mt-1 font-sans text-[11px] text-[var(--ink-4)]">
            这一步没有返回正文
          </p>
        ) : (
          <pre
            data-step-text
            className="mt-1 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-slate-300"
          >
            {block.text}
          </pre>
        )}
      </section>

      {checks && total > 0 && (
        <section data-step-checks>
          <p className="font-sans text-[10.5px] text-[var(--ink-5)]">
            检查 {passed}/{total} 通过
          </p>
          <ul className="mt-1 flex flex-col gap-0.5">
            {checks.map((c, i) => (
              <li
                key={`${c.name}-${i}`}
                data-step-check={c.name}
                data-step-check-pass={c.pass ? "1" : "0"}
                /* 绿=通过、红=没过，直接用状态色的真实值，不靠主题变量 */
                style={{ color: c.pass ? PASS_COLOR : FAIL_COLOR }}
                className="font-sans text-[10.5px] leading-relaxed"
              >
                {c.pass ? "✓" : "✗"} {c.name}
                {c.detail && <span className="text-[var(--ink-5)]"> — {c.detail}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/*
        花费与 token 只来自真实 usage 事件，没有就整段不渲染 ——
        不显示 0，也不估算。
      */}
      {block.usage && (
        <section
          data-step-usage
          data-step-usage-cost={block.usage.costCny}
          data-step-usage-input={block.usage.inputTokens}
          data-step-usage-output={block.usage.outputTokens}
          data-step-usage-reasoning={block.usage.reasoningTokens}
          className="border-t border-[var(--color-border-soft)] pt-2"
        >
          <p className="font-sans text-[10.5px] text-[var(--ink-5)]">
            这一步的花费（来自真实 usage 事件）
          </p>
          <p className="mt-1 font-sans text-[11px] text-[var(--ink-3)] tabular-nums">
            ¥{block.usage.costCny.toFixed(4)} · 输入 {block.usage.inputTokens} · 输出{" "}
            {block.usage.outputTokens} · 其中思考 {block.usage.reasoningTokens}
          </p>
        </section>
      )}
    </div>
  );
}