"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import type { StepBlock } from "@/core/planning/step-blocks";
import { FileTree, type FileEntry } from "./file-tree";
import { VerdictList } from "./verdict-list";
import { GenerationConsole } from "./generation-console";

/**
 * 运行工作区。三个标签页：生成过程 / 成品 / 源码。
 *
 * 可折叠，默认跟随“有没有成品”：没成品时展开（开始生成的入口在里面），
 * 有成品时收起，只留一条 40px 的标签条，把屏幕下半还给画布。
 * 高度用 38vh 自己定 —— 父组件拿不到开关状态，也就不该由父组件给高度。
 *
 * 成品那页不放 iframe：一格屏高跑整个应用，显示不全时看着像成品坏了，
 * 半截的预览比没有预览更糟，所以改成在新标签页整页打开。
 *
 * 源码按需拉取：一次生成的 HTML 有二十多 KB，多数人只是来看记录。
 * blocks / currentBlockId 可选，不传时行为与退役的 /studio 完全一致。
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
   * 展开状态。初值跟着“有没有成品”走：没成品时展开，
   * 那是唯一能找到“开始生成”的地方；有成品时收起。
   */
  const [open, setOpen] = useState(!hasArtifact);
  /** 有成品时默认停在“成品”，点进来最想看的通常是做出来的东西 */
  const [tab, setTab] = useState<
    "generate" | "artifact" | "source" | "files" | "verdict"
  >(hasArtifact ? "artifact" : "generate");
  const [source, setSource] = useState<string | null>(null);
  const [loadingSource, setLoadingSource] = useState(false);
  /** 产物文件清单：只有全栈模式才会有；为空则不显示"文件"标签 */
  const [files, setFiles] = useState<FileEntry[]>([]);

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

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/runs/${runId}/files`);
        if (!res.ok) return;
        const body = (await res.json()) as { files?: FileEntry[] };
        if (!cancelled) setFiles(body.files ?? []);
      } catch {
        // 取不到就当没有文件：单文件模式下本来就没有，不该让界面报错
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runId]);

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
    (key: "generate" | "artifact" | "source" | "files" | "verdict") => {
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
      {/* 标签条：收起时它是唯一可见的东西，折叠按钮也放在这里 */}
      <div className="flex flex-none items-center gap-1 border-b border-[var(--color-border-soft)] px-3 py-1.5">
        {(
          [
            ["generate", "生成过程"],
            ["artifact", "成品"],
            ["source", "源码"],
            ...(files.length > 0 ? ([["files", "文件"]] as const) : []),
            ...(files.some((f) => f.path === "verdict.json")
              ? ([["verdict", "验收"]] as const)
              : []),
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
            <span className="tabular-nums">
              成品 {(artifactBytes / 1024).toFixed(1)} KB
            </span>
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
            箭头指“点了之后往哪走”，不是“它现在在哪”：收起时朝上，展开时朝下。
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

      {/* 内容区：收起时整块不渲染，不是藏起来，是不占地方 */}
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
                hint="切到“生成过程”点一下开始生成，完成后这里会出现打开成品的入口。"
                action={{ label: "去生成", onClick: () => pick("generate") }}
              />
            ))}

          {tab === "files" && files.length > 0 && (
            <FileTree runId={runId} files={files} />
          )}

          {tab === "verdict" && <VerdictList runId={runId} />}

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
 * 成品入口。不放 iframe：半截的预览比没有预览更糟，会让人以为成品坏了。
 * 用新标签页而不是当前页跳转 —— 生成过程和源码都还在这一页上。
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
