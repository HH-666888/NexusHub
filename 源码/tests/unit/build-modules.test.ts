import { describe, expect, it } from "vitest";
import { buildModules, resolveConcurrency } from "@/core/generate/build-modules";
import {
  DEFAULT_BUILD_CONCURRENCY,
  MODULE_MAX_OUTPUT_TOKENS,
  MODULE_SYSTEM_PROMPT,
  buildAssemblePrompt,
  moduleSignature,
  parseModuleBuild,
  summarizeBatch,
  summarizeBuildBatch,
  type BuildBatch,
} from "@/core/domain/module-build";
import type { ArchSpec } from "@/core/domain/arch";
import type { AppSpec } from "@/core/domain/spec";
import type { ModelPort, ModelRequest, ModelResult } from "@/core/ports/model";

/**
 * 按模块并行构建：单测
 * ============================================================
 * 这个文件里最要紧的是**第一条**：
 *
 *   ★「真的并发」不是靠读代码看出来的，是靠同时在飞的数量量出来的 ★
 *
 * 串行实现（`for` 里 `await`）也能让所有模块都成功、也能让花费汇总正确 ——
 * 也就是说，只有第一条能把"并行"和"串行"分开。
 * 所以它用一个假 ModelPort 记录"同时在飞的最大值"，
 * 断言它 >1 且 <= 并发上限。
 *
 * 其余的边界按重要性排：
 *   · 上限真的生效（5 个模块、上限 2 → 峰值恰好 2）；
 *   · 单模块失败不拖垮整批，且**失败要留痕**（含它花掉的钱）；
 *   · 全部失败 / 零模块这两个自定口径；
 *   · 每模块的提示词真的带上了它自己的职责、功能条目与依赖；
 *   · 花费汇总把失败的那几次也算进去。
 *
 * ── 一条贯穿全篇的取材原则 ──
 *   模块 id、职责、功能条目都从本文件的夹具里现取，
 *   不手抄产品代码里的字符串 —— 抄一份的话，产品改了而这里没改，
 *   测试会继续绿着，说的却已经是另一件事了。
 */

/* ============================================================
   夹具：规格与架构
   ============================================================ */

const SPEC: AppSpec = {
  prompt: "做一个团队任务看板",
  goal: "小团队共用的任务看板",
  audience: "3-8 人的小团队",
  scenarios: ["新建任务", "拖动改状态"],
  acceptance: [
    { id: "ac-1", statement: "能新建任务", verifyBy: "点新建按钮，卡片出现", level: "must" },
    { id: "ac-2", statement: "能拖动卡片换栏位", verifyBy: "拖到另一栏松手", level: "must" },
    { id: "ac-3", statement: "刷新后数据还在", verifyBy: "按 F5 后位置不变", level: "should" },
  ],
  scope: { inScope: ["看板"], outOfScope: ["多人实时协作"] },
  questions: [],
  model: "fixture",
  generatedAt: 0,
};

/**
 * 造一份 N 个模块的架构。
 *
 * 每个模块的职责里带一句**只有它自己**的文字（`负责第 i 件事`），
 * 依赖指向第 0 个模块 —— 这样提示词那条断言才有东西可查。
 */
function archOf(ids: string[]): ArchSpec {
  return {
    modules: ids.map((id, i) => ({
      id,
      name: `模块${i + 1}·${id}`,
      responsibility: `${id} 负责第 ${i + 1} 件事，别的一概不碰`,
      dependsOn: i === 0 ? [] : [ids[0]],
      coversFeatures: [SPEC.acceptance[i % SPEC.acceptance.length].id],
    })),
    packages: [],
  };
}

/** 模块 id → 驼峰（task-store → taskStore），模块提示词要求的函数名形式 */
function camel(id: string): string {
  return id.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/** 一个"像真的"模块产出：带认领标记、前缀类名、具名函数 */
function moduleJson(id: string, over: Record<string, string> = {}): string {
  return JSON.stringify({
    summary: `${id} 做好了`,
    html: `<section data-module="${id}"><h2>${id}</h2></section>`,
    css: `.${id}-box { color: red; }`,
    js: `function ${camel(id)}Init() { document.title = "${id}"; }`,
    ...over,
  });
}

/* ============================================================
   假 ModelPort
   ------------------------------------------------------------
   它记录三件事，这三件事就是本文件几乎所有断言的依据：
     · calls      —— 每次调用的提示词（验"派工单带上了什么"）
     · inFlight   —— 此刻有几个调用在飞
     · peak       —— 同时在飞的最大值（★ 并行的唯一硬证据 ★）
   ============================================================ */

interface Call {
  moduleId: string;
  system: string;
  user: string;
  tier: string;
  maxOutputTokens?: number;
  effort?: string;
}

interface Plan {
  /** 返回的正文。给了 text 就按 text 走 */
  text?: string;
  /** 直接抛错，模拟调用失败 */
  throws?: string;
  costCny?: number;
  usage?: Partial<ModelResult["usage"]>;
  truncated?: boolean;
  /** 这一次调用模型想的东西（complete() 一次性返回） */
  reasoning?: string;
}

interface Harness {
  model: ModelPort;
  calls: Call[];
  /** 同时在飞的最大值 */
  peak: number;
  /** 每个模块被调用了几次 */
  callsByModule: Map<string, number>;
}

function makeHarness(opts: {
  plan: (call: Call, nth: number) => Plan;
  delayMs?: number;
}): Harness {
  const delayMs = opts.delayMs ?? 3;
  const calls: Call[] = [];
  const callsByModule = new Map<string, number>();
  let inFlight = 0;
  let peak = 0;

  const model: ModelPort = {
    async complete(req: ModelRequest): Promise<ModelResult> {
      const user = typeof req.messages[1]?.content === "string" ? req.messages[1].content : "";
      const system = typeof req.messages[0]?.content === "string" ? req.messages[0].content : "";
      /*
        ⚠️ 模块 id 从提示词里读出来（而不是从调用顺序猜）：
           并发跑的时候"第几次调用"根本不代表"哪个模块" ——
           拿顺序当身份的话，这条测试本身就会因为并发而变得不确定。
      */
      const moduleId = /模块 id：([a-z0-9-]+)/.exec(user)?.[1] ?? "?";
      const nth = (callsByModule.get(moduleId) ?? 0) + 1;
      callsByModule.set(moduleId, nth);

      const call: Call = {
        moduleId,
        system,
        user,
        tier: req.tier,
        maxOutputTokens: req.maxOutputTokens,
        effort: req.effort,
      };
      calls.push(call);

      inFlight++;
      if (inFlight > peak) peak = inFlight;
      try {
        // 让出事件循环：没有这一步，"并发"就退化成了"同步连续执行"，
        // 峰值永远量不出来（而这正是本文件要量的东西）
        await new Promise((r) => setTimeout(r, delayMs));
        const plan = opts.plan(call, nth);
        if (plan.throws) throw new Error(plan.throws);
        return {
          text: plan.text ?? moduleJson(call.moduleId),
          reasoning: plan.reasoning ?? "",
          usage: {
            inputTokens: 100,
            outputTokens: 200,
            reasoningTokens: 0,
            cacheHitTokens: 0,
            cacheMissTokens: 100,
            ...plan.usage,
          },
          costCny: plan.costCny ?? 0.01,
          priceTier: "offPeak",
          model: "fake-model",
          latencyMs: delayMs,
          truncated: plan.truncated ?? false,
          finishReason: "stop",
        };
      } finally {
        inFlight--;
      }
    },
    // 并行构建是"一次拿全 JSON"，不该走流式
    async *stream(): AsyncIterable<never> {
      throw new Error("按模块并行构建不该走流式");
    },
  };

  return {
    model,
    calls,
    get peak() {
      return peak;
    },
    callsByModule,
  };
}

/** 跑一批，返回批次与假端口的观测数据 */
async function run(opts: {
  ids: string[];
  concurrency?: number;
  plan?: (call: Call, nth: number) => Plan;
  delayMs?: number;
  maxOutputTokensPerModule?: number;
  continueOnError?: boolean;
}): Promise<{ batch: BuildBatch; h: Harness }> {
  const h = makeHarness({
    plan: opts.plan ?? (() => ({})),
    delayMs: opts.delayMs,
  });
  const batch = await buildModules(
    { model: h.model },
    {
      prompt: SPEC.prompt,
      spec: SPEC,
      arch: archOf(opts.ids),
      concurrency: opts.concurrency,
      maxOutputTokensPerModule: opts.maxOutputTokensPerModule,
      continueOnError: opts.continueOnError,
    },
  );
  return { batch, h };
}

/* ============================================================
   ① ★ 真的并发 ★（本期核心证据）
   ============================================================ */

describe("★ 真的并发（不是 for 里 await）", () => {
  it("6 个模块、默认上限 → 同时在飞的最大值 >1 且 <= 上限", async () => {
    /*
      ★★★ 这一条是整个特性的硬证据 ★★★

      为什么"模块都成功了""花费对得上"证明不了并行：
        串行实现（for + await）同样能让它们全成功、账也全对。
        唯一能把两者分开的量，是**同一时刻有几个调用在飞**。

      所以这里断言两个方向：
        · peak > 1  —— 真的同时跑过（串行实现会恒等于 1，这一条会红）；
        · peak <= concurrency —— 上限没被突破（无节制的 Promise.all 会红）。
    */
    const ids = ["m-1", "m-2", "m-3", "m-4", "m-5", "m-6"];
    const { batch, h } = await run({ ids });

    expect(batch.concurrency).toBe(DEFAULT_BUILD_CONCURRENCY);
    expect(h.peak, "同时在飞的最大值只有 1 —— 这是串行，不是并行").toBeGreaterThan(1);
    expect(h.peak).toBeLessThanOrEqual(batch.concurrency);
    // 批次自己数出来的峰值也要一致（假端口之外的第二份证据）
    expect(batch.peakInFlight).toBe(h.peak);
    expect(batch.modules).toHaveLength(ids.length);
  });

  it("上限生效：5 个模块、上限 2 → 同时在飞的最大值恰好是 2", async () => {
    /*
      "恰好等于 2"而不是"<=2"：只断言 <=2 的话，
      一个"每次只跑一个"的实现（peak=1）也能过 —— 那等于没验上限生效。
    */
    const { batch, h } = await run({
      ids: ["m-1", "m-2", "m-3", "m-4", "m-5"],
      concurrency: 2,
    });

    expect(h.peak).toBe(2);
    expect(batch.peakInFlight).toBe(2);
    expect(batch.concurrency).toBe(2);
    expect(batch.modules).toHaveLength(5);
  });

  it("上限大于模块数时不会白开 worker：3 个模块、上限 8 → 峰值 3", async () => {
    const { batch } = await run({ ids: ["m-1", "m-2", "m-3"], concurrency: 8 });
    expect(batch.concurrency).toBe(8);
    expect(batch.peakInFlight).toBe(3);
  });

  it("并发上限的归一：<=0 或未给 → 默认值；小数向下取整", () => {
    expect(resolveConcurrency(undefined)).toBe(DEFAULT_BUILD_CONCURRENCY);
    expect(resolveConcurrency(0)).toBe(DEFAULT_BUILD_CONCURRENCY);
    expect(resolveConcurrency(-3)).toBe(DEFAULT_BUILD_CONCURRENCY);
    expect(resolveConcurrency(Number.NaN)).toBe(DEFAULT_BUILD_CONCURRENCY);
    expect(resolveConcurrency(2)).toBe(2);
    // 小数向下取整，但**不会取到 0**：最少是 1（串行），而不是"一个都不跑"。
    // "一个都不跑"会让一次运行安静地什么模块都没构建，
    // 而那种表现看起来像"架构里没有模块"，排查方向完全错。
    expect(resolveConcurrency(1.7)).toBe(1);
    expect(resolveConcurrency(0.4)).toBe(1);
  });

  it("模块顺序按架构顺序回填，与谁先跑完无关", async () => {
    /*
      第一个模块故意最慢。谁先跑完就排前面的话，清单上的顺序每次刷新都会跳 ——
      而"哪个模块对应哪一行"正是用户要对着看的东西。
    */
    const ids = ["slow-one", "m-2", "m-3"];
    const { batch } = await run({
      ids,
      concurrency: 3,
      delayMs: 2,
      plan: (call) => ({ text: moduleJson(call.moduleId) }),
    });
    expect(batch.modules.map((m) => m.moduleId)).toEqual(ids);
  });
});

/* ============================================================
   ② 部分失败：允许，但必须如实记录
   ============================================================ */

describe("单模块失败不拖垮整批（且失败留痕）", () => {
  it("一个模块调用抛错 → 进 failed[]，其余照常成功", async () => {
    const ids = ["m-1", "m-2", "m-3"];
    const { batch, h } = await run({
      ids,
      plan: (call) =>
        call.moduleId === "m-2"
          ? { throws: "连接超时" }
          : { text: moduleJson(call.moduleId) },
    });

    expect(batch.modules.map((m) => m.moduleId)).toEqual(["m-1", "m-3"]);
    expect(batch.failed).toHaveLength(1);
    expect(batch.failed[0].moduleId).toBe("m-2");
    expect(batch.failed[0].message).toContain("连接超时");
    // 抛错的那次调用钱没花出去，如实记 0（而不是不记这一栏）
    expect(batch.failed[0].costCny).toBe(0);
    expect(batch.failed[0].model).toBeNull();
    expect(batch.failed[0].priceTier).toBeNull();
    // 三个模块都被真的调用了 —— 失败没有让谁被跳过
    expect(h.calls).toHaveLength(3);
  });

  it("解析失败也是失败，但**那次调用的钱照样记**（花了就是花了）", async () => {
    /*
      这是最容易被记漏的一类：调用成功、正文却不是 JSON。
      钱已经花出去了，账本上不能因为"产物没法用"就当它没发生。
    */
    const { batch } = await run({
      ids: ["m-1", "m-2"],
      plan: (call) =>
        call.moduleId === "m-2"
          ? { text: "抱歉，我今天不想干活", costCny: 0.037 }
          : { text: moduleJson(call.moduleId), costCny: 0.01 },
    });

    const bad = batch.failed.find((f) => f.moduleId === "m-2");
    expect(bad).toBeDefined();
    expect(bad?.costCny).toBeCloseTo(0.037, 6);
    expect(bad?.model).toBe("fake-model");
    expect(bad?.priceTier).toBe("offPeak");
    expect(bad?.usage.outputTokens).toBe(200);
  });

  it("三段片段全空也算失败：产出没法用，但它照样占一次调用", async () => {
    const { batch } = await run({
      ids: ["m-1"],
      plan: () => ({ text: JSON.stringify({ summary: "我写了个寂寞" }) }),
    });
    expect(batch.modules).toHaveLength(0);
    expect(batch.failed).toHaveLength(1);
    expect(batch.failed[0].message).toContain("都是空的");
  });

  it("多个模块同时失败时逐个记录，不是一个笼统的'有失败'", async () => {
    const { batch } = await run({
      ids: ["m-1", "m-2", "m-3"],
      plan: (call) =>
        call.moduleId === "m-1"
          ? { throws: "限流" }
          : call.moduleId === "m-3"
            ? { text: "{}" }
            : {},
    });
    expect(batch.modules.map((m) => m.moduleId)).toEqual(["m-2"]);
    expect(batch.failed.map((f) => f.moduleId).sort()).toEqual(["m-1", "m-3"]);
    // 失败原因各不相同 —— 合并成一句的话，处置动作就没法分流了
    expect(new Set(batch.failed.map((f) => f.message)).size).toBe(2);
  });

  it("continueOnError=false 时第一个失败中止整批并抛错（默认 true 不受影响）", async () => {
    await expect(
      run({ ids: ["m-1", "m-2"], concurrency: 1, continueOnError: false, plan: () => ({ throws: "炸了" }) }),
    ).rejects.toThrow(/m-1/);
  });
});

/* ============================================================
   ③ 两个自定口径：全部失败 / 零模块
   ============================================================ */

describe("自定口径", () => {
  it("全部失败 → 不抛错，返回 failed.length === 模块数 的批次（口径①）", async () => {
    /*
      口径：**不抛错**。
      抛错会让编排层失去"哪几个失败了、一共花了多少钱"的记录，
      而装配那一步仍然应该跑 —— 把失败摊开给模型看，
      比整条流水线崩掉诚实（见 build-modules.ts 文件头那段）。
    */
    const ids = ["m-1", "m-2", "m-3"];
    const { batch } = await run({
      ids,
      plan: (call) => ({ throws: `${call.moduleId} 挂了` }),
    });

    expect(batch.modules).toEqual([]);
    expect(batch.failed).toHaveLength(ids.length);
    expect(batch.failed.map((f) => f.moduleId)).toEqual(ids);
    // 仍然是"一次真的并行构建"的结果，上限与峰值照样报出来
    expect(batch.concurrency).toBe(DEFAULT_BUILD_CONCURRENCY);
    expect(batch.peakInFlight).toBeGreaterThan(1);
  });

  it("模块数为 0 → 空批次、一次调用都不发（口径②）", async () => {
    const { batch, h } = await run({ ids: [] });

    expect(batch.modules).toEqual([]);
    expect(batch.failed).toEqual([]);
    expect(batch.totalCostCny).toBe(0);
    expect(batch.peakInFlight).toBe(0);
    expect(batch.wallClockMs).toBe(0);
    // 没有可并行的单元就不该花钱
    expect(h.calls).toHaveLength(0);
  });
});

/* ============================================================
   ④ 每模块的派工单（提示词真的带上了它自己的那一份）
   ============================================================ */

describe("每模块的提示词：带上了它自己的职责、功能条目与依赖", () => {
  it("职责写的是**这个模块**的，而不是别的模块的", async () => {
    const ids = ["task-store", "board-ui"];
    const { h } = await run({ ids, concurrency: 1 });

    const storeCall = h.calls.find((c) => c.moduleId === "task-store");
    const boardCall = h.calls.find((c) => c.moduleId === "board-ui");
    expect(storeCall?.user).toContain("task-store 负责第 1 件事");
    expect(boardCall?.user).toContain("board-ui 负责第 2 件事");
    // 反向断言：它不该看到别人的职责（看到了就会顺手把别人的也写了）
    expect(storeCall?.user).not.toContain("board-ui 负责第 2 件事");
  });

  it("带上了用户原话、它覆盖的功能条目、它依赖的模块", async () => {
    const ids = ["task-store", "board-ui"];
    const { h } = await run({ ids, concurrency: 1 });

    const boardCall = h.calls.find((c) => c.moduleId === "board-ui");
    const user = boardCall?.user ?? "";

    expect(user).toContain(SPEC.prompt); // 用户原话，一字不改
    // 它覆盖的功能条目（架构里 coversFeatures 指到的那条）
    expect(user).toContain("ac-2");
    expect(user).toContain(SPEC.acceptance[1].statement);
    // 它依赖的模块：名字与职责都在，写清楚才知道自己不该重造什么
    expect(user).toContain("task-store");
    expect(user).toContain("task-store 负责第 1 件事");
    // 还写明了它是第几个（并行派工的基本信息）
    expect(user).toContain("第 2 个");
  });

  it("系统提示词用的是并行构建那一份，不是整页生成那一份", async () => {
    const { h } = await run({ ids: ["m-1"] });
    expect(h.calls[0].system).toBe(MODULE_SYSTEM_PROMPT);
    // 单模块提示词必须把"只写你这一块"说死，否则并行会退化成 N 份整页
    expect(MODULE_SYSTEM_PROMPT).toContain("你只负责");
  });

  /*
    ⚠️ 这条断言的是"**修法 3 之后**"的行为，不是旧行为。
    它以前写的是 toBe("none")：那时候并行构建刻意关着思考，
    依据是一次实测（关思考 18.5 秒出 23.9 KB、8 项检查全过）。
    但那个结论有两个问题：并行构建是创造性写码（要决定怎么切、怎么留接口），
    而且真实运行里 build 的 5 次调用 reasoning_tokens 全是 0 ——
    界面上那一步的「思考」tab 永远是"没有返回思考内容"，
    而"看得见的思考"正是这个产品的卖点。
    所以修法 3 把它刻意改成了 "high"，这条测试跟着改，
    并在名字里写明是刻意改的 —— 免得下一个人以为是笔误又改回去。
  */
  it("调用参数：执行级、**开思考（修法 3 刻意改的行为）**、预算用 MODULE_MAX_OUTPUT_TOKENS", async () => {
    const { h } = await run({ ids: ["m-1"] });
    expect(h.calls[0].tier).toBe("execute");
    expect(h.calls[0].effort).toBe("high");
    expect(h.calls[0].maxOutputTokens).toBe(MODULE_MAX_OUTPUT_TOKENS);
  });
});

/* ============================================================
   ⑤ 记账
   ============================================================ */

describe("花费汇总", () => {
  it("总额 = 各模块花费之和，**含失败的那几次**", async () => {
    const { batch } = await run({
      ids: ["m-1", "m-2", "m-3"],
      plan: (call) =>
        call.moduleId === "m-1"
          ? { costCny: 0.01 }
          : call.moduleId === "m-2"
            ? { costCny: 0.02 }
            : { throws: "挂了" }, // 这次没花钱
    });

    expect(batch.modules.reduce((n, m) => n + m.costCny, 0)).toBeCloseTo(0.03, 6);
    expect(batch.totalCostCny).toBeCloseTo(0.03, 6);
  });

  it("解析失败那笔钱也进总额 —— 只算成功模块的话账会少", async () => {
    const { batch } = await run({
      ids: ["m-1", "m-2"],
      plan: (call) =>
        call.moduleId === "m-1" ? { costCny: 0.01 } : { text: "不是 JSON", costCny: 0.05 },
    });

    expect(batch.totalCostCny).toBeCloseTo(0.06, 6);
    expect(batch.failed[0].costCny).toBeCloseTo(0.05, 6);
  });

  it("token 用量逐次累加，失败的那次也在里面", async () => {
    const { batch } = await run({
      ids: ["m-1", "m-2", "m-3"],
      plan: (call) =>
        call.moduleId === "m-2"
          ? { text: "不是 JSON", usage: { inputTokens: 7, outputTokens: 8 } }
          : { usage: { inputTokens: 100, outputTokens: 200 } },
    });

    // 100 + 7 + 100
    expect(batch.totalUsage.inputTokens).toBe(207);
    expect(batch.totalUsage.outputTokens).toBe(408);
  });

  it("每次调用的用量/模型/档位/耗时都带在模块上，编排层才能如实记流水", async () => {
    const { batch } = await run({ ids: ["m-1"] });
    const m = batch.modules[0];
    expect(m.usage.inputTokens).toBe(100);
    expect(m.model).toBe("fake-model");
    expect(m.priceTier).toBe("offPeak");
    expect(m.latencyMs).toBeGreaterThanOrEqual(0);
    expect(m.truncated).toBe(false);
  });

  it("截断标记原样带出来（那是预算问题不是能力问题，界面要说清楚）", async () => {
    const { batch } = await run({ ids: ["m-1"], plan: () => ({ truncated: true }) });
    expect(batch.modules[0].truncated).toBe(true);
  });
});

/* ============================================================
   ⑥ 摘要与特征片段：给事件、给产物检查用的那两个函数
   ============================================================ */

describe("摘要与特征片段", () => {
  it("summarizeBatch 的模块名从 arch 查，不是从事件里抄", async () => {
    const ids = ["task-store", "board-ui"];
    const { batch } = await run({
      ids,
      plan: (call) => ({ text: moduleJson(call.moduleId) }),
    });
    const summary = summarizeBatch(batch, archOf(ids));

    expect(summary.modules.map((m) => m.name)).toEqual(["模块1·task-store", "模块2·board-ui"]);
    expect(summary.concurrency).toBe(DEFAULT_BUILD_CONCURRENCY);
    expect(summary.peakInFlight).toBe(batch.peakInFlight);
    expect(summary.totalCostCny).toBeCloseTo(batch.totalCostCny, 6);
  });

  it("一句话摘要里同时说清模块数、并发与实际峰值、成功与失败", async () => {
    const { batch } = await run({
      ids: ["m-1", "m-2", "m-3"],
      concurrency: 2,
      plan: (call) => (call.moduleId === "m-3" ? { throws: "挂了" } : {}),
    });
    const line = summarizeBuildBatch(batch);

    expect(line).toContain("3 个模块");
    expect(line).toContain("并发 2");
    expect(line).toContain("实际同时在飞 2");
    expect(line).toContain("成功 2");
    expect(line).toContain("失败 1（m-3）");
  });

  it("特征片段优先取 data-module 认领标记（那是提示词强制要求的那一个）", () => {
    expect(
      moduleSignature({
        moduleId: "task-store",
        html: `<section data-module="task-store"></section>`,
        css: ".task-store-box{color:red}",
        js: "function taskStoreInit(){}",
      }),
    ).toBe('data-module="task-store"');
  });

  it("标记丢了还有第二、第三道：函数名 / 类选择器（不让无害改写把检查弄红）", () => {
    expect(
      moduleSignature({
        moduleId: "task-store",
        html: "<section></section>",
        css: ".task-store-box{color:red}",
        js: "function taskStoreInit(){}",
      }),
    ).toBe("taskStoreInit");

    expect(
      moduleSignature({ moduleId: "task-store", html: "<section></section>", css: ".task-store-box{}", js: "" }),
    ).toBe(".task-store-box");
  });

  it("三段都提不出特征时返回 null（那是'无法判断'，不是'通过'）", () => {
    expect(moduleSignature({ moduleId: "x", html: "", css: "", js: "" })).toBeNull();
  });

  it("parseModuleBuild 缺 summary 时给一句实话，而不是编一句'已完成'", () => {
    const parsed = parseModuleBuild("m-1", JSON.stringify({ html: "<section></section>" }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.build.summary).toContain("没有给出摘要");
      expect(parsed.build.html).toBe("<section></section>");
      expect(parsed.build.moduleId).toBe("m-1");
    }
  });
});

/* ============================================================
   ⑦ 装配提示词：模块产出真的被喂了进去
   ============================================================ */

describe("装配提示词带上了各模块的代码片段", () => {
  it("每个模块的 html / css / js 都真的在提示词里，且标明是哪个模块", async () => {
    const ids = ["task-store", "board-ui"];
    const { batch } = await run({
      ids,
      plan: (call) => ({ text: moduleJson(call.moduleId) }),
    });

    const prompt = buildAssemblePrompt({ prompt: SPEC.prompt, batch, arch: archOf(ids) });

    expect(prompt).toContain(SPEC.prompt);
    ids.forEach((id, i) => {
      expect(prompt).toContain(`data-module="${id}"`);
      expect(prompt).toContain(`.${id}-box`);
      expect(prompt).toContain(`${camel(id)}Init`);
      // 每一段都标明了是"第几个/共几个：哪个模块"——装配时认领的依据
      expect(prompt).toContain(`${i + 1}/${ids.length}：${id}`);
    });
    // 要求里必须写明"标记原样保留"—— 否则模型可能顺手把它删掉，
    // 而那条探针会因此变红（红的原因却是提示词没说清）
    expect(prompt).toContain("原样保留");
  });

  it("失败的模块也会写进装配提示词，并要求不要替它编", async () => {
    const ids = ["m-1", "m-2"];
    const { batch } = await run({
      ids,
      plan: (call) => (call.moduleId === "m-2" ? { throws: "超时" } : {}),
    });
    const prompt = buildAssemblePrompt({ prompt: SPEC.prompt, batch });

    expect(prompt).toContain("构建失败");
    expect(prompt).toContain("m-2");
    expect(prompt).toContain("超时");
    expect(prompt).toContain("不要替它们编造");
  });

  it("片段超长时掐尾（而不是掐头），且留下截断痕迹", async () => {
    /*
      掐头会把 data-module 标记和函数名切掉 —— 于是那条探针会因为
      "提示词里没给"而变红，等于自己制造了一个假故障。
    */
    const huge = "x".repeat(9000);
    const { batch } = await run({
      ids: ["m-1"],
      plan: () => ({
        text: JSON.stringify({
          summary: "很大",
          html: `<section data-module="m-1">${huge}</section>`,
          css: "",
          js: "function mInit(){}",
        }),
      }),
    });

    const prompt = buildAssemblePrompt({ prompt: SPEC.prompt, batch });
    expect(prompt).toContain('data-module="m-1"'); // 头部保住了
    expect(prompt).toContain("已截断"); // 丢了多少写出来了
    expect(prompt.length).toBeLessThan(huge.length + 4000);
  });
});

/* ============================================================
   ⑧ 模块的思考要跟着结果走出来
   ------------------------------------------------------------
   并行构建开着思考（GENERATE_DEFAULT_EFFORT = "high"），真实运行里
   单个模块的思考量到过 12706 tokens。但思考原先丢在 ModelResult 里没人取，
   于是界面上这一步的「思考」tab 永远写着"没有返回思考内容"——
   模型其实想了很多，产品却在说没想。编排层（route.ts）拿到它之后
   会发成 reasoning 事件；这里钉的是**它确实被带出来了**。
   ============================================================ */

describe("模块的思考", () => {
  it("【关键】成功的模块要把这一次的思考原样带出来（一字不改）", async () => {
    const thought = "先把状态存哪儿想清楚：用绝对时间戳，避免 setInterval 漂移";
    const { batch } = await run({
      ids: ["m-1"],
      plan: () => ({ reasoning: thought }),
    });
    expect(batch.modules[0].reasoning).toBe(thought);
  });

  it("★ 反例：没有思考时是空串 —— 编排层据此不发 reasoning 事件", async () => {
    const { batch } = await run({ ids: ["m-1"], plan: () => ({ reasoning: "" }) });
    expect(batch.modules[0].reasoning).toBe("");
    // 空思考必须能被"不发光"的判据识别出来（route.ts 用的是 trim 后长度）
    expect(batch.modules[0].reasoning.trim().length).toBe(0);
  });

  it("★ 反例：只有空白字符也算没思考", async () => {
    const { batch } = await run({ ids: ["m-1"], plan: () => ({ reasoning: "  \n " }) });
    expect(batch.modules[0].reasoning.trim().length).toBe(0);
  });

  it("【关键】解析失败的模块**也要**带出思考 —— 想了就是想了", async () => {
    /*
      这一类失败恰恰最该让人看见：截断的模块往往正是想得最多的那些
      （实测有一次思考 13997 把预算吃光、正文一个字都没吐出来）。
      不带出来的话，用户只看到"这个模块失败了"，不知道它认真想过。
    */
    const { batch } = await run({
      ids: ["m-1"],
      plan: () => ({ text: "我不想输出 JSON", reasoning: "想了很多但没写成 JSON" }),
    });
    expect(batch.failed).toHaveLength(1);
    expect(batch.failed[0].reasoning).toBe("想了很多但没写成 JSON");
    // 该记的账也照样记着（与思考的可见性无关，但同一条分支，顺手钉住）
    expect(batch.failed[0].usage.reasoningTokens).toBe(0);
  });

  it("★ 反例：调用直接抛错时没有思考（压根没有返回），给空串", async () => {
    const { batch } = await run({
      ids: ["m-1"],
      plan: () => ({ throws: "网络断了" }),
    });
    expect(batch.failed).toHaveLength(1);
    expect(batch.failed[0].reasoning).toBe("");
  });

  it("每个模块带的是**自己**的思考，不会串台", async () => {
    const { batch } = await run({
      ids: ["m-1", "m-2"],
      plan: (call) => ({ reasoning: `我是 ${call.moduleId} 的思考` }),
    });
    expect(batch.modules.map((m) => m.reasoning)).toEqual([
      "我是 m-1 的思考",
      "我是 m-2 的思考",
    ]);
  });
});

/* ============================================================
   ⑨ 截断即加倍预算重试（这一批工序最贵的一条保险）
   ------------------------------------------------------------
   背景：模块的预算被真实运行顶满过三次（6000 / 16384 / 32768），
   每次都是"思考把预算吃光、正文一个字没吐出来"。
   抬常数只是把运气往后推，所以改成"截断了就加倍再来一次"。
   这里钉的是**接线**（重试助手本身有它自己的单测）：
   两次调用的钱都要进账、重试要能被看见、没截断时一次都不许多调。
   ============================================================ */

describe("截断重试", () => {
  it("【关键】第一次顶满预算 → 加倍重试一次，第二次的产出作数", async () => {
    const { batch, h } = await run({
      ids: ["m-1"],
      plan: (_call, nth) => (nth === 1 ? { truncated: true } : {}),
    });

    expect(batch.modules).toHaveLength(1);
    // 两次调用，第二次预算是第一次的两倍
    const mine = h.calls.filter((c) => c.moduleId === "m-1");
    expect(mine).toHaveLength(2);
    expect(mine[0].maxOutputTokens).toBe(MODULE_MAX_OUTPUT_TOKENS);
    expect(mine[1].maxOutputTokens).toBe(MODULE_MAX_OUTPUT_TOKENS * 2);
    expect(batch.modules[0].truncated).toBe(false);
  });

  it("重试过的模块要在批次里点出来 —— 用户该知道它第一次顶满了", async () => {
    const { batch } = await run({
      ids: ["m-1", "m-2"],
      plan: (call, nth) => (call.moduleId === "m-2" && nth === 1 ? { truncated: true } : {}),
    });
    expect(batch.retriedModules).toEqual(["m-2"]);
  });

  it("★ 反例：没截断 → 一次都不许多调，retriedModules 是空的", async () => {
    const { batch, h } = await run({ ids: ["m-1"], plan: () => ({}) });
    expect(h.calls.filter((c) => c.moduleId === "m-1")).toHaveLength(1);
    expect(batch.retriedModules).toEqual([]);
  });

  it("【关键】两次调用的钱都进账 —— 截断那次往往正是最贵的", async () => {
    const { batch } = await run({
      ids: ["m-1"],
      plan: (_call, nth) =>
        nth === 1
          ? { truncated: true, costCny: 0.07, usage: { inputTokens: 500, outputTokens: 32768 } }
          : { costCny: 0.02, usage: { inputTokens: 500, outputTokens: 9000 } },
    });

    expect(batch.totalCostCny).toBeCloseTo(0.09, 6);
    expect(batch.totalUsage.outputTokens).toBe(41768);
    expect(batch.modules[0].costCny).toBeCloseTo(0.09, 6);
  });

  it("重试之后仍然截断、仍然解析不出来 → 报失败，且原因里说清「截断」与「重试」", async () => {
    const { batch } = await run({
      ids: ["m-1"],
      plan: (_call, nth) =>
        nth === 1
          ? { truncated: true, costCny: 0.07 }
          : { truncated: true, costCny: 0.09, text: "想得太多，还是没写出 JSON" },
    });

    expect(batch.failed).toHaveLength(1);
    const msg = batch.failed[0].message;
    expect(msg).toContain("截断");
    expect(msg).toContain("重试");
    expect(batch.failed[0].costCny).toBeCloseTo(0.16, 6);
    // 失败也照样记着"这一批重试过"
    expect(batch.retriedModules).toEqual(["m-1"]);
  });

  it("★ 反例：重试那一次自己挂了（正文仍可解析）→ 算成功但**标明截断**，第一次的钱照记", async () => {
    /*
      口径沿用项目既有的那一条：**截断出来的内容往往还能用**
      （spec-stage 那边就是这么处理的）。所以这里不把一个能解析的模块扔掉，
      而是：成功 + truncated=true + retriedModules 里点出它重试过。
      整批也不许被这一个模块的异常带崩。
    */
    const { batch } = await run({
      ids: ["m-1", "m-2"],
      plan: (call, nth) =>
        call.moduleId === "m-1"
          ? nth === 1
            ? { truncated: true, costCny: 0.07 }
            : { throws: "网关超时" }
          : {},
    });

    expect(batch.modules.map((m) => m.moduleId).sort()).toEqual(["m-1", "m-2"]);
    expect(batch.failed).toHaveLength(0);
    const m1 = batch.modules.find((m) => m.moduleId === "m-1")!;
    expect(m1.truncated).toBe(true); // 没拿到完整输出，必须标出来
    expect(m1.costCny).toBeCloseTo(0.07, 6); // ★ 第一次那笔钱不能凭空消失
    expect(batch.retriedModules).toEqual(["m-1"]);
  });

  it("★ 反例：重试挂了**且**第一次的正文没法用 → 报失败，原因里说清是重试失败", async () => {
    const { batch } = await run({
      ids: ["m-1", "m-2"],
      plan: (call, nth) =>
        call.moduleId === "m-1"
          ? nth === 1
            ? { truncated: true, costCny: 0.07, text: "这不是 JSON" }
            : { throws: "网关超时" }
          : {},
    });

    expect(batch.modules.map((m) => m.moduleId)).toEqual(["m-2"]);
    expect(batch.failed).toHaveLength(1);
    const f = batch.failed[0];
    expect(f.message).toContain("网关超时"); // 说清是"重试那次失败了"
    expect(f.message).toContain("截断"); // 也说清根因是截断
    expect(f.costCny).toBeCloseTo(0.07, 6);
  });
});