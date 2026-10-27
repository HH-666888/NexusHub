/**
 * 架构定型：一次决策级模型调用，把已定好的规格切成模块，写盘成 arch.json。
 * 写法与 spec-stage 一致：预算闸门、两条路径都落盘、先记账再解析、降级可辨。
 * 规格必须作为输入传入，无孤儿需求那条检查要用它。
 */

import type { ArtifactStore } from "../ports/artifact-store";
import type { CostStore } from "../ports/cost-store";
import type { ModelPort, TokenUsage } from "../ports/model";
import type { RunStore } from "../ports/run-store";
import {
  ARCH_SYSTEM_PROMPT,
  buildArchPrompt,
  fallbackArch,
  parseArch,
  summarizeArch,
  type ArchSpec,
} from "../domain/arch";
import type { AppSpec } from "../domain/spec";
import { inspectArch, type ArchCheck } from "./arch-check";

export type ArchStageEvent =
  | { kind: "phase"; phase: "arch"; label: string }
  /** 非流式调用的思考过程，整段一次性给出 */
  | { kind: "reasoning"; delta: string }
  /** 用量与花费，与规格化、生成两阶段同构 */
  | {
      kind: "usage";
      usage: TokenUsage;
      costCny: number;
      priceTier: "peak" | "offPeak";
      model: string;
      latencyMs: number;
      truncated: boolean;
    }
  | {
      kind: "arch";
      arch: ArchSpec;
      check: ArchCheck;
      /** 是否降级产出，界面据此区分兜底与真架构 */
      fallback: boolean;
    }
  | { kind: "error"; message: string; hint?: string };

export interface ArchStageDeps {
  model: ModelPort;
  artifacts: ArtifactStore;
  runs: RunStore;
  costs: CostStore;
}

export interface ArchStageInput {
  runId: string;
  /** 用户原话，一字不改 */
  prompt: string;
  /** 真规格；无孤儿需求那条检查要用 */
  spec: AppSpec;
  /** 本阶段花费上限（元），超了不发起调用 */
  costLimitCny: number;
  /** 已花金额，由调用方查出传入，内核保持无状态 */
  spentCny?: number;
  maxOutputTokens?: number;
}

/**
 * 架构 JSON 比规格长（模块 + 依赖 + 归属），6000 够写 6 个模块。
 * 思考 token 计入 max_tokens，同批工序统一按“思考 + 正文”留余量。
 */
export const ARCH_MAX_OUTPUT_TOKENS = 6000;

/** 产文件名，与 stages.ts 的声明一致，测试守住两者相同 */
export const ARCH_ARTIFACT_NAME = "arch.json";

export async function* runArchStage(
  deps: ArchStageDeps,
  input: ArchStageInput,
): AsyncIterable<ArchStageEvent> {
  const { model, artifacts, runs, costs } = deps;

  // 预算闸门：宁可先拒绝，也不花完再说超了
  const spent = input.spentCny ?? 0;
  if (spent >= input.costLimitCny) {
    yield {
      kind: "error",
      message: `本次运行已花费 ¥${spent.toFixed(4)}，达到上限 ¥${input.costLimitCny.toFixed(2)}`,
      hint: "调高 RUN_COST_LIMIT_CNY，或新开一条构建记录",
    };
    return;
  }

  yield { kind: "phase", phase: "arch", label: "正在把规格切分成模块" };

  let raw = "";
  let result: Awaited<ReturnType<ModelPort["complete"]>> | null = null;

  /** 落盘 arch.json；正常与降级两条路径都要落，所以抽成函数 */
  async function persistArch(arch: ArchSpec): Promise<string | null> {
    try {
      await artifacts.save({
        runId: input.runId,
        kind: "json",
        // 路径约定同 spec.json：<运行id>/<文件名>
        path: `${input.runId}/${ARCH_ARTIFACT_NAME}`,
        content: JSON.stringify(arch, null, 2),
      });
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  try {
    result = await model.complete({
      tier: "decide", // 切模块是判断类任务
      messages: [
        { role: "system", content: ARCH_SYSTEM_PROMPT },
        { role: "user", content: buildArchPrompt(input.prompt, input.spec) },
      ],
      responseFormat: "json",
      maxOutputTokens: input.maxOutputTokens ?? ARCH_MAX_OUTPUT_TOKENS,
    });
    raw = result.text;
  } catch (err) {
    // 调用失败也要出架构，否则后续没有并行单元
    const message = err instanceof Error ? err.message : String(err);
    yield {
      kind: "error",
      message: `架构定型调用模型失败：${message}`,
      hint: "已降级为兜底架构（单模块、不做切分），产物仍会生成",
    };
    const arch = fallbackArch({
      spec: input.spec,
      model: "fallback",
      generatedAt: Date.now(),
    });
    const saveErr = await persistArch(arch);
    if (saveErr) {
      yield {
        kind: "error",
        message: `兜底架构写入 ${ARCH_ARTIFACT_NAME} 失败：${saveErr}`,
      };
    }
    yield {
      kind: "arch",
      arch,
      check: inspectArch(arch, input.spec),
      // 兜底必须自报家门：这个 true 是界面区分真架构与兜底的唯一依据
      fallback: true,
    };
    return;
  }

  // 先记账：钱已经花了，后面解析成不成功都要记
  try {
    await costs.record({
      runId: input.runId,
      stage: "arch",
      nodeId: null,
      tier: "decide",
      model: result.model,
      purpose: "把规格切分成模块并定下依赖",
      usage: result.usage,
      costCny: result.costCny,
      priceTier: result.priceTier,
      latencyMs: result.latencyMs,
    });
    // 累计值写 runs，流水写 cost_records；调用方随后还会再查 totalByRun
    await runs.update(input.runId, {
      totalCostCny: spent + result.costCny,
      usage: result.usage,
    });
  } catch {
    // 记账失败不阻塞主流程
  }

  yield {
    kind: "usage",
    usage: result.usage,
    costCny: result.costCny,
    priceTier: result.priceTier,
    model: result.model,
    latencyMs: result.latencyMs,
    truncated: result.truncated,
  };

  // 解析
  const parsed = parseArch(raw);

  const arch = parsed.ok
    ? parsed.arch
    : fallbackArch({
        spec: input.spec,
        model: result.model,
        generatedAt: Date.now(),
      });

  if (!parsed.ok) {
    yield {
      kind: "error",
      message: `模型给出的架构没法解析：${parsed.reason}`,
      hint: "已降级为兜底架构（单模块、不做切分）。产物仍会生成",
    };
  } else if (result.truncated) {
    yield {
      kind: "error",
      message: "架构输出被长度上限截断，解析出来的模块可能不完整",
      hint: `调大 ARCH_MAX_OUTPUT_TOKENS（当前 ${input.maxOutputTokens ?? ARCH_MAX_OUTPUT_TOKENS}）`,
    };
  }

  // 兜底那份也要算：它用一个模块承接全部功能，无孤儿需求照样是绿的
  const check = inspectArch(arch, input.spec);

  // 写盘失败不降级：架构已发出；但要说出来，静默丢产物最难查
  const saveErr = await persistArch(arch);
  if (saveErr) {
    yield {
      kind: "error",
      message: `架构已产出，但写入 ${ARCH_ARTIFACT_NAME} 失败：${saveErr}`,
      hint: "产物目录可能不可写；架构本身仍可用于后续阶段",
    };
  }

  // 一次性调用也会思考，不发出来界面会显示“没有返回思考内容”；放在结果事件之前
  if (result.reasoning.trim().length > 0) {
    yield { kind: "reasoning", delta: result.reasoning };
  }

  yield { kind: "arch", arch, check, fallback: !parsed.ok };

  yield {
    kind: "phase",
    phase: "arch",
    label: !parsed.ok
      ? // 兜底必须写明：本地检查照样全绿，不写会让并行构建建在没切过模块的架构上
        `架构已定型（兜底）：${summarizeArch(arch)}`
      : check.passed === check.total
        ? `架构已定型：${summarizeArch(arch)}`
        : `架构已产出，但本地检查 ${check.passed}/${check.total} 通过 —— ` +
          `${check.results.find((r) => !r.pass)?.name ?? "有一项没过"}`,
  };
}
