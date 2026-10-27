/**
 * 生成编排：从一句话到可运行页面的全过程，以异步事件流吐出。
 * 顺序是“先记账，再检查，最后落盘”—— 钱花出去是事实，失败了也要记。
 */

import type { Artifact } from "../domain/artifact";
import { summarizeChecks, type CheckResult, type CheckSummary } from "../domain/check";
import type { ArchSpec } from "../domain/arch";
import {
  buildAssemblePrompt,
  type BuildBatch,
  type BuildBatchSummary,
} from "../domain/module-build";
import type { AppSpec, SpecGate } from "../domain/spec";
import type { UiSpec } from "../domain/ui-spec";
import type { ArchCheck } from "./arch-check";
import type { UiCheck } from "./ui-check";
import type { ArtifactStore } from "../ports/artifact-store";
import type { CostStore } from "../ports/cost-store";
import type { ModelEffort, ModelMessage, ModelPort, TokenUsage } from "../ports/model";
import type { RunStore } from "../ports/run-store";
import {
  extractHtml,
  GENERATE_DEFAULT_EFFORT,
  GENERATE_MAX_OUTPUT_TOKENS,
  inspectArtifact,
  SYSTEM_PROMPT,
} from "./prompt";
import { MAX_OUTPUT_TOKENS_CEILING } from "./truncation-retry";
import { addUsage, ZERO_USAGE } from "../domain/module-build";

// 事件定义：前端认识这几种事件就能渲染出完整的过程视图。
// arch / ui / building 做成 phase 而不是新 kind：PHASE_OWNER 是穷尽 Record，
// 加一个值编译器就会逼着人回答“这条 phase 算谁的”。

export type GeneratePhase =
  | "spec" // 规格化：把一句话需求整理成结构化规格
  | "arch" // 架构定型：把规格切分成模块并定下依赖
  | "ui" // 界面设计：定下设计变量、页面与组件
  | "building" // 并行构建：按模块同时开工
  | "awaiting" // 人工门禁：停下等用户回答规格里的疑问
  | "generating" // 模型正在写
  | "checking" // 正在做产物检查
  | "saving" // 正在落盘
  | "done" // 全部完成
  | "failed"; // 失败

export type GenerateEvent =
  | {
      kind: "phase";
      phase: GeneratePhase;
      label: string;
      /**
       * 回流标记。界面要把它留在固定位置，而不是被后续 phase 顶掉；
       * 靠 label.includes 去认太脆，改一个字就静默失效。
       */
      note?: "callback";
    }
  /** 思考片段，前端逐段追加 */
  | { kind: "reasoning"; delta: string }
  /** 正文片段 */
  | { kind: "text"; delta: string }
  /**
   * 规格化产出。单独一种事件，因为规格决定后面所有工序的判定依据，
   * 用户要能逐条读到它把需求理解成了什么。
   */
  | {
      kind: "spec";
      spec: AppSpec;
      gate: SpecGate;
      /** 是否降级产出，界面据此区分兜底与真规格 */
      fallback: boolean;
    }
  /** 架构定型产出。check 跟着产物一起发出，清单里的模块点状态由它决定 */
  | {
      kind: "arch";
      arch: ArchSpec;
      check: ArchCheck;
      /** 是否降级产出 */
      fallback: boolean;
    }
  /** 界面设计产出。check 跟着产物一起发出，清单里的页面点状态由它决定 */
  | {
      kind: "ui";
      ui: UiSpec;
      check: UiCheck;
      /** 是否降级产出 */
      fallback: boolean;
    }
  /**
   * 并行构建产出，只给摘要不给完整 BuildBatch：代码片段是产物，
   * 塞进事件只会让事件表白白变大，回放时没有任何一处读它。
   */
  | { kind: "modules"; batch: BuildBatchSummary }
  | {
      kind: "usage";
      usage: TokenUsage;
      costCny: number;
      priceTier: "peak" | "offPeak";
      model: string;
      latencyMs: number;
      /** 被输出上限截断，是预算问题不是能力问题 */
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
  /** 单次运行成本上限（元），超出直接拒绝 */
  costLimitCny: number;
  /** 已花金额，由调用方查出传入，内核保持无状态 */
  spentCny?: number;
  effort?: ModelEffort;
  maxOutputTokens?: number;
  /**
   * 回流上下文（任务 07），由调用方拼好传入 —— 内核不碰数据库。
   * 不传就不加那条消息：空消息会多花 token，也会被模型读出言外之意。
   */
  callbackContext?: string | null;
  /**
   * 并行构建批次。传了之后装配提示词会真的带上各模块片段，
   * 产物检查也会多跑一条“模块代码确实进入了产物”的探针。
   * 不传即保持原来的单次调用行为，事件序列一个字节都不变。
   */
  batch?: BuildBatch | null;
  /** 架构产物，只用来让装配提示词带上模块名与职责；不传则只写 id */
  arch?: ArchSpec | null;
}

export async function* generateApp(
  deps: GenerateDeps,
  input: GenerateInput,
): AsyncIterable<GenerateEvent> {
  const { model, artifacts, runs, costs } = deps;

  // 预算闸门：先查钱，再花钱
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
    label:
      input.batch && input.batch.modules.length > 0
        ? // 这次是装配：说清不是从头写，用户才知道前面那次并行没白跑
          `正在装配 ${input.batch.modules.length} 个模块的产出`
        : input.effort === "none"
          ? "正在生成（不思考）"
          : "正在生成",
  };

  /*
    装配输入：没有 batch 时用户消息就是原话（一字不改）；有 batch 时原话在前，
    后面接各模块真写出来的片段（超长掐尾，特征片段都在开头）。
  */
  const userContent = input.batch
    ? buildAssemblePrompt({
        prompt: input.prompt,
        batch: input.batch,
        arch: input.arch ?? undefined,
      })
    : input.prompt;

  /*
    调用模型边收边转发。截断就加倍预算重来一次，策略与并行构建相同。
    自己写循环而不用 truncation-retry：装配走 stream()，而流式重试必须另起一块，
    否则第二次的正文会和第一次那半截拼成一段前后矛盾的文字。
  */
  const messages: ModelMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    // 回流单独一条 system 消息：拼进用户原话会改掉那次运行的起点。
    // 放在用户消息之前，因为它是背景而不是这次的诉求。
    ...(input.callbackContext
      ? [{ role: "system" as const, content: input.callbackContext }]
      : []),
    { role: "user", content: userContent },
  ];

  let budget = input.maxOutputTokens ?? GENERATE_MAX_OUTPUT_TOKENS;
  /** 最多试几次：一次原调用 + 一次加倍重试 */
  const MAX_ATTEMPTS = 2;
  /** 作数的那一次结果 */
  let result: Awaited<ReturnType<ModelPort["complete"]>> | null = null;
  /** 累计用量与花费，含被重试掉的那一次 */
  let spentUsage: TokenUsage = ZERO_USAGE;
  let spentCny = 0;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let attemptResult: Awaited<ReturnType<ModelPort["complete"]>> | null = null;

    try {
      const stream = model.stream({
        tier: "execute",
        effort: input.effort ?? GENERATE_DEFAULT_EFFORT,
        maxOutputTokens: budget,
        messages,
      });

      for await (const chunk of stream) {
        if (chunk.kind === "reasoning") {
          yield { kind: "reasoning", delta: chunk.delta };
        } else if (chunk.kind === "text") {
          yield { kind: "text", delta: chunk.delta };
        } else {
          attemptResult = chunk.result;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await runs.update(input.runId, { status: "failed" });
      yield { kind: "error", message };
      yield { kind: "phase", phase: "failed", label: "生成失败" };
      return;
    }

    if (!attemptResult) {
      await runs.update(input.runId, { status: "failed" });
      yield { kind: "error", message: "模型没有返回结果" };
      yield { kind: "phase", phase: "failed", label: "生成失败" };
      return;
    }

    /*
      重试条件：截断了、还有下一次、且加倍之后确实更大。
      attempt < MAX_ATTEMPTS 不能省 —— 少了它事件里会写“已加倍重新装配”，
      而那次装配根本没发生。
    */
    const nextBudget = attemptResult.truncated
      ? Math.min(budget * 2, MAX_OUTPUT_TOKENS_CEILING)
      : 0;
    const willRetry =
      attempt < MAX_ATTEMPTS && attemptResult.truncated && nextBudget > budget;

    /*
      每次调用各记一行，含被重试掉的那一次：它没产出可用的东西，但钱是真花掉的。
      记账放在循环里而不是循环后：第二次可能直接抛错，那时第一次的钱就丢了。
    */
    await costs.record({
      runId: input.runId,
      stage: "build",
      nodeId: null,
      tier: "execute",
      model: attemptResult.model,
      purpose: willRetry
        ? `生成应用（输出顶满预算，已重试）：${input.prompt.slice(0, 30)}`
        : `生成应用：${input.prompt.slice(0, 40)}`,
      usage: attemptResult.usage,
      costCny: attemptResult.costCny,
      priceTier: attemptResult.priceTier,
      latencyMs: attemptResult.latencyMs,
    });

    spentUsage = addUsage(spentUsage, attemptResult.usage);
    spentCny += attemptResult.costCny;
    await runs.update(input.runId, {
      totalCostCny: spent + spentCny,
      usage: attemptResult.usage,
    });

    yield {
      kind: "usage",
      usage: attemptResult.usage,
      costCny: attemptResult.costCny,
      priceTier: attemptResult.priceTier,
      model: attemptResult.model,
      latencyMs: attemptResult.latencyMs,
      truncated: attemptResult.truncated,
    };

    result = attemptResult;
    if (!willRetry) break;

    // 说清上一次不算数，否则界面上并排两段正文，用户不知哪段是成品
    yield {
      kind: "phase",
      phase: "generating",
      label:
        `输出顶满了长度上限（思考把预算吃光了），已把预算加倍到 ${nextBudget} tokens 重新装配 —— ` +
        `上面那一段只算过程，这一次的产出作数`,
    };
    budget = nextBudget;
  }

  if (!result) {
    // 逻辑上到不了：循环里每一次拿到结果就赋了值，否则上面已经 return
    await runs.update(input.runId, { status: "failed" });
    yield { kind: "error", message: "模型没有返回结果" };
    yield { kind: "phase", phase: "failed", label: "生成失败" };
    return;
  }

  /*
    模块那几笔不在这里记：编排层已按每次模块调用各记一行并并进 spentCny，
    在这里再记一遍会让 runs.totalCostCny 凭空翻倍。
  */

  if (result.truncated) {
    yield {
      kind: "error",
      message: "输出被长度上限截断，产物可能不完整",
      hint:
        `这是预算问题不是能力问题：已经加倍重试过一次（当前 ${budget} tokens）—— ` +
        `还不够就说明这一次装配的规模本身太大，该从架构上拆，而不是继续抬常数`,
    };
  }

  // 产物检查
  yield { kind: "phase", phase: "checking", label: "正在检查产物" };
  const html = extractHtml(result.text);
  /* 有 batch 时检查器多跑一条探针；没有时一项都不多，旧路径的 passed/total 不变 */
  const results = inspectArtifact(html, { batch: input.batch });
  const summary = summarizeChecks(results);
  yield { kind: "check", results, summary };

  // 落盘
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

  // 收尾
  // 有检查没过时标记为失败，让“生成完了”与“生成对了”保持区别
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
