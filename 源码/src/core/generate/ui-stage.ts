/**
 * 界面设计：一次决策级调用，把已定型的架构变成页面与设计变量，写盘成 ui-spec.json。
 * 写法与 arch-stage 一致；spec 判功能有页面，arch 判数据需求指得到模块。
 * 降级为「单页 + 一套最小变量」，三条本地检查照样全绿，所以 fallback 标记必须如实。
 */

import type { ArtifactStore } from "../ports/artifact-store";
import type { CostStore } from "../ports/cost-store";
import type { ModelPort, TokenUsage } from "../ports/model";
import type { RunStore } from "../ports/run-store";
import type { ArchSpec } from "../domain/arch";
import type { AppSpec } from "../domain/spec";
import {
  UI_SYSTEM_PROMPT,
  buildUiPrompt,
  fallbackUi,
  parseUi,
  summarizeUi,
  type UiSpec,
} from "../domain/ui-spec";
import { inspectUi, type UiCheck } from "./ui-check";


export type UiStageEvent =
  | { kind: "phase"; phase: "ui"; label: string }
  /** 非流式调用的思考过程，整段一次性给出 */
  | { kind: "reasoning"; delta: string }
  /** 用量与花费，与前两道同构 */
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
      kind: "ui";
      ui: UiSpec;
      check: UiCheck;
      /** 是否降级产出，界面据此区分兜底与真设计 */
      fallback: boolean;
    }
  | { kind: "error"; message: string; hint?: string };

export interface UiStageDeps {
  model: ModelPort;
  artifacts: ArtifactStore;
  runs: RunStore;
  costs: CostStore;
}

export interface UiStageInput {
  runId: string;
  /** 用户原话，一字不改 */
  prompt: string;
  /** 第一条检查（功能有页面）要用 */
  spec: AppSpec;
  /** 第三条检查（数据需求对应模块）要用 */
  arch: ArchSpec;
  /** 本阶段花费上限（元），超了不发起调用 */
  costLimitCny: number;
  /** 已花金额，由调用方查出传入，内核保持无状态 */
  spentCny?: number;
  maxOutputTokens?: number;
}

/**
 * 界面设计 JSON 三块（变量表 + 页面 + 组件），6000 够写 6 个页面 + 12 个组件。
 * 思考 token 计入 max_tokens，余量口径与另两道一致。
 */
export const UI_MAX_OUTPUT_TOKENS = 6000;

/** 产文件名，与 stages.ts 的声明一致，测试守住两者相同 */
export const UI_ARTIFACT_NAME = "ui-spec.json";


export async function* runUiStage(
  deps: UiStageDeps,
  input: UiStageInput,
): AsyncIterable<UiStageEvent> {
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

  yield { kind: "phase", phase: "ui", label: "正在把架构变成页面与设计变量" };

  let raw = "";
  let result: Awaited<ReturnType<ModelPort["complete"]>> | null = null;

  /** 落盘 ui-spec.json；正常与降级两条路径都要落，所以抽成函数 */
  async function persistUi(ui: UiSpec): Promise<string | null> {
    try {
      await artifacts.save({
        runId: input.runId,
        kind: "json",
        // 路径约定同 spec.json / arch.json：<运行id>/<文件名>
        path: `${input.runId}/${UI_ARTIFACT_NAME}`,
        content: JSON.stringify(ui, null, 2),
      });
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  try {
    result = await model.complete({
      tier: "decide", // 定变量表与页面划分是判断类任务
      messages: [
        { role: "system", content: UI_SYSTEM_PROMPT },
        { role: "user", content: buildUiPrompt(input.prompt, input.spec, input.arch) },
      ],
      responseFormat: "json",
      maxOutputTokens: input.maxOutputTokens ?? UI_MAX_OUTPUT_TOKENS,
    });
    raw = result.text;
  } catch (err) {
    // 调用失败也要出界面，否则后续没有可并行的界面单元
    const message = err instanceof Error ? err.message : String(err);
    yield {
      kind: "error",
      message: `界面设计调用模型失败：${message}`,
      hint: "已降级为兜底界面（单页 + 一套最小变量），产物仍会生成",
    };
    const ui = fallbackUi({
      spec: input.spec,
      arch: input.arch,
      model: "fallback",
      generatedAt: Date.now(),
    });
    const saveErr = await persistUi(ui);
    if (saveErr) {
      yield {
        kind: "error",
        message: `兜底界面写入 ${UI_ARTIFACT_NAME} 失败：${saveErr}`,
      };
    }
    yield {
      kind: "ui",
      ui,
      check: inspectUi(ui, input.spec, input.arch),
      // 兜底必须自报家门：这个 true 是界面区分真设计与兜底的唯一依据
      fallback: true,
    };
    return;
  }

  // 先记账：钱已经花了，后面解析成不成功都要记
  try {
    await costs.record({
      runId: input.runId,
      stage: "ui",
      nodeId: null,
      tier: "decide",
      model: result.model,
      purpose: "定下设计变量与页面划分",
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
  const parsed = parseUi(raw);

  const ui = parsed.ok
    ? parsed.ui
    : fallbackUi({
        spec: input.spec,
        arch: input.arch,
        model: result.model,
        generatedAt: Date.now(),
      });

  if (!parsed.ok) {
    yield {
      kind: "error",
      message: `模型给出的界面设计没法解析：${parsed.reason}`,
      hint: "已降级为兜底界面（单页 + 一套最小变量）。产物仍会生成",
    };
  } else if (result.truncated) {
    yield {
      kind: "error",
      message: "界面设计输出被长度上限截断，解析出来的页面可能不完整",
      hint: `调大 UI_MAX_OUTPUT_TOKENS（当前 ${input.maxOutputTokens ?? UI_MAX_OUTPUT_TOKENS}）`,
    };
  }

  // 兜底那份也要算：一个页面承接全部功能、只用自定义变量，三条照样是绿的
  const check = inspectUi(ui, input.spec, input.arch);

  // 写盘失败不降级：界面已发出；但要说出来，静默丢产物最难查
  const saveErr = await persistUi(ui);
  if (saveErr) {
    yield {
      kind: "error",
      message: `界面设计已产出，但写入 ${UI_ARTIFACT_NAME} 失败：${saveErr}`,
      hint: "产物目录可能不可写；界面本身仍可用于后续阶段",
    };
  }

  // 一次性调用也会思考，不发出来界面会显示「没有返回思考内容」；放在结果事件之前
  if (result.reasoning.trim().length > 0) {
    yield { kind: "reasoning", delta: result.reasoning };
  }

  yield { kind: "ui", ui, check, fallback: !parsed.ok };

  yield {
    kind: "phase",
    phase: "ui",
    label: !parsed.ok
      ? // 兜底必须写明：三条本地检查照样全绿，不写会让后续建在没做过设计的界面上
        `界面已设计（兜底）：${summarizeUi(ui)}`
      : check.passed === check.total
        ? `界面已设计：${summarizeUi(ui)}`
        : `界面已产出，但本地检查 ${check.passed}/${check.total} 通过 —— ` +
          `${check.results.find((r) => !r.pass)?.name ?? "有一项没过"}`,
  };
}