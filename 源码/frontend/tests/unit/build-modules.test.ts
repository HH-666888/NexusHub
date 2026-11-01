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
  type ModuleBuild,
} from "@/core/domain/module-build";
import type { ArchSpec } from "@/core/domain/arch";
import type { AppSpec } from "@/core/domain/spec";
import type { ModelPort, ModelRequest, ModelResult } from "@/core/ports/model";

/**
 * 保护并行构建：并发峰值、单模块失败隔离、记账、派工单、思考透传、截断重试、断点续跑。
 * 模块 id、职责与功能条目都从夹具现取，不手抄产品代码里的字符串。
 */

const SPEC: AppSpec = {
  prompt: "做一个团队任务看板",
  goal: "小团队共用的任务看板",
  audience: "3-8 人的小团队",
  scenarios: ["新建任务", "拖动改状态"],
  acceptance: [
    {
      id: "ac-1",
      statement: "能新建任务",
      verifyBy: "点新建按钮，卡片出现",
      level: "must",
    },
    {
      id: "ac-2",
      statement: "能拖动卡片换栏位",
      verifyBy: "拖到另一栏松手",
      level: "must",
    },
    {
      id: "ac-3",
      statement: "刷新后数据还在",
      verifyBy: "按 F5 后位置不变",
      level: "should",
    },
  ],
  scope: { inScope: ["看板"], outOfScope: ["多人实时协作"] },
  questions: [],
  model: "fixture",
  generatedAt: 0,
};

// 造 N 个模块的架构：每个模块的职责里带一句只有它自己才有的文字。
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

// 假 ModelPort 记录 calls、inFlight、peak，本文件的断言都基于这三项。

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
  /** 最近一次调用的用户消息（验"第 N 个 / 共 M 个"这类提示词细节） */
  lastPrompt: string;
}

function makeHarness(opts: {
  plan: (call: Call, nth: number) => Plan;
  delayMs?: number;
}): Harness {
  const delayMs = opts.delayMs ?? 3;
  const calls: Call[] = [];
  const callsByModule = new Map<string, number>();
  let lastPrompt = "";
  let inFlight = 0;
  let peak = 0;

  const model: ModelPort = {
    async complete(req: ModelRequest): Promise<ModelResult> {
      const user =
        typeof req.messages[1]?.content === "string" ? req.messages[1].content : "";
      const system =
        typeof req.messages[0]?.content === "string" ? req.messages[0].content : "";
      // 模块 id 从提示词里读，不按调用顺序猜：并发下顺序不代表模块身份。
      lastPrompt = user;
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
    get lastPrompt() {
      return lastPrompt;
    },
  };
}

/** 跑一批，返回批次与假端口的观测数据 */
async function run(opts: {
  ids: string[];
  concurrency?: number;
  plan?: (call: Call, nth: number) => Plan;
  delayMs?: number;
  maxOutputTokensPerModule?: number;
  /** 断点续跑：只构建这几个 */
  onlyModuleIds?: string[];
  /** 边构建边落盘的回调（验它被调用了几次、顺序对不对） */
  onModuleBuilt?: (b: ModuleBuild) => void | Promise<void>;
}): Promise<{ batch: BuildBatch; h: Harness }> {
  const h = makeHarness({
    plan: opts.plan ?? (() => ({})),
    delayMs: opts.delayMs,
  });
  const batch = await buildModules(
    { model: h.model, onModuleBuilt: opts.onModuleBuilt },
    {
      prompt: SPEC.prompt,
      spec: SPEC,
      arch: archOf(opts.ids),
      concurrency: opts.concurrency,
      maxOutputTokensPerModule: opts.maxOutputTokensPerModule,
      onlyModuleIds: opts.onlyModuleIds,
    },
  );
  return { batch, h };
}

describe("真的并发（不是 for 里 await）", () => {
  it("6 个模块、默认上限 → 同时在飞的最大值 >1 且 <= 上限", async () => {
    // 串行实现也能让模块全成功、花费对得上，只有同时在飞的峰值能区分两者。
    // 断言两个方向：peak > 1（串行会红）、peak <= 上限（无节制会红）。
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
    // 断言恰好等于 2 而不是 <=2：后者对每次只跑一个的实现也成立。
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
    // 小数向下取整但最少为 1：一个都不跑会让一次运行安静地什么模块都没构建。
    expect(resolveConcurrency(1.7)).toBe(1);
    expect(resolveConcurrency(0.4)).toBe(1);
  });

  it("模块顺序按架构顺序回填，与谁先跑完无关", async () => {
    // 第一个模块故意最慢：谁先跑完就排前面的话，清单顺序每次刷新都会跳。
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
    // 调用成功、正文却不是 JSON：钱已经花出去，账本上不能当它没发生。
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
});

describe("自定口径", () => {
  it("全部失败 → 不抛错，返回 failed.length === 模块数 的批次（口径①）", async () => {
    // 全部失败不抛错：抛错会让编排层丢掉失败名单与花费记录。
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

  // 并行构建刻意开思考（修法 3），所以这里断言 high，而不是旧行为的 none。
  it("调用参数：执行级、**开思考（修法 3 刻意改的行为）**、预算用 MODULE_MAX_OUTPUT_TOKENS", async () => {
    const { h } = await run({ ids: ["m-1"] });
    expect(h.calls[0].tier).toBe("execute");
    expect(h.calls[0].effort).toBe("high");
    expect(h.calls[0].maxOutputTokens).toBe(MODULE_MAX_OUTPUT_TOKENS);
  });
});

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
        call.moduleId === "m-1"
          ? { costCny: 0.01 }
          : { text: "不是 JSON", costCny: 0.05 },
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

describe("摘要与特征片段", () => {
  it("summarizeBatch 的模块名从 arch 查，不是从事件里抄", async () => {
    const ids = ["task-store", "board-ui"];
    const { batch } = await run({
      ids,
      plan: (call) => ({ text: moduleJson(call.moduleId) }),
    });
    const summary = summarizeBatch(batch, archOf(ids));

    expect(summary.modules.map((m) => m.name)).toEqual([
      "模块1·task-store",
      "模块2·board-ui",
    ]);
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
      moduleSignature({
        moduleId: "task-store",
        html: "<section></section>",
        css: ".task-store-box{}",
        js: "",
      }),
    ).toBe(".task-store-box");
  });

  it("三段都提不出特征时返回 null（那是'无法判断'，不是'通过'）", () => {
    expect(moduleSignature({ moduleId: "x", html: "", css: "", js: "" })).toBeNull();
  });

  it("parseModuleBuild 缺 summary 时给一句实话，而不是编一句'已完成'", () => {
    const parsed = parseModuleBuild(
      "m-1",
      JSON.stringify({ html: "<section></section>" }),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.build.summary).toContain("没有给出摘要");
      expect(parsed.build.html).toBe("<section></section>");
      expect(parsed.build.moduleId).toBe("m-1");
    }
  });
});

describe("装配提示词带上了各模块的代码片段", () => {
  it("每个模块的 html / css / js 都真的在提示词里，且标明是哪个模块", async () => {
    const ids = ["task-store", "board-ui"];
    const { batch } = await run({
      ids,
      plan: (call) => ({ text: moduleJson(call.moduleId) }),
    });

    const prompt = buildAssemblePrompt({
      prompt: SPEC.prompt,
      batch,
      arch: archOf(ids),
    });

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
    // 掐尾不掐头：掐头会切掉认领标记和函数名，制造一个假故障。
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

// 思考要跟着结果走出来：编排层拿到它之后发 reasoning 事件。

describe("模块的思考", () => {
  it("成功的模块要把这一次的思考原样带出来（一字不改）", async () => {
    const thought = "先把状态存哪儿想清楚：用绝对时间戳，避免 setInterval 漂移";
    const { batch } = await run({
      ids: ["m-1"],
      plan: () => ({ reasoning: thought }),
    });
    expect(batch.modules[0].reasoning).toBe(thought);
  });

  it("反例：没有思考时是空串 —— 编排层据此不发 reasoning 事件", async () => {
    const { batch } = await run({ ids: ["m-1"], plan: () => ({ reasoning: "" }) });
    expect(batch.modules[0].reasoning).toBe("");
    // 空思考必须能被"不发光"的判据识别出来（route.ts 用的是 trim 后长度）
    expect(batch.modules[0].reasoning.trim().length).toBe(0);
  });

  it("反例：只有空白字符也算没思考", async () => {
    const { batch } = await run({ ids: ["m-1"], plan: () => ({ reasoning: "  \n " }) });
    expect(batch.modules[0].reasoning.trim().length).toBe(0);
  });

  it("解析失败的模块**也要**带出思考 —— 想了就是想了", async () => {
    // 截断的模块往往正是想得最多的那些，失败时也要把思考带出来。
    const { batch } = await run({
      ids: ["m-1"],
      plan: () => ({ text: "我不想输出 JSON", reasoning: "想了很多但没写成 JSON" }),
    });
    expect(batch.failed).toHaveLength(1);
    expect(batch.failed[0].reasoning).toBe("想了很多但没写成 JSON");
    // 该记的账也照样记着（与思考的可见性无关，但同一条分支，顺手钉住）
    expect(batch.failed[0].usage.reasoningTokens).toBe(0);
  });

  it("反例：调用直接抛错时没有思考（压根没有返回），给空串", async () => {
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

// 截断即加倍预算重试：两次调用的钱都进账，没截断时一次都不许多调。
// 这里钉的是接线，重试助手本身另有单测。

describe("截断重试", () => {
  it("第一次顶满预算 → 加倍重试一次，第二次的产出作数", async () => {
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
      plan: (call, nth) =>
        call.moduleId === "m-2" && nth === 1 ? { truncated: true } : {},
    });
    expect(batch.retriedModules).toEqual(["m-2"]);
  });

  it("反例：没截断 → 一次都不许多调，retriedModules 是空的", async () => {
    const { batch, h } = await run({ ids: ["m-1"], plan: () => ({}) });
    expect(h.calls.filter((c) => c.moduleId === "m-1")).toHaveLength(1);
    expect(batch.retriedModules).toEqual([]);
  });

  it("两次调用的钱都进账 —— 截断那次往往正是最贵的", async () => {
    const { batch } = await run({
      ids: ["m-1"],
      plan: (_call, nth) =>
        nth === 1
          ? {
              truncated: true,
              costCny: 0.07,
              usage: { inputTokens: 500, outputTokens: 32768 },
            }
          : { costCny: 0.02, usage: { inputTokens: 500, outputTokens: 9000 } },
    });

    expect(batch.totalCostCny).toBeCloseTo(0.09, 6);
    expect(batch.totalUsage.outputTokens).toBe(41768);
    expect(batch.modules[0].costCny).toBeCloseTo(0.09, 6);
  });

  it("重试之后仍然截断、仍然解析不出来 → 报失败，且原因里说清“截断”与“重试”", async () => {
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

  it("反例：重试那一次自己挂了（正文仍可解析）→ 算成功但**标明截断**，第一次的钱照记", async () => {
    // 截断出来的内容往往还能用：记成功 + truncated，并把重试过的模块点出来。
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
    expect(m1.costCny).toBeCloseTo(0.07, 6); // 第一次那笔钱不能凭空消失
    expect(batch.retriedModules).toEqual(["m-1"]);
  });

  it("反例：重试挂了**且**第一次的正文没法用 → 报失败，原因里说清是重试失败", async () => {
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

describe("断点续跑 · 只构建缺的那几个", () => {
  it("点名 2 个 → 只有 2 次模型调用，另外两个模块一次都没跑", async () => {
    const { batch, h } = await run({
      ids: ["m1", "m2", "m3", "m4"],
      onlyModuleIds: ["m2", "m4"],
    });
    expect(h.calls.length).toBe(2);
    expect(batch.modules.map((m) => m.moduleId).sort()).toEqual(["m2", "m4"]);
    // 认领次数也要对得上：别出现"调用了但没认领"这种糊涂账
    expect(h.callsByModule.get("m1") ?? 0).toBe(0);
    expect(h.callsByModule.get("m3") ?? 0).toBe(0);
  });

  it("提示词里的“第 N 个 / 共 M 个”按**架构全部模块**算，不按这一小批算", async () => {
    // 只补 1 个模块时，对它说第 1 个共 4 个会自相矛盾。
    const { h } = await run({ ids: ["m1", "m2", "m3", "m4"], onlyModuleIds: ["m3"] });
    expect(h.calls.length).toBe(1);
    // 提示词本身在 h.lastPrompt 里留了一份（见 harness）
    expect(h.lastPrompt).toContain("第 3 个");
    expect(h.lastPrompt).toContain("整个应用一共 4 个模块");
  });

  it("反例：不点名 = 全部构建（老行为一个字节都不变）", async () => {
    const { batch, h } = await run({ ids: ["m1", "m2", "m3"] });
    expect(h.calls.length).toBe(3);
    expect(batch.modules).toHaveLength(3);
  });

  it("反例：点名了但架构里没有这个 id → 一个都不构建（不许凭空造一个）", async () => {
    const { batch, h } = await run({ ids: ["m1", "m2"], onlyModuleIds: ["不存在"] });
    expect(h.calls.length).toBe(0);
    expect(batch.modules).toEqual([]);
    expect(batch.failed).toEqual([]);
  });
});

describe("断点续跑 · 边构建边落盘（onModuleBuilt）", () => {
  it("每构建好一个就回调一次，且**不等整批跑完**", async () => {
    // 回调必须在整批跑完之前触发，否则中途重启会丢掉已经完成的那几个。
    // 回调里用外层先建好的 harness：解构变量 h 在 buildModules 内还是 TDZ。
    const h = makeHarness({ plan: () => ({}) });
    const seen: Array<{ id: string; callsSoFar: number }> = [];
    const batch = await buildModules(
      {
        model: h.model,
        onModuleBuilt: (b) => {
          seen.push({ id: b.moduleId, callsSoFar: h.calls.length });
        },
      },
      {
        prompt: SPEC.prompt,
        spec: SPEC,
        arch: archOf(["m1", "m2", "m3"]),
        concurrency: 1, // 串行，好判断先后
      },
    );

    expect(batch.modules).toHaveLength(3);
    expect(seen).toHaveLength(3);
    // 第一个回调发生时，后面还有模块没跑完
    expect(seen[0].callsSoFar).toBeLessThan(3);
    expect(seen.map((s) => s.id)).toEqual(["m1", "m2", "m3"]);
  });

  it("反例：失败的模块**不**回调（没有产出可落盘）", async () => {
    const seen: string[] = [];
    await run({
      ids: ["m1", "m2"],
      plan: (call) => (call.moduleId === "m2" ? { text: "这不是 JSON" } : {}),
      onModuleBuilt: (b) => {
        seen.push(b.moduleId);
      },
    });
    expect(seen).toEqual(["m1"]);
  });

  it("反例：回调抛错不许把整批带崩（存不上只是下次少沿用几个）", async () => {
    const { batch } = await run({
      ids: ["m1", "m2"],
      onModuleBuilt: () => {
        throw new Error("磁盘满了");
      },
    });
    expect(batch.modules).toHaveLength(2);
    expect(batch.failed).toEqual([]);
  });
});
