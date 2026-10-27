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
 * 右侧「这一步的内容」面板
 * ============================================================
 * 这一栏以前是**占位**（虚线框 + 「尚未接入」）。现在它接的是**真实事件**：
 * 上面那一步模型想了什么、写了什么、检查过了几项、花了多少钱，
 * 全部来自落库的 `RunEvent`，经 core/planning/step-blocks.ts 切成块之后传进来。
 *
 * ── ★ 想了什么和写了什么是**两件事**，不许互相冒充 ★ ──
 *   两个页签：「思考」= reasoning 的 delta，「结果」= text 的 delta + 检查 + 花费。
 *   它们来自事件流里两种**不同**的 kind，不是同一段文字的两种排版。
 *
 *   所以「思考」为空时**必须明说**「这一步没有返回思考内容」：
 *     · 留白 → 用户分不清"没有思考"和"还没加载出来"
 *     · 拿正文顶上 → 那是把生成结果说成模型的思考过程，属于编造。
 *       这个产品最不能碰的就是这条线：用户是拿"思考"去判断它靠不靠谱的。
 *   实测这类任务很多步就是不返回 reasoning（思考被关掉更快也更完整，
 *   见 generation-console 的用量明细），所以"没有"是**常态**，更要说清楚。
 *
 * ── ★ 花费与 token 一个都不估算 ★ ──
 *   只显示 `usage` 事件里真实带回来的数（`block.usage`）。
 *   没收到过 usage 事件时这一块**整段不显示** —— 不是显示 0：
 *   「没花钱」和「还不知道花了多少」是两件事，0 会被读成前者。
 *
 * ── 为什么是客户端组件 ──
 *   两个页签要能点。它是 `"use client"` 之后，props 仍然只是
 *   可序列化的纯数据（StepBlock 数组），所以服务端算好的块可以直接传进来，
 *   切换页签不会重新向服务端要一遍数据。
 *
 * ── ★ 默认停在哪一块，以及为什么那不是"挑好看的说" ★ ──
 *   服务端默认选的**不是最后一块**，而是最后一个**有内容**的块
 *   （pickCurrentBlockId，core/planning/step-blocks.ts）。理由：
 *   一次跑完的运行，最后一块常常是收尾的 phase:"done"（label 类似"完成"），
 *   它没有任何输出 —— 面板一打开就写"这一步没有返回思考内容 / 没有返回正文"，
 *   诚实，但把整条运行读起来像"什么都没做"。
 *
 *   这样仍然诚实，靠的是两条，缺一不可：
 *     · 显示的是**真实某一步的真实内容** —— 不编、不合并、不挑好看的；
 *     · 面板标题写明"第 N 步 / 共 M 步"，而且选中块不是最后一块时**明说**
 *       "后面还有 N 步没有输出"（`data-step-not-last`）。
 *   少了第二条，往前选就是**用排版掩盖事实**。
 *
 * ── 空态说的是实话 ──
 *   `blocks` 为空 = 这次运行**还没有产生任何过程事件**（还没开跑，
 *   或者压根没选中运行）。不写"加载中"，也不留白。
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
    默认停在「思考」：用户点开这一步，第一个想知道的是"它怎么想的"，
    而不是"它写了什么"（写了什么下面「生成过程」那一栏正在实时滚）。
    切页签、切步骤都**不清空**用户的选择。
  */
  const [tab, setTab] = useState<"reasoning" | "result">("reasoning");

  const index = currentBlockId === null ? -1 : blocks.findIndex((b) => b.id === currentBlockId);
  /*
    currentBlockId 没给、或者指的块不在列表里时，退回**最后一块**：
    它是"这一步走到哪了"的答案，而不是随便挑一块。
    （服务端和这里用的是同一份 blocks，正常情况下不会走到这一支。）
  */
  const position = index >= 0 ? index : blocks.length > 0 ? blocks.length - 1 : -1;
  const block = position >= 0 ? blocks[position] : null;

  /*
    ---------- ★ 当前显示的不是最后一步时，必须**明说** ★ ----------
    服务端默认选的已经不再是"最后一块"，而是"最后一个**有内容**的块"
    （pickCurrentBlockId，理由写在 core/planning/step-blocks.ts 里）。
    那个选择本身是诚实的 —— 显示的就是真实某一步的真实内容；
    但它有一个副作用：用户会以为"面板上这块就是最后一步"。
    （收尾的 phase:"done" 没有任何输出，一次跑完的运行里它往往是最后一块。）

    所以这里补一句小字：后面还剩几块、它们没有输出。
    少了它，往前选就等于**用排版掩盖事实** —— 那不是这次要的东西。

    ⚠️ "没有输出"这句话必须真的成立才算数：
       正常情况下（服务端选了最后一个有内容的块）后面那些块**必然**都没有内容，
       于是走上面那一支。理论上够不到的第二支留着，是为了让这句话
       在任何调用方手里都不会变成假话 —— 判据是 blockHasContent()，
       和选块用的是**同一个**函数，不另写一套"看起来差不多"的判断。
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
            空态。⚠️ 这里**不写**「尚未接入」—— 通道已经接上了，
            现在为空是"这次运行还没有过程事件"，是两件不同的事。
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

/* ============================================================
   思考
   ============================================================ */

function ReasoningBody({ block }: { block: StepBlock }) {
  if (block.reasoning.trim().length === 0) {
    /*
      ★ 没有思考就明说没有 ★
      不许留白，更不许拿正文顶上 —— 正文在「结果」那一页，
      这里只回答"这一步想了什么"，答案是：什么都没返回。
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

/* ============================================================
   结果
   ============================================================ */

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
        ★ 花费与 token 只来自真实 usage 事件 ★
        没有 usage 事件时这一整段不渲染（不是显示 0，也不是估算）。
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