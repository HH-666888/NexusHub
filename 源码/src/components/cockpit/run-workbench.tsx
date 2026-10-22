"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { GenerationConsole } from "./generation-console";

/**
 * 运行工作区
 * ============================================================
 * 底部这一块承担三件事，用标签页切换：
 *   生成过程 —— 实时看模型在写什么、花了多少、检查过了几项
 *   预览     —— 直接加载生成出来的成品，能点能用
 *   源码     —— 看它到底写了什么，并下载成单文件
 *
 * 为什么源码按需拉取而不是服务端直接传下来：
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
  const [tab, setTab] = useState<"generate" | "preview" | "source">(
    hasArtifact ? "preview" : "generate",
  );
  const [source, setSource] = useState<string | null>(null);
  const [loadingSource, setLoadingSource] = useState(false);
  /** 用 key 强制 iframe 重新加载：生成完再点预览时，浏览器可能还缓存着旧内容 */
  const [previewNonce, setPreviewNonce] = useState(0);

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

  /** 生成结束：刷新服务端数据，并把预览的 iframe 换一次 key */
  const onSettled = useCallback(() => {
    setSource(null); // 内容变了，缓存的源码作废
    setPreviewNonce((n) => n + 1);
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
            ["preview", "成品预览"],
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
        </div>
      </div>

      {/* 内容区 */}
      <div className="min-h-0 flex-1">
        {tab === "generate" && (
          <GenerationConsole
            runId={runId}
            hasArtifact={hasArtifact}
            onSettled={onSettled}
          />
        )}

        {tab === "preview" &&
          (hasArtifact ? (
            <iframe
              key={previewNonce}
              src={`/api/runs/${runId}/artifact`}
              title="成品预览"
              /*
                sandbox 的两项都有明确用途：
                  allow-scripts     —— 生成的应用靠 JS 渲染，不给就只是一张静态图
                  allow-same-origin —— 生成的应用靠 localStorage 存数据，
                                       不给的话一刷新数据就没了
                刻意不给的：allow-top-navigation（不能把整页跳走）、
                            allow-forms（不能伪造表单提交）、
                            allow-popups。
                真正切断「把数据送出去」的是服务端那张 CSP 上的
                connect-src 'none'，见 artifact 接口的说明。
              */
              sandbox="allow-scripts allow-same-origin"
              className="h-full w-full border-0"
            />
          ) : (
            <Empty
              title="还没有成品"
              hint="切到「生成过程」点一下开始生成，完成后这里会直接出现能点能用的成品。"
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