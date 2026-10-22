/**
 * 生成编排
 * ============================================================
 * 从一句话到一个可运行页面，全过程以「事件流」的形式吐出来。
 *
 * 为什么是异步生成器而不是「跑完返回结果」：
 *   产品定位是「把过程完全摊开给用户看」——
 *   思考过程、成本跳动、检查结果，都要在发生的当下就能看到。
 *   做成事件流之后，上层的 SSE 接口只需要把事件转发出去，
 *   不需要自己再拆解一遍进度。
 *
 * 一个刻意的顺序：**先记账，再检查，最后落盘**。
 *   花钱是已经发生的事实，无论后面检查过不过都要记；
 *   先记下来，才不会出现「失败了所以没记账」的糊涂账。
 */

import type { Artifact } from "../domain/artifact";
import { summarizeChecks, type CheckResult, type CheckSummary } from "../domain/check";
import type { ArtifactStore } from "../ports/artifact-store";
import type { CostStore } from "../ports/cost-store";
import type { ModelEffort, ModelPort, TokenUsage } from "../ports/model";
import type { RunStore } from "../ports/run-store";
import {
  extractHtml,
  GENERATE_DEFAULT_EFFORT,
  GENERATE_MAX_OUTPUT_TOKENS,
  inspectArtifact,
  SYSTEM_PROMPT,
} from "./prompt";

/* ============================================================
   事件定义
   ------------------------------------------------------------
   前端只需要认识这几种事件，就能渲染出完整的过程视图。
   ============================================================ */

export type GeneratePhase =
  | "generating" // 模型正在写
  | "checking" // 正在做产物检查
  | "saving" // 正在落盘
  | "done" // 全部完成
  | "failed"; // 失败

export type GenerateEvent =
  | { kind: "phase"; phase: GeneratePhase; label: string }
  /** 思考片段。前端逐段追加即可，不需要自己拼接 */
  | { kind: "reasoning"; delta: string }
  /** 正文片段 */
  | { kind: "text"; delta: string }
  | {
      kind: "usage";
      usage: TokenUsage;
      costCny: number;
      priceTier: "peak" | "offPeak";
      model: string;
      latencyMs: number;
      /** 被输出上限截断 —— 这不是模型能力问题，是预算问题 */
      truncated: boolean;
    }
  | { kind: "check"; results: CheckResult[]; summary: CheckSummary }
  | { kind: "artifact"; artifact: Artifact }
  | { kind: "error"; message: string; hint?: string };

export interface GenerateDeps {
  model: ModelPort;
  artifacts: ArtifactStore;
  runs: RunStore;
  costs: CostStore;
}

export interface GenerateInput {
  runId: string;
  prompt: string;
  /** 单次运行成本上限（元）。超出直接拒绝，不发起调用 */
  costLimitCny: number;
  /** 已经花掉的钱。由调用方查出后传入，让内核保持无状态 */
  spentCny?: number;
  effort?: ModelEffort;
  maxOutputTokens?: number;
}

/* ============================================================
   编排
   ============================================================ */

export async function* generateApp(
  deps: GenerateDeps,
  input: GenerateInput,
): AsyncIterable<GenerateEvent> {
  const { model, artifacts, runs, costs } = deps;

  /* ---------- 预算闸门：先查钱，再花钱 ---------- */
  const spent = input.spentCny ?? 0;
  if (spent >= input.costLimitCny) {
    await runs.update(input.runId, { status: "failed" });
    yield {
      kind: "error",
      message: `本次运行已花费 ¥${spent.toFixed(4)}，达到上限 ¥${input.costLimitCny.toFixed(2)}`,
      hint: "调高 .env.local 里的 RUN_COST_LIMIT_CNY，或另开一次运行",
    };
    yield { kind: "phase", phase: "failed", label: "已停止（超出预算）" };
    return;
  }

  await runs.update(input.runId, { stage: "build", status: "running" });
  yield {
    kind: "phase",
    phase: "generating",
    label: input.effort === "none" ? "正在生成（不思考）" : "正在生成",
  };

  /* ---------- 调用模型，边收边转发 ---------- */
  let finalResult: Awaited<ReturnType<ModelPort["complete"]>> | null = null;

  try {
    const stream = model.stream({
      tier: "execute",
      effort: input.effort ?? GENERATE_DEFAULT_EFFORT,
      maxOutputTokens: input.maxOutputTokens ?? GENERATE_MAX_OUTPUT_TOKENS,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: input.prompt },
      ],
    });

    for await (const chunk of stream) {
      if (chunk.kind === "reasoning") {
        yield { kind: "reasoning", delta: chunk.delta };
      } else if (chunk.kind === "text") {
        yield { kind: "text", delta: chunk.delta };
      } else {
        finalResult = chunk.result;
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await runs.update(input.runId, { status: "failed" });
    yield { kind: "error", message };
    yield { kind: "phase", phase: "failed", label: "生成失败" };
    return;
  }

  if (!finalResult) {
    await runs.update(input.runId, { status: "failed" });
    yield { kind: "error", message: "模型没有返回结果" };
    yield { kind: "phase", phase: "failed", label: "生成失败" };
    return;
  }

  const result = finalResult;

  /* ---------- 记账：先记事实，再管结果 ---------- */
  await costs.record({
    runId: input.runId,
    stage: "build",
    nodeId: null,
    tier: "execute",
    model: result.model,
    purpose: `生成应用：${input.prompt.slice(0, 40)}`,
    usage: result.usage,
    costCny: result.costCny,
    priceTier: result.priceTier,
    latencyMs: result.latencyMs,
  });

  const totalCost = spent + result.costCny;
  await runs.update(input.runId, {
    totalCostCny: totalCost,
    usage: result.usage,
  });

  yield {
    kind: "usage",
    usage: result.usage,
    costCny: result.costCny,
    priceTier: result.priceTier,
    model: result.model,
    latencyMs: result.latencyMs,
    truncated: result.truncated,
  };

  if (result.truncated) {
    yield {
      kind: "error",
      message: "输出被长度上限截断，产物可能不完整",
      hint: "这是预算问题不是能力问题：提高 maxOutputTokens 后重跑即可",
    };
  }

  /* ---------- 产物检查 ---------- */
  yield { kind: "phase", phase: "checking", label: "正在检查产物" };
  const html = extractHtml(result.text);
  const results = inspectArtifact(html);
  const summary = summarizeChecks(results);
  yield { kind: "check", results, summary };

  /* ---------- 落盘 ---------- */
  yield { kind: "phase", phase: "saving", label: "正在保存产物" };

  let artifact: Artifact;
  try {
    artifact = await artifacts.save({
      runId: input.runId,
      kind: "html",
      path: `${input.runId}/index.html`,
      content: html,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await runs.update(input.runId, { status: "failed" });
    yield { kind: "error", message: `产物写入失败：${message}` };
    yield { kind: "phase", phase: "failed", label: "保存失败" };
    return;
  }

  yield { kind: "artifact", artifact };

  /* ---------- 收尾 ---------- */
  // 有检查没过时标记为失败 —— 让「生成完了」和「生成对了」保持区别。
  // 这是刻意不让它自动通过：产物不完整就不该说成功。
  const ok = summary.failed === 0;
  await runs.update(input.runId, {
    stage: ok ? "verify" : "build",
    status: ok ? "done" : "failed",
  });

  yield {
    kind: "phase",
    phase: ok ? "done" : "failed",
    label: ok
      ? `完成 · ${summary.passed}/${summary.total} 项检查通过`
      : `产物不合格 · ${summary.failed} 项检查未通过`,
  };
}