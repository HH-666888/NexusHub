/**
 * 界面设计阶段 —— 六道工序的第三道，实际执行
 * ============================================================
 * 一次模型调用：把**已经定型的架构**变成页面与设计变量，写盘成 ui-spec.json。
 *
 * ── 为什么整段是照着 arch-stage.ts 写的 ──
 *   两道工序干的是同一件事的两步：都是「一次决策级调用 → 一个结构化 JSON 产物」。
 *   同一件事就该只有一套写法 —— 预算闸门、两条路径都落盘、先记账再解析、
 *   降级用 fallback 标出来，这四条在三道工序上必须逐条一致。
 *   抄一份新写法的话，迟早出现"架构那道超预算会拦住、界面这道却先花钱"
 *   这种只有对账时才看得出来的差别。
 *
 * ── 输入为什么比上一道还多一份 ──
 *   这一道的第三条验收标准是「页面用到的数据都能在接口契约里找到」，
 *   能拿来判的东西只有架构里的模块（见 generate/ui-check.ts 里那段说明）。
 *   所以 spec 与 arch 两样都得在手上：spec 判第一条（无孤儿功能），
 *   arch 判第三条（数据需求指得到模块）。
 *
 * ── 为什么失败时降级而不是让整条流水线挂掉 ──
 *   和规格化、架构定型同一条理由：模型偶发返回不可解析的内容是常态。
 *   降级成一个"单页 + 一套最小变量"的兜底界面之后，产物照样能出 ——
 *   而且**它不假装自己设计过**：名字里就写着这是兜底。
 *
 * ── 三条本地检查在这里算，不在别处算 ──
 *   检查结果（UiCheck）是**跟着 ui 事件一起发出去的**，
 *   于是清单上那些页面任务点的状态（全过 → done，有不过的 → failed）
 *   有唯一的来源，而不是界面各算一遍。
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

/* ============================================================
   事件
   ============================================================ */

export type UiStageEvent =
  | { kind: "phase"; phase: "ui"; label: string }
  /** 用量与花费。与前两道的事件同构，便于统一记账 */
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
      /** 是不是降级来的。界面必须能区分，否则会把兜底当成真设计 */
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
  /** 第一条检查（每条功能都有页面）就靠它 */
  spec: AppSpec;
  /** 第三条检查（数据需求对得上模块）就靠它 */
  arch: ArchSpec;
  /** 这次界面设计最多花多少（元）。超了就不发起调用 */
  costLimitCny: number;
  /** 已经花掉的钱，由调用方查出后传入，让内核保持无状态 */
  spentCny?: number;
  maxOutputTokens?: number;
}

/**
 * 界面设计 JSON 比架构还要长一点（变量表 + 页面 + 组件三块），
 * 但也一样没必要给太多：3000 够写 6 个页面 + 12 个组件，
 * 再多的输出只会被截断，而截断的 JSON 解析不出来。
 */
export const UI_MAX_OUTPUT_TOKENS = 3000;

/**
 * 界面设计阶段的产文件名。与 stages.ts 里的声明一致 ——
 * 两处写死同一个字符串是有风险的，但测试会守住它们一致。
 */
export const UI_ARTIFACT_NAME = "ui-spec.json";

/* ============================================================
   执行
   ============================================================ */

export async function* runUiStage(
  deps: UiStageDeps,
  input: UiStageInput,
): AsyncIterable<UiStageEvent> {
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

  yield { kind: "phase", phase: "ui", label: "正在把架构变成页面与设计变量" };

  let raw = "";
  let result: Awaited<ReturnType<ModelPort["complete"]>> | null = null;

  /**
   * 落盘 ui-spec.json。
   *
   * 抽成函数是因为**两条路径都要落盘** —— 正常拿到的界面要落，
   * 降级出来的兜底界面也要落。
   * （spec-stage.ts 第一版只在正常路径落了盘，是单元测试发现的；
   *   架构那道从一开始就把这件事做对，这一道照它。）
   */
  async function persistUi(ui: UiSpec): Promise<string | null> {
    try {
      await artifacts.save({
        runId: input.runId,
        kind: "json",
        // 和 spec.json / arch.json 同一套路径约定：<运行id>/<文件名>
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
      tier: "decide", // 定变量表与页面划分是判断类任务，不是写码
      messages: [
        { role: "system", content: UI_SYSTEM_PROMPT },
        { role: "user", content: buildUiPrompt(input.prompt, input.spec, input.arch) },
      ],
      responseFormat: "json",
      maxOutputTokens: input.maxOutputTokens ?? UI_MAX_OUTPUT_TOKENS,
    });
    raw = result.text;
  } catch (err) {
    // 调用本身失败：一样要出界面，否则后面几道没有可并行的界面单元
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
      /*
        ★ 兜底产出必须自报家门 ★
        这个 true 是界面上区分"真设计"与"兜底界面"的唯一依据；
        写死成 false 的话，用户会把一个没设计过的兜底当成界面决策。
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
    // 累计值写在 runs 上，流水写在 cost_records 上 ——
    // 调用方（编排层）紧接着还会再查一次 totalByRun，
    // 好让第四道拿到的 spentCny 已经含上这一笔
    await runs.update(input.runId, {
      totalCostCny: spent + result.costCny,
      usage: result.usage,
    });
  } catch {
    // 记账失败不影响主流程 —— 和另两道同一个取舍
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

  /*
    检查算在这里，而且**兜底的那份也要算** ——
    兜底界面同样要经得起这三条：它一个页面承接全部功能、只引用自己定义的变量、
    声明需要每个模块的数据，三条照样是绿的，那是实话（这一版确实没做设计决策）。
    检查失败不影响流程往下走：第三道没有人工门禁（stages.ts 里 humanGate 只有 spec 有），
    结果通过 ui 事件如实展示，并且在清单上决定那批页面点的状态。
  */
  const check = inspectUi(ui, input.spec, input.arch);

  // ---------- 落盘 ----------
  /*
    写盘失败**不降级**：界面已经拿到了，而且在事件里发出去了。
    写不下去只是"这次的过程产物少了一份"，不该让阶段判定为失败。
    但要说出来 —— 静默丢产物是最难查的一类问题。
  */
  const saveErr = await persistUi(ui);
  if (saveErr) {
    yield {
      kind: "error",
      message: `界面设计已产出，但写入 ${UI_ARTIFACT_NAME} 失败：${saveErr}`,
      hint: "产物目录可能不可写；界面本身仍可用于后续阶段",
    };
  }

  yield { kind: "ui", ui, check, fallback: !parsed.ok };

  yield {
    kind: "phase",
    phase: "ui",
    label:
      check.passed === check.total
        ? `界面已设计：${summarizeUi(ui)}`
        : `界面已产出，但本地检查 ${check.passed}/${check.total} 通过 —— ` +
          `${check.results.find((r) => !r.pass)?.name ?? "有一项没过"}`,
  };
}