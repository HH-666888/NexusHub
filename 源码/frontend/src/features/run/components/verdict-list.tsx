"use client";

/**
 * 验收清单：读工作区里的 verdict.json，按层列出每一检查项。
 *
 * 为什么不走事件：verdict 事件只带"这一层通过几项"，具体哪一项没过要看文件。
 * 文件已经在工作区里（后端写的），走既有的单文件路由读它，不另造接口。
 */

import { useEffect, useState } from "react";

interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

interface Layer {
  layer: "db" | "api" | "ui";
  checks: Check[];
  passed: number;
  total: number;
}

interface Verdict {
  layers: Layer[];
  passed: number;
  total: number;
}

const LAYER_LABEL: Record<Layer["layer"], string> = {
  db: "数据库",
  api: "接口",
  ui: "界面",
};

export function VerdictList({ runId }: { runId: string }) {
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/runs/${runId}/files/verdict.json`);
        if (cancelled) return;
        if (!res.ok) {
          setError(
            res.status === 404
              ? "还没有验收结果（跑一次全栈生成后再看）"
              : `读取失败：HTTP ${res.status}`,
          );
          return;
        }
        setVerdict((await res.json()) as Verdict);
      } catch {
        if (!cancelled) setError("读取失败，请稍后重试");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runId]);
  if (error) return <p className="p-4 text-[11px] text-slate-500">{error}</p>;
  if (!verdict)
    return <p className="p-4 text-[11px] text-slate-500">正在读取验收结果…</p>;

  return (
    <div data-verdict-list className="scroll-hint h-full overflow-auto px-4 py-3">
      <p className="mb-2 text-[11px] text-slate-400">
        三层验证：{verdict.passed}/{verdict.total} 项通过
        {verdict.passed === verdict.total ? "（全部通过）" : "（有未通过项）"}
      </p>
      {verdict.layers.map((layer) => (
        <section key={layer.layer} data-verdict-layer={layer.layer} className="mb-3">
          <h4 className="mb-1 flex items-center gap-2 text-[11px] font-medium text-slate-300">
            {LAYER_LABEL[layer.layer]}
            <span className="text-[10px] text-slate-500 tabular-nums">
              {layer.passed}/{layer.total}
            </span>
          </h4>
          <ul className="space-y-0.5">
            {layer.checks.map((check, index) => (
              <li
                key={`${layer.layer}-${index}`}
                data-verdict-check={check.pass ? "pass" : "fail"}
                className="flex gap-2 text-[11px] leading-relaxed"
                style={{ color: check.pass ? "#6ee7a8" : "#f87171" }}
              >
                <span className="flex-none">{check.pass ? "✓" : "×"}</span>
                <span className="min-w-0">
                  {check.name}
                  {check.detail && (
                    <span className="text-slate-500"> · {check.detail}</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
