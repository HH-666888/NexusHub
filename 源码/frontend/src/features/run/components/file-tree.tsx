"use client";

/**
 * 产物文件树：左边列文件，右边看内容。
 *
 * 文件清单由外层一次取好传进来（它已经在拉运行数据），这里只管"点开某个文件"。
 * 不做语法高亮：多一个依赖换来的收益，不如先把"看得见"这件事做对。
 */

import { useCallback, useState } from "react";

export interface FileEntry {
  path: string;
  bytes: number;
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export function FileTree({ runId, files }: { runId: string; files: FileEntry[] }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const open = useCallback(
    async (path: string) => {
      setSelected(path);
      setContent(null);
      setLoading(true);
      try {
        const res = await fetch(`/api/runs/${runId}/files/${path}`);
        setContent(res.ok ? await res.text() : `（读取失败：HTTP ${res.status}）`);
      } catch {
        setContent("（读取失败，请稍后重试）");
      } finally {
        setLoading(false);
      }
    },
    [runId],
  );

  return (
    <div data-file-tree className="flex h-full min-h-0">
      <ul className="w-56 flex-none overflow-auto border-r border-[var(--color-border-soft)] py-1">
        {files.map((file) => (
          <li key={file.path}>
            <button
              type="button"
              onClick={() => void open(file.path)}
              data-file={file.path}
              className={`flex w-full items-center gap-2 px-3 py-1 text-left text-[11px] transition-colors duration-150 ${
                selected === file.path
                  ? "bg-slate-700/50 text-slate-100"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              <span className="min-w-0 flex-1 truncate font-mono">{file.path}</span>
              <span className="flex-none text-[10px] text-slate-600 tabular-nums">
                {humanSize(file.bytes)}
              </span>
            </button>
          </li>
        ))}
      </ul>

      <div className="scroll-hint min-w-0 flex-1 overflow-auto">
        {selected === null ? (
          <p className="p-4 text-[11px] text-slate-500">选一个文件看内容</p>
        ) : loading ? (
          <p className="p-4 text-[11px] text-slate-500">正在读取…</p>
        ) : (
          <pre
            data-file-content={selected}
            className="px-4 py-3 text-[11px] leading-relaxed whitespace-pre-wrap text-slate-400"
          >
            {content ?? ""}
          </pre>
        )}
      </div>
    </div>
  );
}
