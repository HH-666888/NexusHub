/**
 * 规格化阶段 —— 六道工序的第一道，实际执行
 * ============================================================
 * 一次模型调用：把用户那一句话变成结构化规格，写盘成 spec.json。
 *
 * ── 为什么这个阶段用 complete 而不是 stream ──
 *   流式的价值在于「让用户看着字一个个出现，确认它没跑偏」。
 *   规格化产出的是一个 JSON 对象，逐字蹦出来反而看不清结构，
 *   而且中途的半截 JSON 没有任何意义。
 *   这一步用户真正想看的是**结果**：它到底理解成了什么。
 *
 * ── 为什么失败时降级而不是让整条流水线挂掉 ──
 *   模型偶发返回不可解析的内容是常态。因为一次解析失败就
 *   把用户的一句话需求整体判死，代价太大。
 *   降级成兜底规格之后，产物照样能出，只是验收标准退回到
 *   几条通用的硬检查 —— 而且这件事在界面上看得见。
 *
 * ── 记账顺序：先记账，再解析 ──
 *   和生成阶段同一个道理：钱花出去是已经发生的事实，
 *   无论后面解析成不成功都要记。晚一步就可能漏账。
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

/* ============================================================
   事件
   ============================================================ */

export type SpecStageEvent =
  | { kind: "phase"; phase: "spec"; label: string }
  /** 非流式调用拿到的思考过程。complete() 一次性返回，所以整段一次给出 */
  | { kind: "reasoning"; delta: string }
  /** 用量与花费。与生成阶段的事件同构，便于统一记账 */
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
      /** 是不是降级来的。界面必须能区分，否则会把兜底当成真规格 */
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
  /** 这次规格化最多花多少（元）。超了就不发起调用 */
  costLimitCny: number;
  /** 已经花掉的钱，由调用方查出后传入，让内核保持无状态 */
  spentCny?: number;
  maxOutputTokens?: number;
}

/**
 * 规格 JSON 的输出预算。
 *
 * ── 为什么从 2000 提到 4000、再跟着并行构建一起提到 6000（真实运行实测，不是拍的）──
 *   这一道走的是 `tier: "decide"`，而 decide 档**默认开思考**
 *   （适配器 DEFAULT_EFFORT.decide = "high"）。而**思考 token 计入
 *   max_tokens** —— 适配器文件头第 ① 条写的就是这件事。
 *   于是 2000 里真正留给 JSON 的只有「2000 减去这一次思考了多少」，
 *   而思考长度是浮动的：
 *     · 一次真实运行：思考 1175 + 正文 827 → 输出 2002 被截断，
 *       JSON 在 position 1386 处断掉 → 解析失败 → 降级成兜底规格；
 *     · 同一句 prompt 再跑一次：思考 631 → 输出 1600，没截断，解析成功。
 *   也就是说 2000 是个「看运气」的预算：思考一长就退化成兜底规格。
 *   而兜底规格的 questions 是空的 → **人工门禁也不会拦**（它靠 questions
 *   判断），整条流水线会在「规格其实是兜底」的情况下照常跑到成品。
 *   4000 在实测里留出了余量（含 1035 思考的那一次，输出 2037 就写完了）。
 *   再抬到 6000 是因为并行构建那道也开了思考：同一批「思考 + 正文」
 *   的工序从此共用一条余量口径，不再出现"这一道够、那一道看运气"。
 *
 *   之后再调这个数，请连着上面两个数一起看：
 *   **预算是要装下「思考 + JSON」两段的，不是只装 JSON。**
 */
export const SPEC_MAX_OUTPUT_TOKENS = 6000;

/**
 * 规格化阶段的产文件名。与 stages.ts 里的声明一致 ——
 * 两处写死同一个字符串是有风险的，但测试会守住它们一致。
 */
export const SPEC_ARTIFACT_NAME = "spec.json";

/* ============================================================
   执行
   ============================================================ */

export async function* runSpecStage(
  deps: SpecStageDeps,
  input: SpecStageInput,
): AsyncIterable<SpecStageEvent> {
  const { model, artifacts, runs, costs } = deps;

  // ---------- 预算闸门 ----------
  // 宁可在这里拒绝，也不要花完之后才说超了
  const spent = input.spentCny ?? 0;
  if (spent >= input.costLimitCny) {
    yield {
      kind: "error",
      message: `本次运行已花费 ¥${spent.toFixed(4)}，达到上限 ¥${input.costLimitCny.toFixed(2)}`,
      hint: "调高 RUN_COST_LIMIT_CNY，或新开一条构建记录",
    };
    return;
  }

  yield { kind: "phase", phase: "spec", label: "正在把你的需求整理成规格" };

  let raw = "";
  let result: Awaited<ReturnType<ModelPort["complete"]>> | null = null;

  /**
   * 落盘 spec.json。
   *
   * 抽成函数是因为**两条路径都要落盘** —— 正常拿到的规格要落，
   * 降级出来的兜底规格也要落。
   * 第一版只在正常路径落了盘，而 catch 分支里直接 return，
   * 结果是「调用失败时注释写着产物照样出，代码却没写」。
   * 是单元测试发现的：那条用例断言 h.saved 长度为 1，实际是 0。
   */
  async function persistSpec(spec: AppSpec): Promise<string | null> {
    try {
      await artifacts.save({
        runId: input.runId,
        kind: "json",
        // 和 HTML 产物同一套路径约定：<运行id>/<文件名>
        path: `${input.runId}/${SPEC_ARTIFACT_NAME}`,
        content: JSON.stringify(spec, null, 2),
      });
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  try {
    result = await model.complete({
      tier: "decide", // 这是判断类任务，不是写码
      messages: [
        { role: "system", content: SPEC_SYSTEM_PROMPT },
        { role: "user", content: buildSpecPrompt(input.prompt) },
      ],
      responseFormat: "json",
      maxOutputTokens: input.maxOutputTokens ?? SPEC_MAX_OUTPUT_TOKENS,
    });
    raw = result.text;
  } catch (err) {
    // 调用本身失败：一样要出规格，否则整条流水线走不下去
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

  // ---------- 先记账 ----------
  // 钱已经花了，无论解析成不成功都得记
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
    // 累计值写在 runs 上，成本流水写在 cost_records 上 ——
    // 前者回答「一共花了多少」，后者回答「钱花在哪一步」
    await runs.update(input.runId, {
      totalCostCny: spent + result.costCny,
      usage: result.usage,
    });
  } catch {
    // 记账失败不影响主流程 —— 和生成阶段同一个取舍
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

  // ---------- 解析 ----------
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

  // ---------- 落盘 ----------
  /*
    写盘失败**不降级**：规格已经拿到了，用户能看见。
    写不下去只是「这次的过程产物少了一份」，不该让阶段判定为失败。
    但要说出来 —— 静默丢产物是最难查的一类问题。
  */
  const saveErr = await persistSpec(spec);
  if (saveErr) {
    yield {
      kind: "error",
      message: `规格已产出，但写入 ${SPEC_ARTIFACT_NAME} 失败：${saveErr}`,
      hint: "产物目录可能不可写；规格本身仍可用于后续阶段",
    };
  }

  // complete() 的一次性调用也会思考（decide 档默认开），
  // 但思考躺在 ModelResult.reasoning 里没人取 —— 不发出来的话，
  // 界面上"这一步没有返回思考内容"，而模型其实想了。
  // 顺序放在结果事件之前：读起来就是「先想，再给答案」。
  if (result.reasoning.trim().length > 0) {
    yield { kind: "reasoning", delta: result.reasoning };
  }

  yield { kind: "spec", spec, gate, fallback: !parsed.ok };

  yield {
    kind: "phase",
    phase: "spec",
    label: !parsed.ok
      ? // 兜底规格必须自报家门：它没有 questions，能一路通过门禁，
        // 不写明的话整条流水线会在"规格其实是兜底"的情况下跑到成品
        `规格已就绪（兜底）：${summarizeSpec(spec)}`
      : gate.pass
        ? `规格已就绪：${summarizeSpec(spec)}`
        : gate.summary,
  };
}