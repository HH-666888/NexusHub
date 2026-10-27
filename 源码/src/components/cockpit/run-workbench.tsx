"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import type { StepBlock } from "@/core/planning/step-blocks";
import { GenerationConsole } from "./generation-console";

/**
 * 运行工作区（可折叠）
 * ============================================================
 * 三件事，用标签页切换：
 *   生成过程 —— 实时看模型在写什么、花了多少、检查过了几项
 *   成品     —— 在新页面打开生成出来的成品（能点能用）
 *   源码     —— 看它到底写了什么，并下载成单文件
 *
 * ── ⚠️ 它是**可折叠**的，而且默认是收起来的 ──
 *   原来这一块常驻占屏幕下方 38%。问题是：**多数时候它是空的**。
 *   生成完了、成品也看过了之后，那一块就是一片什么都没有的区域，
 *   白白占掉屏幕下半。而上面那张画布 —— 真正要看的东西 ——
 *   被压得只剩一半高。
 *
 *   现在：**收起时只留一条 40px 的标签条**，画布拿到整个下半屏；
 *   想看生成过程 / 成品 / 源码，点一下标签条就展开。
 *
 * ── 什么时候默认展开 ──
 *   **还没有成品的时候**。因为那时候这一块就是重点 ——
 *   「开始生成」那个按钮在里面，收起来等于把入口藏了。
 *   有过成品之后默认收起，把屏幕让回画布。
 *
 * ── 为什么高度用 vh 而不是让父组件给 ──
 *   父组件（/canvas 的页面）拿不到这里的开关状态，也就没法决定
 *   给多高。用 38vh 自己定，父组件只要 `shrink-0` 就行 ——
 *   收起时靠内容撑出 40px，展开时是 38vh。**一个组件自己管自己的高度。**
 *
 * ── 成品那一页为什么没有 iframe ──
 *   原来内嵌 iframe 直接把成品跑在那一格里，但那一格只有屏高的一小半，
 *   成品应用进去要么显示不全、要么卡在半截上，看着像成品坏了，
 *   而实际上成品是好的，只是没地方显示。**半截的预览比没有预览更糟。**
 *   所以改成一枚明确的按钮：在新标签页里整页打开，能点能用、数据存得住。
 *
 * ── 为什么源码按需拉取而不是服务端直接传下来 ──
 *   一次生成的 HTML 有二十多 KB。放进服务端渲染的 props 里，
 *   意味着每次进工作台都要把它序列化进页面 ——
 *   而多数时候用户只是来看看记录，不会点源码。
 *
 * ── 「生成过程」那一栏现在按步骤分块 ──
 *   服务端按真实事件切好的块（StepBlock[]）从 props 进来，交给 GenerationConsole。
 *   ⚠️ 这两个 props 是**可选**的，而且不传时行为与从前**一模一样**：
 *      退役的 /studio 工作台就是这么用它的（那边没有把事件传下来）。
 *      把它做成必填，等于让那个页面为了这次改动一起改 ——
 *      而 tab 契约、`data-run-workbench` 的 open/closed 行为一个字都不许动。
 */
export function RunWorkbench({
  runId,
  hasArtifact,
  artifactBytes,
  blocks,
  currentBlockId,
}: {
  runId: string;
  hasArtifact: boolean;
  artifactBytes: number | null;
  /** 已落库事件切出来的步骤块。不传 = 这个上下文没接事件通道 */
  blocks?: StepBlock[];
  /** 当前该显示哪一块（口径见 /canvas） */
  currentBlockId?: string | null;
}) {
  const router = useRouter();
  /**
   * 展开状态。**初值跟着「有没有成品」走** ——
   * 没成品时展开（那是唯一能找到「开始生成」的地方），
   * 有成品时收起（把屏幕让回画布）。
   */
  const [open, setOpen] = useState(!hasArtifact);
  /** 有成品时默认停在「成品」—— 点进来最想看的通常是做出来的东西 */
  const [tab, setTab] = useState<"generate" | "artifact" | "source">(
    hasArtifact ? "artifact" : "generate",
  );
  const [source, setSource] = useState<string | null>(null);
  const [loadingSource, setLoadingSource] = useState(false);

  const openSource = useCallback(async () => {
    setTab("source");
    setOpen(true);
    if (source !== null || loadingSource) return;
    setLoadingSource(true);
    try {
      const res = await fetch(`/api/runs/${runId}/artifact`);
      setSource(res.ok ? await res.text() : `（读取失败：HTTP ${res.status}）`);
    } catch {
      setSource("（读取失败，请稍后重试）");
    } finally {
      setLoadingSource(false);
    }
  }, [runId, source, loadingSource]);

  /** 生成结束：刷新服务端数据，并让缓存的源码作废 */
  const onSettled = useCallback(() => {
    setSource(null);
    router.refresh();
  }, [router]);

  const download = useCallback(async () => {
    // 用表单 POST 而不是 <a download>：
    // 下载要带 Cookie 做归属校验，而 <a> 无法带自定义请求头。
    const form = document.createElement("form");
    form.method = "POST";
    form.action = `/api/runs/${runId}/artifact`;
    document.body.appendChild(form);
    form.submit();
    form.remove();
  }, [runId]);

  /** 点标签：展开（如果收着）并切过去 */
  const pick = useCallback(
    (key: "generate" | "artifact" | "source") => {
      if (key === "source") {
        void openSource();
        return;
      }
      setOpen(true);
      setTab(key);
    },
    [openSource],
  );

  return (
    <div
      data-run-workbench={open ? "open" : "closed"}
      className={open ? "flex h-[38vh] min-h-[200px] flex-col" : "flex flex-col"}
    >
      {/* 标签条。**收起时它是唯一可见的东西**，所以折叠按钮就放在这里 */}
      <div className="flex flex-none items-center gap-1 border-b border-[var(--color-border-soft)] px-3 py-1.5">
        {(
          [
            ["generate", "生成过程"],
            ["artifact", "成品"],
            ["source", "源码"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => pick(key)}
            className={`rounded-md px-2.5 py-1 text-[11px] transition-colors duration-150 ${
              open && tab === key
                ? "bg-slate-700/60 text-slate-100"
                : "text-slate-500 hover:text-slate-300"
            }`}
          >
            {label}
          </button>
        ))}

        <div className="ml-auto flex items-center gap-3 text-[11px] text-slate-500">
          {artifactBytes !== null && (
            <span className="tabular-nums">成品 {(artifactBytes / 1024).toFixed(1)} KB</span>
          )}
          {hasArtifact && (
            <>
              <a
                href={`/api/runs/${runId}/artifact`}
                target="_blank"
                rel="noreferrer"
                className="text-slate-400 transition-colors duration-150 hover:text-slate-200"
              >
                新标签打开
              </a>
              <button
                type="button"
                onClick={download}
                className="rounded border border-[var(--color-border-soft)] px-2 py-0.5 text-slate-400 transition-[border-color,color] duration-150 hover:border-slate-500 hover:text-slate-200"
              >
                下载
              </button>
            </>
          )}

          {/*
            折叠按钮。
            收起时朝上（点开），展开时朝下（收起）——
            箭头指的是"点了之后它往哪走"，不是"它现在在哪"。
          */}
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label={open ? "收起下方面板" : "展开下方面板"}
            title={open ? "收起（把屏幕让给画布）" : "展开生成过程 / 成品 / 源码"}
            className="flex h-6 w-6 items-center justify-center rounded border border-[var(--color-border-soft)] text-[10px] text-slate-400 transition-[border-color,color] duration-150 hover:border-slate-500 hover:text-slate-100"
          >
            {open ? "▾" : "▴"}
          </button>
        </div>
      </div>

      {/* 内容区。收起时整块不渲染 —— 不是藏起来，是不占地方 */}
      {open && (
        <div className="min-h-0 flex-1">
          {tab === "generate" && (
            <GenerationConsole
              runId={runId}
              hasArtifact={hasArtifact}
              onSettled={onSettled}
              blocks={blocks}
              currentBlockId={currentBlockId ?? null}
            />
          )}

          {tab === "artifact" &&
            (hasArtifact ? (
              <Opener runId={runId} bytes={artifactBytes} onDownload={download} />
            ) : (
              <Empty
                title="还没有成品"
                hint="切到「生成过程」点一下开始生成，完成后这里会出现打开成品的入口。"
                action={{ label: "去生成", onClick: () => pick("generate") }}
              />
            ))}

          {tab === "source" && (
            <div className="scroll-hint h-full overflow-auto">
              {loadingSource ? (
                <p className="p-4 text-[11px] text-slate-500">正在读取源码…</p>
              ) : (
                <pre className="px-4 py-3 text-[11px] leading-relaxed whitespace-pre-wrap text-slate-400">
                  {source ?? "（暂无内容）"}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 成品入口
 * ============================================================
 * 不放 iframe。理由见文件开头那段 —— 一句话：
 * **半截的预览比没有预览更糟**，它让人以为成品坏了。
 *
 * 这里只做一件事：把「整页打开」这件事说清楚、点得到。
 * 用新标签页而不是当前页跳转 —— 生成过程、源码都还在这一页上，
 * 跳走了就回不来。
 */
function Opener({
  runId,
  bytes,
  onDownload,
}: {
  runId: string;
  bytes: number | null;
  onDownload: () => void;
}) {
  return (
    <div className="flex h-full items-center justify-center px-6">
      <div className="text-center">
        <p className="text-sm text-slate-300">成品已经做好了</p>
        <p className="mx-auto mt-1.5 max-w-md text-[11.5px] leading-relaxed text-slate-500">
          它是一个自包含的单文件网页
          {bytes !== null && <>（{(bytes / 1024).toFixed(1)} KB）</>}。
          <br />
          <span className="text-slate-400">在新标签页里整页打开</span>
          ，能点、能用、数据存得住。
        </p>

        <div className="mt-4 flex items-center justify-center gap-2.5">
          <a
            href={`/api/runs/${runId}/artifact`}
            target="_blank"
            rel="noreferrer"
            className="rounded-lg bg-[var(--app-accent)] px-5 py-2 text-[12px] font-medium text-white transition-[transform,background-color] duration-150 ease-out hover:-translate-y-px hover:opacity-90"
          >
            打开成品 ↗
          </a>
          <button
            type="button"
            onClick={onDownload}
            className="rounded-lg border border-[var(--color-border-soft)] px-4 py-2 text-[12px] text-slate-300 transition-[border-color,color] duration-150 hover:border-slate-500 hover:text-slate-100"
          >
            下载单文件
          </button>
        </div>
      </div>
    </div>
  );
}

function Empty({
  title,
  hint,
  action,
}: {
  title: string;
  hint: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="flex h-full items-center justify-center px-6 text-center">
      <div>
        <p className="text-sm text-slate-400">{title}</p>
        <p className="mx-auto mt-1 max-w-sm text-[11px] leading-relaxed text-slate-500">
          {hint}
        </p>
        {action && (
          <button
            type="button"
            onClick={action.onClick}
            className="mt-3 rounded-lg bg-[var(--app-accent)] px-4 py-1.5 text-[11px] font-medium text-white transition-[transform,background-color] duration-150 ease-out hover:-translate-y-px hover:opacity-90"
          >
            {action.label}
          </button>
        )}
      </div>
    </div>
  );
}