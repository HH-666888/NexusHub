import { describe, expect, it, vi } from "vitest";
import {
  runArchStage,
  ARCH_ARTIFACT_NAME,
  ARCH_MAX_OUTPUT_TOKENS,
  type ArchStageEvent,
} from "@/core/generate/arch-stage";
import { fallbackArch, parseArch, type ArchSpec } from "@/core/domain/arch";
import type { AppSpec } from "@/core/domain/spec";
import type { ModelPort, ModelRequest, ModelResult } from "@/core/ports/model";
import type { ArtifactStore } from "@/core/ports/artifact-store";
import type { CostStore } from "@/core/ports/cost-store";
import type { RunStore } from "@/core/ports/run-store";
import type { NewCostRecord } from "@/core/domain/cost";
import type { NewArtifact } from "@/core/domain/artifact";

/**
 * 保护架构定型阶段：正常产出、兜底两条路径都落盘、预算闸门、记账顺序、
 * 思考事件与兜底标签。假端口代替网络，真实模型一次都不调。
 */

/** 一份规格。验收条目 id 是 ac-1…，架构必须逐条覆盖它们 */
function specWith(ids: string[]): AppSpec {
  return {
    prompt: "做一个任务看板",
    goal: "团队任务看板",
    audience: "小团队",
    scenarios: ["新建任务", "拖动状态"],
    acceptance: ids.map((id, i) => ({
      id,
      statement: `第 ${i + 1} 条可判定的功能`,
      verifyBy: "打开页面点一下按钮，有可见响应",
      level: "must" as const,
    })),
    scope: { inScope: ["看板"], outOfScope: ["多人协作"] },
    questions: [],
    model: "fake-model",
    generatedAt: 0,
  };
}

const SPEC = specWith(["ac-1", "ac-2", "ac-3"]);

const GOOD_ARCH_JSON = JSON.stringify({
  modules: [
    {
      id: "task-store",
      name: "任务存储",
      responsibility: "任务的增删改与本地持久化",
      dependsOn: [],
      coversFeatures: ["ac-1"],
    },
    {
      id: "board-ui",
      name: "看板界面",
      responsibility: "三栏看板与拖拽交互",
      dependsOn: ["task-store"],
      coversFeatures: ["ac-2", "ac-3"],
    },
  ],
  packages: [{ name: "dayjs", why: "格式化时间" }],
});

function makeResult(over: Partial<ModelResult> = {}): ModelResult {
  return {
    text: GOOD_ARCH_JSON,
    reasoning: "",
    usage: {
      inputTokens: 300,
      outputTokens: 400,
      reasoningTokens: 0,
      cacheHitTokens: 0,
      cacheMissTokens: 300,
    },
    costCny: 0.02,
    priceTier: "offPeak",
    model: "fake-model",
    latencyMs: 900,
    truncated: false,
    finishReason: "stop",
    ...over,
  };
}

interface Harness {
  events: ArchStageEvent[];
  saved: Array<Omit<NewArtifact, "bytes" | "sha256"> & { content: string }>;
  costRecords: NewCostRecord[];
  runUpdates: Array<Record<string, unknown>>;
  modelCalls: number;
}

async function run(opts: {
  modelResult?: ModelResult;
  modelThrows?: string;
  artifactThrows?: string;
  costThrows?: string;
  spentCny?: number;
  costLimitCny?: number;
  spec?: AppSpec;
}): Promise<Harness> {
  const h: Harness = {
    events: [],
    saved: [],
    costRecords: [],
    runUpdates: [],
    modelCalls: 0,
  };

  const model: ModelPort = {
    async complete() {
      h.modelCalls++;
      if (opts.modelThrows) throw new Error(opts.modelThrows);
      return opts.modelResult ?? makeResult();
    },
    // 架构定型阶段不该走流式 —— 产出是 JSON，逐字蹦出来没有意义
    async *stream(): AsyncIterable<never> {
      throw new Error("架构定型阶段不该走流式");
    },
  };

  const artifacts = {
    async save(data: Harness["saved"][number]) {
      if (opts.artifactThrows) throw new Error(opts.artifactThrows);
      h.saved.push(data);
      return { id: 1, createdAt: 0, bytes: data.content.length, sha256: "x", ...data };
    },
    async listByRun() {
      return [];
    },
    async findLatest() {
      return null;
    },
    async readContent() {
      return null;
    },
    async removeByRun() {
      return 0;
    },
  } as ArtifactStore;

  const costs = {
    async record(data: NewCostRecord) {
      if (opts.costThrows) throw new Error(opts.costThrows);
      h.costRecords.push(data);
    },
    async listByRun() {
      return [];
    },
    async totalByRun() {
      return 0;
    },
    async totalByUser() {
      return 0;
    },
  } as CostStore;

  const runs = {
    async update(_id: string, patch: Record<string, unknown>) {
      h.runUpdates.push(patch);
    },
  } as unknown as RunStore;

  for await (const e of runArchStage(
    { model, artifacts, runs, costs },
    {
      runId: "run-1",
      prompt: "做一个任务看板",
      spec: opts.spec ?? SPEC,
      costLimitCny: opts.costLimitCny ?? 5,
      spentCny: opts.spentCny ?? 0,
    },
  )) {
    h.events.push(e);
  }
  return h;
}

const archEvent = (h: Harness) =>
  h.events.find((e): e is Extract<ArchStageEvent, { kind: "arch" }> => e.kind === "arch");

const errorEvents = (h: Harness) =>
  h.events.filter((e): e is Extract<ArchStageEvent, { kind: "error" }> => e.kind === "error");

describe("架构定型阶段 · 正常路径", () => {
  it("产出一条 arch 事件，且不是兜底", async () => {
    const h = await run({});
    const e = archEvent(h);
    expect(e).toBeDefined();
    expect(e!.fallback).toBe(false);
    expect(e!.arch.modules.map((m) => m.id)).toEqual(["task-store", "board-ui"]);
    expect(e!.arch.packages.map((p) => p.name)).toEqual(["dayjs"]);
  });

  it("事件里带着三条本地检查的结果，而且这份夹具三条全过", async () => {
    const h = await run({});
    const e = archEvent(h)!;
    expect(e.check.total).toBe(3);
    expect(e.check.passed).toBe(3);
    expect(e.check.results.map((r) => r.pass)).toEqual([true, true, true]);
  });

  it("产出 arch.json（path = <runId>/arch.json，内容是能解析的 JSON）", async () => {
    const h = await run({});
    expect(h.saved).toHaveLength(1);
    expect(h.saved[0].path).toBe(`run-1/${ARCH_ARTIFACT_NAME}`);
    expect(h.saved[0].kind).toBe("json");

    const parsed = JSON.parse(h.saved[0].content) as ArchSpec;
    expect(parsed.modules).toHaveLength(2);
  });

  it("用了决策级档位，并要求 JSON 输出、带上架构的输出上限", async () => {
    // 显式声明参数类型，否则 mock.calls[0] 被推成空元组，取 [0] 会编译不过
    const spy = vi.fn(async (_req: ModelRequest) => makeResult());
    const model = { complete: spy, stream: async function* () {} } as unknown as ModelPort;
    const artifacts = {
      save: async (d: never) => d,
      listByRun: async () => [],
      findLatest: async () => null,
      readContent: async () => null,
      removeByRun: async () => 0,
    } as unknown as ArtifactStore;
    const costs = {
      record: async () => {},
      listByRun: async () => [],
      totalByRun: async () => 0,
      totalByUser: async () => 0,
    } as unknown as CostStore;
    const runs = { update: async () => {} } as unknown as RunStore;

    for await (const _ of runArchStage(
      { model, artifacts, runs, costs },
      { runId: "r", prompt: "x", spec: SPEC, costLimitCny: 5 },
    )) {
      void _;
    }

    const req = spy.mock.calls[0][0];
    expect(req.tier).toBe("decide");
    expect(req.responseFormat).toBe("json");
    expect(req.maxOutputTokens).toBe(ARCH_MAX_OUTPUT_TOKENS);
    // 规格必须真的进了提示词 —— 架构要建立在真规格上
    const userMsg = req.messages.find((m) => m.role === "user")!;
    expect(typeof userMsg.content === "string" ? userMsg.content : "").toContain("ac-1");
  });

  it("phase 事件报的是第二道工序自己的 id：arch", async () => {
    const h = await run({});
    const phases = h.events.filter(
      (e): e is Extract<ArchStageEvent, { kind: "phase" }> => e.kind === "phase",
    );
    expect(phases.length).toBeGreaterThan(0);
    for (const p of phases) expect(p.phase).toBe("arch");
    expect(phases[0].label).toContain("模块");
  });
});

describe("架构定型阶段 · 记账与用量", () => {
  it("usage 事件里的数字**原样来自模型返回**，一个都不估算", async () => {
    const h = await run({});
    const u = h.events.find(
      (e): e is Extract<ArchStageEvent, { kind: "usage" }> => e.kind === "usage",
    )!;

    const expected = makeResult();
    expect(u.usage).toEqual(expected.usage);
    expect(u.costCny).toBeCloseTo(expected.costCny, 8);
    expect(u.priceTier).toBe(expected.priceTier);
    expect(u.model).toBe(expected.model);
    expect(u.latencyMs).toBe(expected.latencyMs);
    expect(u.truncated).toBe(expected.truncated);
  });

  it("记一条成本流水，阶段标为 arch、档位标为 decide", async () => {
    const h = await run({});
    expect(h.costRecords).toHaveLength(1);
    expect(h.costRecords[0].stage).toBe("arch");
    expect(h.costRecords[0].tier).toBe("decide");
    expect(h.costRecords[0].costCny).toBeCloseTo(0.02, 8);
  });

  it("累计值写进 runs —— 而且是 spent + 这一次，不是覆盖", async () => {
    const h = await run({ spentCny: 0.5 });
    expect(h.runUpdates).toHaveLength(1);
    expect(h.runUpdates[0].totalCostCny).toBeCloseTo(0.52, 8);
  });

  it("【关键】模型返回不可解析时**照样记账** —— 钱已经花了", async () => {
    const h = await run({ modelResult: makeResult({ text: "我觉得这个架构挺合理的" }) });
    expect(h.costRecords).toHaveLength(1);
    expect(archEvent(h)!.fallback).toBe(true);
  });

  it("记账自身抛错不影响产出", async () => {
    const h = await run({ costThrows: "数据库锁了" });
    expect(h.costRecords).toHaveLength(0);
    expect(archEvent(h)).toBeDefined();
    expect(archEvent(h)!.fallback).toBe(false);
  });
});

describe("架构定型阶段 · 降级", () => {
  it("【关键】调用模型本身失败：产出兜底架构（fallback=true）而且**照样落盘**", async () => {
    const h = await run({ modelThrows: "网络超时" });
    const e = archEvent(h)!;

    expect(e.fallback).toBe(true);
    expect(e.arch.modules.length).toBeGreaterThan(0);
    // 兜底也要落盘 —— 这是从 spec 那道工序学来的一条（那边第一版漏了）
    expect(h.saved).toHaveLength(1);
    expect(h.saved[0].path).toBe(`run-1/${ARCH_ARTIFACT_NAME}`);

    expect(errorEvents(h)[0].message).toContain("调用模型失败");
  });

  it("【关键】返回一坨不是 JSON 的东西：降级为兜底架构，说明原因，并落盘", async () => {
    const h = await run({ modelResult: makeResult({ text: "总之先分三个模块吧" }) });
    const e = archEvent(h)!;

    expect(e.fallback).toBe(true);
    expect(h.saved).toHaveLength(1);
    expect(errorEvents(h)[0].message).toContain("没法解析");
  });

  it("合法 JSON 但一个模块都没有（modules 为空）→ 同样兜底", async () => {
    // 能解析不等于能用：空架构长不出任何任务点，第四道也就没有并行单元。
    const h = await run({
      modelResult: makeResult({ text: JSON.stringify({ modules: [], packages: [] }) }),
    });

    expect(archEvent(h)!.fallback).toBe(true);
    expect(errorEvents(h)[0].message).toContain("模块");
  });

  it("兜底架构自己也过得了那三条本地检查（无孤儿需求是实话，不是凑绿）", async () => {
    const h = await run({ modelThrows: "网络超时" });
    const e = archEvent(h)!;

    expect(e.check.total).toBe(3);
    expect(e.check.passed).toBe(3);
    // 它用一个模块承接了规格里**全部**条目 —— 这一条要能对得上
    const only = e.arch.modules[0];
    expect(only.coversFeatures.sort()).toEqual(SPEC.acceptance.map((a) => a.id).sort());
  });

  it("兜底架构能被识别出来（名字里带着兜底标记）", async () => {
    const h = await run({ modelThrows: "网络超时" });
    const e = archEvent(h)!;
    expect(e.arch.modules.some((m) => m.name.includes("兜底架构"))).toBe(true);

    // domain 层的兜底生成器与这里的判定要一致
    const direct = fallbackArch({ spec: SPEC, model: "fallback", generatedAt: 0 });
    expect(direct.modules[0].coversFeatures).toEqual(SPEC.acceptance.map((a) => a.id));
  });

  it("输出被截断时明确提醒，但不降级 —— 截断出来的内容往往还能用", async () => {
    const h = await run({ modelResult: makeResult({ truncated: true }) });
    expect(archEvent(h)!.fallback).toBe(false);
    expect(errorEvents(h)[0].message).toContain("截断");
  });
});

describe("架构定型阶段 · 预算闸门", () => {
  it("【关键】已经超预算时**一次模型调用都不发**，只发一条 error", async () => {
    // 闸门必须排在调用之前，否则超预算这句话会在钱花完之后才说出来。
    const h = await run({ spentCny: 5, costLimitCny: 5 });

    expect(h.modelCalls).toBe(0);
    expect(h.costRecords).toHaveLength(0);
    expect(h.saved).toHaveLength(0);
    // 只有一条事件，而且就是那条 error —— 连 phase 都不该发
    expect(h.events).toHaveLength(1);
    expect(h.events[0].kind).toBe("error");
    expect((h.events[0] as Extract<ArchStageEvent, { kind: "error" }>).message).toContain(
      "达到上限",
    );
  });

  it("没超预算时正常调用一次", async () => {
    const h = await run({ spentCny: 1, costLimitCny: 5 });
    expect(h.modelCalls).toBe(1);
  });
});

describe("架构定型阶段 · 落盘失败", () => {
  it("写盘失败不降级 —— 架构已经拿到了，事件里也发出去了", async () => {
    const h = await run({ artifactThrows: "磁盘只读" });
    expect(archEvent(h)!.fallback).toBe(false);
    expect(errorEvents(h)[0].message).toContain("写入");
  });

  it("写盘失败要说出来 —— 静默丢产物是最难查的一类问题", async () => {
    const h = await run({ artifactThrows: "磁盘只读" });
    expect(h.events.some((e) => e.kind === "error")).toBe(true);
  });
});

describe("架构定型阶段 · 事件顺序", () => {
  it("先报阶段、再用量、再架构、最后收尾", async () => {
    const h = await run({});
    const kinds = h.events.map((e) => e.kind);
    expect(kinds[0]).toBe("phase");
    expect(kinds).toContain("usage");
    expect(kinds).toContain("arch");
    expect(kinds[kinds.length - 1]).toBe("phase");
  });

  it("用量事件在架构事件之前 —— 界面上的钱要比结论先到", async () => {
    const h = await run({});
    const usageIdx = h.events.findIndex((e) => e.kind === "usage");
    const archIdx = h.events.findIndex((e) => e.kind === "arch");
    expect(usageIdx).toBeGreaterThanOrEqual(0);
    expect(usageIdx).toBeLessThan(archIdx);
  });

  it("收尾的阶段标签里带上架构摘要，用户不用点开就知道结果", async () => {
    const h = await run({});
    const last = h.events[h.events.length - 1] as Extract<ArchStageEvent, { kind: "phase" }>;
    expect(last.label).toContain("2 个模块");
    expect(last.label).toContain("架构已定型");
  });

  it("检查没过时，收尾标签说的是哪一条没过，而不是含糊的「已定型」", async () => {
    // 这份架构引用了不存在的模块，第三条检查会红；
    // 收尾标签必须说出哪一条没过，只写架构已产出会让人以为三条都过了。
    const bad = JSON.stringify({
      modules: [
        {
          id: "task-store",
          name: "任务存储",
          responsibility: "存储",
          dependsOn: ["ghost"],
          coversFeatures: ["ac-1", "ac-2", "ac-3"],
        },
      ],
      packages: [],
    });
    const h = await run({ modelResult: makeResult({ text: bad }) });
    const e = archEvent(h)!;
    expect(e.fallback).toBe(false);
    expect(e.check.passed).toBe(2);

    const last = h.events[h.events.length - 1] as Extract<ArchStageEvent, { kind: "phase" }>;
    expect(last.label).toContain("2/3");
    expect(last.label).toContain("无环");
  });
});

describe("解析与兜底的一致性", () => {
  it("阶段用的就是 domain 层的 parseArch —— 判据只有一份", () => {
    // 阶段内部不另写一套解析：两份判据迟早会漂开
    const parsed = parseArch(GOOD_ARCH_JSON);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.arch.modules.map((m) => m.id)).toEqual(["task-store", "board-ui"]);
    }
  });
});

describe("架构定型阶段 · 思考事件", () => {
  // 这一道也是 complete()，decide 档默认开思考。
  // 思考要发成 reasoning 事件，这是功能不是装饰。
  const THOUGHT = "先看规格里那几条验收：存储和界面能不能切开，依赖朝哪边走";

  const thoughts = (h: Harness) =>
    h.events.filter(
      (e): e is Extract<ArchStageEvent, { kind: "reasoning" }> => e.kind === "reasoning",
    );

  it("【关键】complete() 返回的思考要发成 reasoning 事件，内容一字不改", async () => {
    const h = await run({ modelResult: makeResult({ reasoning: THOUGHT }) });
    const t = thoughts(h);
    expect(t).toHaveLength(1);
    expect(t[0].delta).toBe(THOUGHT);
  });

  it("★ 反例：没有思考时**不发** reasoning 事件 —— 不许拿正文冒充思考", async () => {
    const h = await run({ modelResult: makeResult({ reasoning: "" }) });
    expect(thoughts(h)).toHaveLength(0);
  });

  it("★ 反例：只有空白字符也不发 —— 空白思考等于没思考", async () => {
    const h = await run({ modelResult: makeResult({ reasoning: " \n " }) });
    expect(thoughts(h)).toHaveLength(0);
  });

  it("顺序：思考排在 arch 事件之前 —— 读起来就是「先想，再给答案」", async () => {
    const h = await run({ modelResult: makeResult({ reasoning: THOUGHT }) });
    const thinkAt = h.events.findIndex((e) => e.kind === "reasoning");
    const archAt = h.events.findIndex((e) => e.kind === "arch");
    expect(thinkAt).toBeGreaterThanOrEqual(0);
    expect(thinkAt).toBeLessThan(archAt);
  });

  it("★ 反例：调用模型就失败时**不可能**有思考事件（压根没有 result）", async () => {
    const h = await run({ modelThrows: "网络超时" });
    expect(thoughts(h)).toHaveLength(0);
    expect(archEvent(h)!.fallback).toBe(true);
  });

  it("降级路径上的思考照样发 —— 想过了就是想过了，不会因为它没解析成功而丢掉", async () => {
    const h = await run({
      modelResult: makeResult({ text: "我觉得这样切模块挺好的", reasoning: THOUGHT }),
    });
    expect(archEvent(h)!.fallback).toBe(true);
    expect(thoughts(h)).toHaveLength(1);
    expect(thoughts(h)[0].delta).toBe(THOUGHT);
  });
});

describe("架构定型阶段 · 兜底标签", () => {
  // 兜底架构三条检查照样全绿，所以标签不能只说架构已定型。
  // 这一版其实没有切过模块，标签要自报家门。
  const phaseLabels = (h: Harness) =>
    h.events
      .filter((e): e is Extract<ArchStageEvent, { kind: "phase" }> => e.kind === "phase")
      .map((e) => e.label);

  it("【关键】降级时收尾标签必须自报家门 —— 否则「没切过模块」会被说成「已定型」", async () => {
    const h = await run({ modelResult: makeResult({ text: "我觉得这样切模块挺好的" }) });
    expect(archEvent(h)!.fallback).toBe(true);
    const labels = phaseLabels(h);
    expect(labels[labels.length - 1]).toContain("（兜底）");
    expect(labels[labels.length - 1]).toContain("架构已定型");
  });

  it("★ 反例：正常架构的标签里**不许**出现「（兜底）」—— 防恒真", async () => {
    const h = await run({});
    expect(archEvent(h)!.fallback).toBe(false);
    expect(phaseLabels(h).some((l) => l.includes("（兜底）"))).toBe(false);
    expect(phaseLabels(h)[phaseLabels(h).length - 1]).toContain("架构已定型：");
  });
});