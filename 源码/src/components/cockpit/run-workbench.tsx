"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { GenerationConsole } from "./generation-console";

/**
 * 运行工作区
 * ============================================================
 * 底部这一块承担三件事，用标签页切换：
 *   生成过程 —— 实时看模型在写什么、花了多少、检查过了几项
 *   成品     —— 在新页面打开生成出来的成品（能点能用）
 *   源码     —— 看它到底写了什么，并下载成单文件
 *
 * ── ⚠️ 成品这里**故意不放 iframe 预览** ──
 *   原来这一格是内嵌 iframe，直接在工作台里把成品跑起来。
 *   做法本身没错（省得来回切页面），但实际用下来是**半打开**：
 *   这一格高度只有屏高的一小半，成品应用进去之后要么显示不全、
 *   要么卡在半截上，看着像坏了。
 *
 *   「要么全部打开，要么全部不打开」——
 *   半截的预览比没有预览更糟：它让人以为成品有问题，
 *   而实际上成品是好的，只是没地方显示。
 *
 *   所以现在给的是一枚**明确的按钮**：点一下在新标签页里整页打开。
 *   那里有整屏，滚动、点击、localStorage 全都正常。
 *
 * ── 为什么源码按需拉取而不是服务端直接传下来 ──
 *   一次生成的 HTML 有二十多 KB。放进服务端渲染的 props 里，
 *   意味着每次进工作台都要把它序列化进页面 ——
 *   而多数时候用户只是来看看记录，不会点源码。
 *   按需拉取把这份体积挪到了真正需要的时候。
 */
export function RunWorkbench({
  runId,
  hasArtifact,
  artifactBytes,
}: {
  runId: string;
  hasArtifact: boolean;
  artifactBytes: number | null;
}) {
  const router = useRouter();
  /** 有成品时默认停在「成品」—— 用户点进来最想看的通常是做出来的东西 */
  const [tab, setTab] = useState<"generate" | "artifact" | "source">(
    hasArtifact ? "artifact" : "generate",
  );
  const [source, setSource] = useState<string | null>(null);
  const [loadingSource, setLoadingSource] = useState(false);

  const openSource = useCallback(async () => {
    setTab("source");
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
    // POST 到同一路径，服务端加上 Content-Disposition 让浏览器存盘。
    const form = document.createElement("form");
    form.method = "POST";
    form.action = `/api/runs/${runId}/artifact`;
    document.body.appendChild(form);
    form.submit();
    form.remove();
  }, [runId]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 标签栏 */}
      <div className="flex items-center gap-1 border-b border-[var(--color-border-soft)] px-3 py-1.5">
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
            onClick={() => (key === "source" ? openSource() : setTab(key))}
            className={`rounded-md px-2.5 py-1 text-[11px] transition-colors duration-150 ${
              tab === key
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
              {/* 这两枚是标签栏上的快捷入口，和「成品」那一页里的按钮做同一件事 */}
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
        </div>
      </div>

      {/* 内容区 */}
      <div className="min-h-0 flex-1">
        {tab === "generate" && (
          <GenerationConsole runId={runId} hasArtifact={hasArtifact} onSettled={onSettled} />
        )}

        {tab === "artifact" &&
          (hasArtifact ? (
            <Opener runId={runId} bytes={artifactBytes} onDownload={download} />
          ) : (
            <Empty
              title="还没有成品"
              hint="切到「生成过程」点一下开始生成，完成后这里会出现打开成品的入口。"
              action={{ label: "去生成", onClick: () => setTab("generate") }}
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
 * 用的是**新标签页**而不是当前页跳转 —— 生成过程、源码这些
 * 都还在这一页上，跳走了就回不来了。
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