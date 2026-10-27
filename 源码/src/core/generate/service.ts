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
import { buildAssemblePrompt, type BuildBatch, type BuildBatchSummary } from "../domain/module-build";
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
  /*
    building —— 并行构建：N 个模块同时开工。

    为什么它是 phase 而不是"又一个 kind"，理由和 arch / ui 逐字相同：
      它也是「一道工序开工了」。加进这个联合之后，
      from-run.ts 的 PHASE_OWNER（穷尽的 Record）会逼着人当场回答
      "这条 phase 算谁的"——答案是 build（第四道工序自己）。

    为什么它和 generating 分开：
      generating 现在指的是"装配那一次调用在写"（第四次调用），
      而 building 指的是"每个模块各写各的（第 N 次调用，同时在飞）"。
      两者混成一个的话，界面上会看到"正在生成"出现两次而分不出
      是并行阶段还是装配阶段 —— 而这一期交付的恰恰是这两段的区别。
  */
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
  /**
   * 并行构建的产出（第四道工序）—— 每个模块各写各的那一批。
   *
   * ── 为什么它是**摘要**而不是完整的 BuildBatch ──
   *   代码片段是产物，归宿是装配提示词与最终 HTML。
   *   事件是要逐条落库、要回放计划层的东西，塞几十 KB 代码进去
   *   只会让每次运行的事件表白白变大，而回放时没有任何一处读它
   *   （详见 domain/module-build.ts 里 BuildBatchSummary 那段）。
   *
   * ── 它承载的信息是"计划层"的：这次并行切了几个、谁成了、谁没成 ──
   *   左侧清单上那批 `build:<模块id>` 的任务点就是由它投影出来的，
   *   失败模块的状态是 failed（见 planning/from-run.ts 的 modulePoints）。
   *   也就是说：**部分失败会被如实呈现**，而不是被这句摘要抹平。
   */
  | { kind: "modules"; batch: BuildBatchSummary }
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
  /**
   * 并行构建的批次（第四道工序的产出）。
   *
   * ── ★ 它是这一期"并行构建"落到实处的唯一入口 ★ ──
   *   传了它，装配那一次调用的用户消息里就会**真的带上各模块写出来的
   *   代码片段**（buildAssemblePrompt），并且产物检查会多跑一条
   *   「模块代码确实进入了产物」的探针，逐模块核对片段在不在最终 HTML 里。
   *   于是"并行构建"从一句口号变成一条可判真假的链路：
   *     架构切模块 → 并行各写一块 → 片段进装配提示词 → 片段进最终产物。
   *
   * ── 不传 = 保持原来的单次调用行为（这一条是硬要求）──
   *   用户消息仍然就是那句原话、检查仍然只有原来那七项、
   *   事件序列一个字节都不变。旧路径（demo-seed、上一轮之前的运行、
   *   没跑架构的降级路径）照样能跑 —— 新特性不许把老路弄坏。
   */
  batch?: BuildBatch | null;
  /**
   * 架构产物。**只用来让装配提示词带上模块名与职责**（人话比 id 有用）。
   * 不传时提示词退化成只写模块 id，功能不受影响。
   */
  arch?: ArchSpec | null;
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
    label:
      input.batch && input.batch.modules.length > 0
        ? // 这次是"装配"：把并行构建出来的 N 份片段拼成一个成品。
          // 说清楚是装配而不是"从头写"，用户才知道前面那次并行不是白跑的
          `正在装配 ${input.batch.modules.length} 个模块的产出`
        : input.effort === "none"
          ? "正在生成（不思考）"
          : "正在生成",
  };

  /*
    ---------- 装配那一次的输入 ----------
    ★ 这一段就是"模块产出真的喂给最终产物"的兑现点 ★

    没有 batch 时，用户消息就是那句原话（一字不改）——
    这正是改动之前的行为，一个字节都没变。
    有 batch 时，原话仍然在最前面（它是这次运行的起点），
    后面接上各模块真的写出来的 html / css / js 片段（超长会掐尾，
    见 buildAssemblePrompt 里那段：掐尾不掐头，特征片段都在开头）。
  */
  const userContent = input.batch
    ? buildAssemblePrompt({
        prompt: input.prompt,
        batch: input.batch,
        arch: input.arch ?? undefined,
      })
    : input.prompt;

  /*
    ---------- 调用模型，边收边转发 ----------
    ⚠️ 截断了就**加倍预算重来一次** —— 与并行构建同一套策略
       （常数怎么来的、为什么只重试一次，见 truncation-retry.ts）。

    ── 为什么这里自己写循环，而不是用那个助手 ──
      装配走的是 stream()，助手只包 complete()。而流式的重试必须**另起一段**：
      第一次那半截正文已经推到界面上了，直接再来一遍会和它拼成一段
      前后矛盾的文字。所以两次之间发一条 phase 事件，界面据此新开一块，
      读起来就是"第一次顶满了 → 重来一次 → 这次作数"。
  */
  const messages: ModelMessage[] = [
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
    { role: "user", content: userContent },
  ];

  let budget = input.maxOutputTokens ?? GENERATE_MAX_OUTPUT_TOKENS;
  /** 最多试几次：一次原调用 + 一次加倍重试 */
  const MAX_ATTEMPTS = 2;
  /** 作数的那一次的结果（最后一次成功拿到的） */
  let result: Awaited<ReturnType<ModelPort["complete"]>> | null = null;
  /** 累计用量与花费（**含被重试掉的那一次**） */
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
      这一次要不要重试：截断了、**还有下一次**、而且加倍之后确实还能更大。

      ⚠️ `attempt < MAX_ATTEMPTS` 这一条不能省 —— 少了它就会出现一句**空话**：
         最后一次尝试仍然截断时，事件里会写着"已加倍到 N 重新装配"，
         而循环到此为止，那次装配根本没发生。
         这是强制截断实验抓出来的（事件里连写两条"重新装配"，
         账上却只有两次调用）。说出去的话，必须是真发生过的事。
    */
    const nextBudget = attemptResult.truncated
      ? Math.min(budget * 2, MAX_OUTPUT_TOKENS_CEILING)
      : 0;
    const willRetry =
      attempt < MAX_ATTEMPTS && attemptResult.truncated && nextBudget > budget;

    /*
      ---------- 记账：先记事实，再管结果 ----------
      每一次调用各记一行 —— **含被重试掉的那一次**。
      它没产出可用的东西，但钱是真花掉的，而且往往是更贵的那一次
      （思考把预算吃光才会被截断）。不记的话，这条运行的账会比实际少，
      而对账要等到事后才发现。

      ⚠️ 记账放在**循环里**（而不是等循环结束再一起记）：
         第二次调用可能直接抛错，那时如果还没记，第一次那笔钱就丢了。
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

    /*
      说清楚"上一次不算数"：不说的话，界面上会并排出现两段正文，
      用户不知道哪一段是成品 —— 而产物是从**后一段**里抽出来的。
    */
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
    ⚠️ 模块那几笔**不在这里记**。
       编排层（route.ts）拿到 batch 之后，已经用每一次模块调用的
       usage / model / latencyMs 各记了一行流水（含失败的那几次 ——
       调用成功、解析失败的那一类**也是花了钱的**），并把总额并进
       传进来的 spentCny。在这里再记一遍就是重复记账：
       runs.totalCostCny 会凭空多出一倍，而对账要到事后才发现。
       所以上面那两笔是「(已含模块调用的) spent + 装配这一次（含重试）」。
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

  /* ---------- 产物检查 ---------- */
  yield { kind: "phase", phase: "checking", label: "正在检查产物" };
  const html = extractHtml(result.text);
  /*
    把 batch 交给检查器：有并行构建时它多跑一条「模块代码确实进入了产物」，
    逐模块核对特征片段在不在最终 HTML 里（见 generate/prompt.ts 里那条探针）。
    没有 batch 时它**一项都不多** —— 旧路径的 passed/total 一个字不变。
  */
  const results = inspectArtifact(html, { batch: input.batch });
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