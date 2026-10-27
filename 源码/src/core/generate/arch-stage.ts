/**
 * 架构定型阶段 —— 六道工序的第二道，实际执行
 * ============================================================
 * 一次模型调用：把**已经定好的规格**切成模块，写盘成 arch.json。
 *
 * ── 为什么整段是照着 spec-stage.ts 写的 ──
 *   两道工序干的是同一件事的两步：都是「一次决策级调用 → 一个结构化 JSON 产物」。
 *   同一件事就该只有一套写法 —— 预算闸门、两条路径都落盘、先记账再解析、
 *   降级用 fallback 标出来，这四条在两道工序上必须逐条一致。
 *   抄一份新写法的话，迟早出现"规格那道超预算会拦住、架构这道却先花钱"
 *   这种只有对账时才看得出来的差别。
 *
 * ── 输入为什么要带上整份规格 ──
 *   `stages.ts:215` 写着这一阶段「看什么数：上一阶段的产物」。
 *   架构不是自由创作：它的第一条验收标准就是
 *   「规格里每条功能都能映射到至少一个模块」——
 *   要判这一条，规格必须在手上。所以这里的输入比 spec 那一道多一个 spec 字段。
 *
 * ── 为什么失败时降级而不是让整条流水线挂掉 ──
 *   和规格那一道同一条理由：模型偶发返回不可解析的内容是常态。
 *   因为一次解析失败就把整条流水线判死，代价太大。
 *   降级成一个"单模块"的兜底架构之后，产物照样能出 ——
 *   而且**它不假装自己切过模块**：名字里就写着这是兜底。
 *
 * ── 三条本地检查在这里算，不在别处算 ──
 *   检查结果（ArchCheck）是**跟着 arch 事件一起发出去的**，
 *   于是清单上那些任务点的状态（全过 → done，有不过的 → failed）
 *   有唯一的来源，而不是界面各算一遍。
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

/* ============================================================
   事件
   ============================================================ */

export type ArchStageEvent =
  | { kind: "phase"; phase: "arch"; label: string }
  /** 用量与花费。与规格化、生成两个阶段的事件同构，便于统一记账 */
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
      /** 是不是降级来的。界面必须能区分，否则会把兜底当成真架构 */
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
  /** 架构必须建立在真规格上 —— 第一道检查（无孤儿需求）就靠它 */
  spec: AppSpec;
  /** 这次架构定型最多花多少（元）。超了就不发起调用 */
  costLimitCny: number;
  /** 已经花掉的钱，由调用方查出后传入，让内核保持无状态 */
  spentCny?: number;
  maxOutputTokens?: number;
}

/**
 * 架构 JSON 比规格要长一些（模块 + 依赖 + 归属），但也没必要给太多：
 * 3000 够写 6 个模块，再多的输出只会被截断，而截断的 JSON 解析不出来。
 */
export const ARCH_MAX_OUTPUT_TOKENS = 3000;

/**
 * 架构定型阶段的产文件名。与 stages.ts 里的声明一致 ——
 * 两处写死同一个字符串是有风险的，但测试会守住它们一致。
 */
export const ARCH_ARTIFACT_NAME = "arch.json";

/* ============================================================
   执行
   ============================================================ */

export async function* runArchStage(
  deps: ArchStageDeps,
  input: ArchStageInput,
): AsyncIterable<ArchStageEvent> {
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

  yield { kind: "phase", phase: "arch", label: "正在把规格切分成模块" };

  let raw = "";
  let result: Awaited<ReturnType<ModelPort["complete"]>> | null = null;

  /**
   * 落盘 arch.json。
   *
   * 抽成函数是因为**两条路径都要落盘** —— 正常拿到的架构要落，
   * 降级出来的兜底架构也要落。spec-stage.ts 第一版只在正常路径落了盘，
   * 是单元测试（断言 h.saved 长度为 1、实际是 0）发现的。
   * 这一道从一开始就把这件事做对。
   */
  async function persistArch(arch: ArchSpec): Promise<string | null> {
    try {
      await artifacts.save({
        runId: input.runId,
        kind: "json",
        // 和 spec.json / index.html 同一套路径约定：<运行id>/<文件名>
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
      tier: "decide", // 切模块是判断类任务，不是写码
      messages: [
        { role: "system", content: ARCH_SYSTEM_PROMPT },
        { role: "user", content: buildArchPrompt(input.prompt, input.spec) },
      ],
      responseFormat: "json",
      maxOutputTokens: input.maxOutputTokens ?? ARCH_MAX_OUTPUT_TOKENS,
    });
    raw = result.text;
  } catch (err) {
    // 调用本身失败：一样要出架构，否则后面几道没有并行单元可用
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
      /*
        ★ 兜底产出必须自报家门 ★
        这个 true 是界面上区分"真架构"与"兜底架构"的唯一依据；
        写死成 false 的话，用户会把一个没切过模块的兜底当成架构决策。
      */
      fallback: true,
    };
    return;
  }

  // ---------- 先记账 ----------
  // 钱已经花了，无论后面解析成不成功都得记
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
    // 累计值写在 runs 上，流水写在 cost_records 上 ——
    // 调用方（编排层）紧接着还会再查一次 totalByRun，
    // 好让第四道拿到的 spentCny 已经含上这一笔
    await runs.update(input.runId, {
      totalCostCny: spent + result.costCny,
      usage: result.usage,
    });
  } catch {
    // 记账失败不影响主流程 —— 和另两个阶段同一个取舍
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

  /*
    检查算在这里，而且**兜底的那份也要算** ——
    兜底架构同样要经得起这三条：它用一个模块承接全部功能，
    「无孤儿需求」照样是绿的，那是实话（这一版确实没切分）。
    检查失败不影响流程往下走：第二道没有人工门禁（stages.ts 里的 humanGate 只有 spec 有），
    结果通过 arch 事件如实展示，并且在清单上决定那批模块点的状态。
  */
  const check = inspectArch(arch, input.spec);

  // ---------- 落盘 ----------
  /*
    写盘失败**不降级**：架构已经拿到了，而且在事件里发出去了。
    写不下去只是"这次的过程产物少了一份"，不该让阶段判定为失败。
    但要说出来 —— 静默丢产物是最难查的一类问题。
  */
  const saveErr = await persistArch(arch);
  if (saveErr) {
    yield {
      kind: "error",
      message: `架构已产出，但写入 ${ARCH_ARTIFACT_NAME} 失败：${saveErr}`,
      hint: "产物目录可能不可写；架构本身仍可用于后续阶段",
    };
  }

  yield { kind: "arch", arch, check, fallback: !parsed.ok };

  yield {
    kind: "phase",
    phase: "arch",
    label:
      check.passed === check.total
        ? `架构已定型：${summarizeArch(arch)}`
        : `架构已产出，但本地检查 ${check.passed}/${check.total} 通过 —— ` +
          `${check.results.find((r) => !r.pass)?.name ?? "有一项没过"}`,
  };
}