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
import type { ArchSpec } from "../domain/arch";
import type { AppSpec, SpecGate } from "../domain/spec";
import type { UiSpec } from "../domain/ui-spec";
import type { ArchCheck } from "./arch-check";
import type { UiCheck } from "./ui-check";
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
  | "spec" // 规格化：把一句话需求整理成结构化规格
  /*
    arch —— 架构定型：把规格切成模块。
    ── 为什么它是 phase 而不是"又一个 kind" ──
      它和 spec 是同一类东西：一道工序**开工了**。
      这个联合里的每个值都对应"哪一道工序在动"，而 from-run.ts 的
      PHASE_OWNER 是个穷尽的 Record —— 加一个值，编译器就会逼着
      在那里当场回答"这条 phase 算谁的"。写成一个只出现在 kind 上的
      新事件的话，工序归属就得靠别处再判一次，两处迟早漂开。
  */
  | "arch" // 架构定型：把规格切分成模块并定下依赖
  /*
    ui —— 界面设计：把架构变成页面与设计变量。
    理由和 arch 一模一样：它也是「一道工序开工了」，
    而 from-run.ts 的 PHASE_OWNER 是个穷尽的 Record —— 加一个值，
    编译器就会逼着人在那里当场回答"这条 phase 算谁的"。
  */
  | "ui" // 界面设计：定下设计变量、页面与组件
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
       * 这条 phase 事件是干什么的。
       *
       * ── 为什么需要一个标记位，而不是让界面去认那句话 ──
       *   回流（07）说的是「带上了上一轮没过的 N 项检查」。
       *   界面要把它**留在一个固定的地方**，而不是让它被后面
       *   一串 phase 事件一路顶掉 —— 那样用户回头看时，
       *   唯一能证明"回流真的发生了"的东西就没了。
       *
       *   而靠 `label.includes("别再犯")` 去认是极脆的：
       *   改一个字，回流就静默失效，而且没有任何测试会红。
       *
       * 只有 "callback" 一种取值 —— 别的 phase 不需要这个。
       * 需要第二种时再加，不要提前造一个开放字符串。
       */
      note?: "callback";
    }
  /** 思考片段。前端逐段追加即可，不需要自己拼接 */
  | { kind: "reasoning"; delta: string }
  /** 正文片段 */
  | { kind: "text"; delta: string }
  /**
   * 规格化阶段的产出。
   *
   * 为什么要单独一种事件而不是塞进 phase 的文案里：
   *   规格是这个产品最该被看见的东西 —— 它决定了后面所有工序
   *   拿什么当判定依据。用户要能逐条读到「它把我的需求理解成了什么」，
   *   而不是只看到一句「规格已就绪」。
   */
  | {
      kind: "spec";
      spec: AppSpec;
      gate: SpecGate;
      /** 是不是降级来的。界面必须能区分，否则会把兜底当成真规格 */
      fallback: boolean;
    }
  /**
   * 架构定型阶段的产出（第二道工序）。
   *
   * 和 spec 事件同构，多带一个 check：那三条本地检查的结果
   * 是**跟着产物一起发出来的** —— 左侧清单上那些模块任务点的状态
   * 直接由它决定（全过 → done，有不过的 → failed，见 planning/from-run.ts）。
   * 让界面各算一遍的话，同一件事就有两个口径了。
   */
  | {
      kind: "arch";
      arch: ArchSpec;
      check: ArchCheck;
      /** 是不是降级来的。兜底架构必须自报家门 */
      fallback: boolean;
    }
  /**
   * 界面设计阶段的产出（第三道工序）。
   *
   * 和 arch 事件同构：那三条本地检查的结果**跟着产物一起发出来** ——
   * 左侧清单上那些页面任务点的状态直接由它决定
   * （全过 → done，有不过的 → failed，见 planning/from-run.ts）。
   * 让界面各算一遍的话，同一件事就有两个口径了。
   */
  | {
      kind: "ui";
      ui: UiSpec;
      check: UiCheck;
      /** 是不是降级来的。兜底界面必须自报家门 */
      fallback: boolean;
    }
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
  /**
   * 回流上下文：上一轮没过的地方（任务 07 回流）。
   *
   * ── 为什么是调用方拼好了传进来，而不是内核自己去捞 ──
   *   内核是纯逻辑，不碰数据库。而且"上一轮"这个概念只有编排层
   *   才知道（它管着这条运行的生命周期），内核不该去猜。
   *
   * 不传就是没有上一轮 —— 这时**不加那条消息**。
   * 加一条空消息会白白多花 token，还会让模型以为有什么言外之意。
   */
  callbackContext?: string | null;
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
        /*
          回流（任务 07）。

          ── 为什么单独一条 system 消息，而不是拼进用户那句话 ──
            拼进去的话，用户的原话就被改了 ——
            而那句话是这次运行的**起点**（run.prompt 里存着原文），
            改了之后"模型看到的"和"记录里存的"就不是一回事了。

          ── 为什么放在用户那句话前面 ──
            它是**背景**，不是这次的诉求。
            放在后面会让模型把它当成新的指令，冲淡用户真正想要的东西。
        */
        ...(input.callbackContext
          ? [{ role: "system" as const, content: input.callbackContext }]
          : []),
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