/**
 * 规格化：一次非流式模型调用，把用户一句话变成结构化规格，写盘成 spec.json。
 * 用 complete 而非 stream：半截 JSON 没有意义，用户要看的是结果。
 * 解析失败降级为兜底规格，产物照常出，但兜底没有 questions，门禁拦不住。
 */

import type { ArtifactStore } from "../ports/artifact-store";
import type { CostStore } from "../ports/cost-store";
import type { ModelPort, TokenUsage } from "../ports/model";
import type { RunStore } from "../ports/run-store";
import {
  buildSpecPrompt,
  fallbackSpec,
  parseSpec,
  reviewSpec,
  SPEC_SYSTEM_PROMPT,
  summarizeSpec,
  type AppSpec,
  type SpecGate,
} from "../domain/spec";
import { answersToContext, type SpecAnswers } from "./gate";

export type SpecStageEvent =
  | { kind: "phase"; phase: "spec"; label: string }
  /** 非流式调用的思考过程，整段一次性给出 */
  | { kind: "reasoning"; delta: string }
  /** 用量与花费，与生成阶段同构 */
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
      kind: "spec";
      spec: AppSpec;
      gate: SpecGate;
      /** 是否降级产出，界面据此区分兜底与真规格 */
      fallback: boolean;
    }
  | { kind: "error"; message: string; hint?: string };

export interface SpecStageDeps {
  model: ModelPort;
  artifacts: ArtifactStore;
  runs: RunStore;
  costs: CostStore;
}

export interface SpecStageInput {
  runId: string;
  /** 用户原话，一字不改 */
  prompt: string;
  /** 本阶段花费上限（元），超了不发起调用 */
  costLimitCny: number;
  /** 已花金额，由调用方查出传入，内核保持无状态 */
  spentCny?: number;
  maxOutputTokens?: number;
  /**
   * “按我的回答重出一版规格”。给了就带上上一版规格与回答，并禁止重复提问；
   * 没给就是原行为，从零出规格。
   */
  revision?: {
    previous: AppSpec;
    answers: SpecAnswers;
  };
}

/**
 * 重出规格时给模型的提示。
 * 上一版规格要整份在场：只给回答等于重新摇一次骰子，用户确认过的内容会变。
 * “别把答过的问题再问一遍”—— 真出现的疑点仍可问，门禁拦得住。
 */
function buildRevisionPrompt(
  prompt: string,
  previous: AppSpec,
  answers: SpecAnswers,
): string {
  return [
    buildSpecPrompt(prompt),
    "",
    "────────── 上一版规格（已经与用户确认过）──────────",
    JSON.stringify(previous, null, 2),
    "",
    answersToContext(answers),
    "",
    "────────── 请据此更新规格 ──────────",
    "· 保持上一版里已经明确、且用户没有提出异议的部分（验收标准、边界、不做的事）",
    "· 把上面这些回答真正落进规格：需要改的验收标准就改，该写进边界的就写进边界",
    "· **已经回答过的问题不要再问第二遍**（他刚答完）；确实新发现的疑点仍然可以问",
    "· 输出的 JSON 结构与上一版完全一致",
  ].join("\n");
}

/**
 * 规格 JSON 的输出预算。decide 档默认开思考，且思考 token 计入 max_tokens，
 * 2000 会因思考变长而截断退化成兜底规格，4000 起才有实测余量。
 * 再调这个数时记住：预算要同时装下思考与 JSON。
 */
export const SPEC_MAX_OUTPUT_TOKENS = 6000;

/** 产文件名，与 stages.ts 的声明一致，测试守住两者相同 */
export const SPEC_ARTIFACT_NAME = "spec.json";

export async function* runSpecStage(
  deps: SpecStageDeps,
  input: SpecStageInput,
): AsyncIterable<SpecStageEvent> {
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

  yield {
    kind: "phase",
    phase: "spec",
    label: input.revision ? "正在按你的回答重出一版规格" : "正在把你的需求整理成规格",
  };

  let raw = "";
  let result: Awaited<ReturnType<ModelPort["complete"]>> | null = null;

  /** 落盘 spec.json；正常与降级两条路径都要落，所以抽成函数 */
  async function persistSpec(spec: AppSpec): Promise<string | null> {
    try {
      await artifacts.save({
        runId: input.runId,
        kind: "json",
        // 路径约定同 HTML 产物：<运行id>/<文件名>
        path: `${input.runId}/${SPEC_ARTIFACT_NAME}`,
        content: JSON.stringify(spec, null, 2),
      });
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  try {
    // 重出一版规格（可选动作）：把上一版与回答一起给模型，
    // 否则回答只被记下当作确认，规格里拿不准的地方一个字都不会变。
    const userContent = input.revision
      ? buildRevisionPrompt(
          input.prompt,
          input.revision.previous,
          input.revision.answers,
        )
      : buildSpecPrompt(input.prompt);

    result = await model.complete({
      tier: "decide", // 这是判断类任务
      messages: [
        { role: "system", content: SPEC_SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
      responseFormat: "json",
      maxOutputTokens: input.maxOutputTokens ?? SPEC_MAX_OUTPUT_TOKENS,
    });
    raw = result.text;
  } catch (err) {
    // 调用失败也要出规格，否则流水线走不下去
    const message = err instanceof Error ? err.message : String(err);
    yield {
      kind: "error",
      message: `规格化调用模型失败：${message}`,
      hint: "已降级为兜底规格，产物仍会生成，但验收标准是通用的那几条",
    };
    const spec = fallbackSpec({
      prompt: input.prompt,
      model: "fallback",
      generatedAt: Date.now(),
    });
    const saveErr = await persistSpec(spec);
    if (saveErr) {
      yield {
        kind: "error",
        message: `兜底规格写入 ${SPEC_ARTIFACT_NAME} 失败：${saveErr}`,
      };
    }
    yield { kind: "spec", spec, gate: reviewSpec(spec), fallback: true };
    return;
  }

  // 先记账：钱已经花了，后面解析成不成功都要记
  try {
    await costs.record({
      runId: input.runId,
      stage: "spec",
      nodeId: null,
      tier: "decide",
      model: result.model,
      purpose: "把一句话需求整理成结构化规格",
      usage: result.usage,
      costCny: result.costCny,
      priceTier: result.priceTier,
      latencyMs: result.latencyMs,
    });
    // 累计值写 runs，流水写 cost_records：前者回答一共多少，后者回答花在哪一步
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
  const parsed = parseSpec(raw, {
    prompt: input.prompt,
    model: result.model,
    generatedAt: Date.now(),
  });

  const spec = parsed.ok
    ? parsed.spec
    : fallbackSpec({
        prompt: input.prompt,
        model: result.model,
        generatedAt: Date.now(),
      });

  if (!parsed.ok) {
    yield {
      kind: "error",
      message: `模型给出的规格没法解析：${parsed.reason}`,
      hint: "已降级为兜底规格。产物仍会生成，验收标准退回通用硬检查",
    };
  } else if (result.truncated) {
    yield {
      kind: "error",
      message: "规格输出被长度上限截断，解析出来的内容可能不完整",
      hint: `调大 SPEC_MAX_OUTPUT_TOKENS（当前 ${input.maxOutputTokens ?? SPEC_MAX_OUTPUT_TOKENS}）`,
    };
  }

  const gate = reviewSpec(spec);

  // 写盘失败不降级：规格已拿到且用户可见；但要说出来，静默丢产物最难查
  const saveErr = await persistSpec(spec);
  if (saveErr) {
    yield {
      kind: "error",
      message: `规格已产出，但写入 ${SPEC_ARTIFACT_NAME} 失败：${saveErr}`,
      hint: "产物目录可能不可写；规格本身仍可用于后续阶段",
    };
  }

  // 一次性调用也会思考，不发出来界面会显示“没有返回思考内容”；放在结果事件之前
  if (result.reasoning.trim().length > 0) {
    yield { kind: "reasoning", delta: result.reasoning };
  }

  yield { kind: "spec", spec, gate, fallback: !parsed.ok };

  yield {
    kind: "phase",
    phase: "spec",
    label: !parsed.ok
      ? // 兜底没有 questions，能一路通过门禁，不写明会跑到成品
        `规格已就绪（兜底）：${summarizeSpec(spec)}`
      : gate.pass
        ? `规格已就绪：${summarizeSpec(spec)}`
        : gate.summary,
  };
}
