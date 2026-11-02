"use client";

import { useEffect, useMemo, useRef } from "react";
import type { StepBlock } from "@/core/planning/step-blocks";

/**
 * 生成过程 · 按步骤分块。以前是一整条连续日志，前面发生过什么一路被顶上去、找不回来。
 * 现在一步一块，各带标题、序号和自己的输出。
 *
 * 旧的块留在上方且不销毁，靠三条：key 用块自己的 id（下标会随前面多一条事件漂移，
 * 一漂 React 就重建节点，滚动位置和选中全丢）；列表只追加、不重排、不清空；
 * 滚动只在用户本来就停在底部时才跟着走，否则等于不让人看历史。
 *
 * 摘要只显示前几行并明说一共多少行：一次生成的正文有二十多 KB，
 * 全摊在这里会把其它步骤挤没，而全量在右边那一栏。
 */

/** 摘要里显示前几行 */
const DIGEST_LINES = 3;
/** 摘要里每一行最多留多少字（超了截断并标出来） */
const DIGEST_LINE_CHARS = 160;
/** 离底部多少像素以内算"用户还停在底部" */
const STICK_THRESHOLD_PX = 48;

/** 语气色。和画布、运行切换器用的是同一套值，不另起一套 */
const TONE_COLOR: Record<StepBlock["tone"], string> = {
  normal: "rgb(148, 163, 184)",
  ok: "rgb(74, 222, 128)",
  error: "rgb(248, 113, 113)",
};

const TONE_LABEL: Record<StepBlock["tone"], string> = {
  normal: "进行中",
  ok: "通过",
  error: "有问题",
};

export function ProcessBlocks({
  blocks,
  currentBlockId,
  /** 摘要优先显示哪一路。默认正文；正文为空时退回思考，并标明那是思考 */
  prefer = "text",
  /** 正在跑的时候最后一块是活的，加一点提示 */
  running = false,
  className = "",
}: {
  blocks: StepBlock[];
  currentBlockId: string | null;
  prefer?: "text" | "reasoning";
  running?: boolean;
  className?: string;
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  /** 用户是不是还停在底部。只有这时才自动往下带 —— 见文件开头 */
  const stickRef = useRef(true);

  useEffect(() => {
    const el = boxRef.current;
    if (!el || !stickRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [blocks]);

  const onScroll = () => {
    const el = boxRef.current;
    if (!el) return;
    stickRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD_PX;
  };

  /** 每块的摘要。算一次存下来，别在渲染里边算边拼 */
  const digests = useMemo(
    () => blocks.map((b) => digestOf(b, prefer)),
    [blocks, prefer],
  );

  return (
    <div
      ref={boxRef}
      onScroll={onScroll}
      data-process-blocks
      className={`scroll-hint min-h-0 overflow-auto ${className}`}
    >
      {blocks.length === 0 ? (
        /*
          空态说人话：这次运行还没有产生任何过程事件。
          不说“加载中”（那会永远转下去），也不留白（空白会被读成“跑完了什么都没有”）。
        */
        <p data-process-blocks-empty className="px-4 py-3 text-[11px] text-slate-600">
          这次运行还没有产生任何过程事件。
          {running
            ? "模型刚开工，第一段内容马上就到。"
            : "点“开始生成”，这里会按步骤实时记下每一段。"}
        </p>
      ) : (
        blocks.map((block, i) => {
          const digest = digests[i];
          return (
            <section
              key={block.id}
              data-process-block={block.id}
              data-process-tone={block.tone}
              /*
              “当前块”是给界面和端到端用的把手：它就是右侧面板正在显示的那一步。
              它不一定是最后一块 —— 默认停在最后一个有内容的块，
              收尾的 done 常常是最后一块却没有输出。下面那句“全文在右侧”标的正是这一块。
            */
              data-process-block-current={block.id === currentBlockId ? "1" : undefined}
              /*
              块间横线只加在第二个及以后：第一块上面已经有工作台的标签条了。
              分隔线是“这两块是两件事”的唯一视觉证据。
            */
              className={`px-4 py-2.5 ${
                i > 0 ? "border-t border-[var(--color-border-soft)]" : ""
              }`}
            >
              <header className="flex flex-wrap items-center gap-2">
                <span
                  data-process-block-index
                  className="flex-none rounded border border-[var(--color-border-soft)] px-1.5 py-px text-[10px] text-slate-500 tabular-nums"
                >
                  第 {i + 1} 步
                </span>
                <span
                  data-process-block-title
                  className="text-[11.5px] font-medium"
                  /* 颜色按 tone 走：error 红 / ok 绿 / normal 中性 */
                  style={{ color: TONE_COLOR[block.tone] }}
                >
                  {block.title}
                </span>
                {block.tone !== "normal" && (
                  <span
                    className="text-[10px]"
                    style={{ color: TONE_COLOR[block.tone] }}
                  >
                    {TONE_LABEL[block.tone]}
                  </span>
                )}
                {running && i === blocks.length - 1 && (
                  <span className="text-[10px] text-slate-500">· 正在输出</span>
                )}
              </header>

              {digest ? (
                <>
                  <pre
                    data-process-block-digest
                    className="mt-1.5 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap text-slate-400"
                  >
                    {digest.lines.join("\n")}
                  </pre>
                  <p className="mt-1 text-[10px] text-slate-600">
                    {digest.label}摘要 · 共 {digest.total} 行
                    {digest.total > digest.lines.length
                      ? `，这里只显示前 ${digest.lines.length} 行`
                      : ""}
                    {block.id === currentBlockId ? " · 全文在右侧“这一步的内容”" : ""}
                  </p>
                </>
              ) : (block.traces?.length ?? 0) > 0 ? (
                /*
                  只有执行痕迹、没有正文：全栈模式的"起容器 / 验收"就是这种块。
                  逐行列出，绿=通过、红=失败 —— 别让人去别处找结果。
                */
                <ul data-process-block-traces className="mt-1.5 space-y-0.5">
                  {block.traces!.map((trace, index) => (
                    <li
                      key={`${trace.kind}-${index}`}
                      className="font-mono text-[10.5px] leading-relaxed"
                      style={{ color: trace.ok ? "#6ee7a8" : "#f87171" }}
                    >
                      {trace.kind === "verdict" ? "验收 · " : ""}
                      {trace.text}
                    </li>
                  ))}
                </ul>
              ) : (
                /*
                空块：这一步确实开跑了，只是什么都没输出。
                明说"没有输出"，而不是留一片空白 —— 空白会被读成"界面漏了"。
              */
                <p
                  data-process-block-empty
                  className="mt-1 text-[10.5px] text-slate-600"
                >
                  这一步没有任何输出（只有阶段事件，没有正文、思考或执行痕迹）。
                </p>
              )}
            </section>
          );
        })
      )}
    </div>
  );
}

/**
 * 一块的摘要。prefer 是用户选的那一路，它为空时退回另一路并把标签改成另一路的 ——
 * 拿思考冒充正文是这一版最不能做的事，标签跟着内容走就不会冒充。
 */
function digestOf(
  block: StepBlock,
  prefer: "text" | "reasoning",
): { label: string; lines: string[]; total: number } | null {
  const primary = prefer === "text" ? block.text : block.reasoning;
  const secondary = prefer === "text" ? block.reasoning : block.text;

  const source: "text" | "reasoning" | null =
    primary.trim().length > 0
      ? prefer
      : secondary.trim().length > 0
        ? prefer === "text"
          ? "reasoning"
          : "text"
        : null;
  if (source === null) return null;

  const raw = source === "text" ? block.text : block.reasoning;
  /*
    行数按**去掉末尾那一个换行**之后算：
    模型写的正文常常以 \n 收尾，算成两行会让"共 N 行"多报一行。
  */
  const all = raw.replace(/\n$/, "").split("\n");
  const lines = all
    .slice(0, DIGEST_LINES)
    .map((line) =>
      line.length > DIGEST_LINE_CHARS ? `${line.slice(0, DIGEST_LINE_CHARS)}…` : line,
    );
  return {
    label: source === "text" ? "正文" : "思考",
    lines,
    total: all.length,
  };
}
