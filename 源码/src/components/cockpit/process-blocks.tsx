"use client";

import { useEffect, useMemo, useRef } from "react";
import type { StepBlock } from "@/core/planning/step-blocks";

/**
 * 生成过程 · 按步骤分块
 * ============================================================
 * 这一块以前是**一整条连续日志**：三千多个片段拼成一条不断变长的正文，
 * 前面发生过什么一路被顶上去、再也找不回来。
 * 现在按 `StepBlock` 分开 —— 一步一块，各带标题、序号和自己的输出。
 *
 * ── ★ 旧的块留在上方，不销毁 ★ ──
 *   三条实现上的选择，缺一条这条承诺就是空的：
 *
 *   一、**key 用块自己的 id（`step-<seq>`）**，不用数组下标。
 *       下标会随"前面多了一条事件"整体漂移，一漂 React 就把
 *       旧节点当成新节点重建：滚动位置、文本选中全丢，
 *       而那看起来正是"旧的东西被销毁了"。
 *       seq 是事件自己的身份，追加新事件永远不会改它。
 *
 *   二、**列表只追加、不重排、不清空**。新块长在下面，
 *       老块的位置一动不动 —— 于是"往上滚能看到全部历史"成立。
 *
 *   三、**滚动不抢用户的镜头**：只有当用户本来就在底部时，
 *       新内容才把视图带下去。用户往上翻了（想读前面那一步），
 *       再来的新块不会把他拽回底部 —— 那等于不让人看历史。
 *
 * ── 摘要为什么只显示前几行 ──
 *   一次生成的正文有二十多 KB，全摊在这里会把其它步骤挤得看不见。
 *   所以每块只给前几行，并**明说**一共多少行、这里只是摘要 ——
 *   全量在右边那一栏（当前步）。不写"共 N 行"的话，
 *   用户没法判断自己看到的是全部还是开头。
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
  /** 摘要优先显示哪一路。默认正文；正文为空时退回思考，并**标明**那是思考 */
  prefer = "text",
  /** 正在跑的时候最后一块是"活的"，加一点提示 */
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
  /** 用户是不是还停在底部。**只有这时才自动往下带** —— 见文件开头第三条 */
  const stickRef = useRef(true);

  useEffect(() => {
    const el = boxRef.current;
    if (!el || !stickRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [blocks]);

  const onScroll = () => {
    const el = boxRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD_PX;
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
          空态说人话：这次运行**还没有**产生任何过程事件。
          不说"加载中"（那会永远转下去），也不留白（空白会被读成"跑完了什么都没有"）。
        */
        <p data-process-blocks-empty className="px-4 py-3 text-[11px] text-slate-600">
          这次运行还没有产生任何过程事件。
          {running ? "模型刚开工，第一段内容马上就到。" : "点「开始生成」，这里会按步骤实时记下每一段。"}
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
              「当前块」是给界面和端到端用的把手：它就是右侧面板正在显示的那一步,
              也是列表的**最后一块**（口径见 /canvas 上那段注释）。
            */
            data-process-block-current={block.id === currentBlockId ? "1" : undefined}
            /*
              ⚠️ 块间横线只加在**第二个及以后**：
                 第一块上面已经有工作台的标签条了，再来一条是重复的线。
                 分隔线是"这两块是两件事"的唯一视觉证据 —— 少了它，
                 连着几块读起来像一整段。
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
                <span className="text-[10px]" style={{ color: TONE_COLOR[block.tone] }}>
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
                  {block.id === currentBlockId ? " · 全文在右侧「这一步的内容」" : ""}
                </p>
              </>
            ) : (
              /*
                空块：这一步确实开跑了，只是什么都没输出。
                明说"没有输出"，而不是留一片空白 —— 空白会被读成"界面漏了"。
              */
              <p data-process-block-empty className="mt-1 text-[10.5px] text-slate-600">
                这一步没有任何输出（只有阶段事件，没有正文也没有思考）。
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
 * 一块的摘要。
 *
 * `prefer` 是用户按「看思考 / 看正文」选的优先那一路；
 * 优先的那一路为空时**退回另一路，并把标签改成另一路的**——
 * 拿思考冒充正文（或反过来）是这一版最不能做的事，
 * 标签跟着内容走，就不会冒充。
 */
function digestOf(
  block: StepBlock,
  prefer: "text" | "reasoning",
): { label: string; lines: string[]; total: number } | null {
  const primary = prefer === "text" ? block.text : block.reasoning;
  const secondary = prefer === "text" ? block.reasoning : block.text;

  const source: "text" | "reasoning" | null =
    primary.trim().length > 0 ? prefer : secondary.trim().length > 0 ? (prefer === "text" ? "reasoning" : "text") : null;
  if (source === null) return null;

  const raw = source === "text" ? block.text : block.reasoning;
  /*
    行数按**去掉末尾那一个换行**之后算：
    模型写的正文常常以 \n 收尾，算成两行会让"共 N 行"多报一行。
  */
  const all = raw.replace(/\n$/, "").split("\n");
  const lines = all.slice(0, DIGEST_LINES).map((line) =>
    line.length > DIGEST_LINE_CHARS ? `${line.slice(0, DIGEST_LINE_CHARS)}…` : line,
  );
  return {
    label: source === "text" ? "正文" : "思考",
    lines,
    total: all.length,
  };
}