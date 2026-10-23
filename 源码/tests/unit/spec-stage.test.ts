import { describe, expect, it, vi } from "vitest";
import {
  runSpecStage,
  SPEC_ARTIFACT_NAME,
  SPEC_MAX_OUTPUT_TOKENS,
  type SpecStageEvent,
} from "@/core/generate/spec-stage";
import type { ModelPort, ModelRequest, ModelResult } from "@/core/ports/model";
import type { ArtifactStore } from "@/core/ports/artifact-store";
import type { CostStore } from "@/core/ports/cost-store";
import type { RunStore } from "@/core/ports/run-store";
import type { NewCostRecord } from "@/core/domain/cost";
import type { NewArtifact } from "@/core/domain/artifact";

/* ============================================================
   假端口：内核只认识接口，所以这里不需要网络、不需要数据库
   ============================================================ */

const GOOD_SPEC_JSON = JSON.stringify({
  goal: "团队任务看板",
  audience: "小团队",
  scenarios: ["新建任务", "拖动状态", "刷新保留"],
  acceptance: [
    { id: "ac-1", statement: "能新建任务", verifyBy: "点新建按钮，卡片出现", level: "must" },
    { id: "ac-2", statement: "能拖动卡片", verifyBy: "拖到另一栏松手，卡片留在那里", level: "must" },
    { id: "ac-3", statement: "刷新后还在", verifyBy: "按 F5 后卡片位置不变", level: "must" },
    { id: "ac-4", statement: "能删除", verifyBy: "点删除，卡片消失", level: "should" },
  ],
  scope: { inScope: ["看板"], outOfScope: ["多人协作"] },
  questions: [],
});

function makeResult(over: Partial<ModelResult> = {}): ModelResult {
  return {
    text: GOOD_SPEC_JSON,
    reasoning: "",
    usage: {
      inputTokens: 100,
      outputTokens: 200,
      reasoningTokens: 0,
      cacheHitTokens: 0,
      cacheMissTokens: 100,
    },
    costCny: 0.01,
    priceTier: "offPeak",
    model: "fake-model",
    latencyMs: 800,
    truncated: false,
    finishReason: "stop",
    ...over,
  };
}

interface Harness {
  events: SpecStageEvent[];
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
  prompt?: string;
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
    // 规格化阶段不该走流式 —— 产出是 JSON，逐字蹦出来没有意义
    async *stream(): AsyncIterable<never> {
      throw new Error("规格化阶段不该走流式");
    },
  };

  const artifacts = {
    async save(data) {
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

  for await (const e of runSpecStage(
    { model, artifacts, runs, costs },
    {
      runId: "run-1",
      prompt: opts.prompt ?? "做一个任务看板",
      costLimitCny: opts.costLimitCny ?? 5,
      spentCny: opts.spentCny ?? 0,
    },
  )) {
    h.events.push(e);
  }
  return h;
}

const specEvent = (h: Harness) =>
  h.events.find((e): e is Extract<SpecStageEvent, { kind: "spec" }> => e.kind === "spec");

/* ============================================================
   正常路径
   ============================================================ */

describe("规格化阶段 · 正常路径", () => {
  it("产出一条 spec 事件，且不是兜底", async () => {
    const h = await run({});
    const e = specEvent(h);
    expect(e).toBeDefined();
    expect(e!.fallback).toBe(false);
    expect(e!.spec.goal).toBe("团队任务看板");
    expect(e!.spec.acceptance).toHaveLength(4);
  });

  it("门禁放行", async () => {
    const h = await run({});
    expect(specEvent(h)!.gate.pass).toBe(true);
  });

  it("产出 spec.json", async () => {
    const h = await run({});
    expect(h.saved).toHaveLength(1);
    expect(h.saved[0].path).toBe(`run-1/${SPEC_ARTIFACT_NAME}`);
    expect(h.saved[0].kind).toBe("json");
    // 内容要是可解析的 JSON
    expect(() => JSON.parse(h.saved[0].content)).not.toThrow();
  });

  it("用了决策级档位，并要求 JSON 输出", async () => {
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

    for await (const _ of runSpecStage(
      { model, artifacts, runs, costs },
      { runId: "r", prompt: "x", costLimitCny: 5 },
    )) {
      void _;
    }

    const req = spy.mock.calls[0][0];
    expect(req.tier).toBe("decide");
    expect(req.responseFormat).toBe("json");
    expect(req.maxOutputTokens).toBe(SPEC_MAX_OUTPUT_TOKENS);
  });
});

/* ============================================================
   记账
   ============================================================ */

describe("规格化阶段 · 记账", () => {
  it("记一条成本流水，阶段标为 spec、档位标为 decide", async () => {
    const h = await run({});
    expect(h.costRecords).toHaveLength(1);
    expect(h.costRecords[0].stage).toBe("spec");
    expect(h.costRecords[0].tier).toBe("decide");
    expect(h.costRecords[0].costCny).toBeCloseTo(0.01, 6);
  });

  it("累计值写进 runs —— 流水说钱花在哪，累计说一共花了多少", async () => {
    const h = await run({ spentCny: 0.5 });
    expect(h.runUpdates).toHaveLength(1);
    expect(h.runUpdates[0].totalCostCny).toBeCloseTo(0.51, 6);
  });

  it("【关键】模型返回不可解析时**照样记账** —— 钱已经花了", async () => {
    const h = await run({ modelResult: makeResult({ text: "我不想输出 JSON" }) });
    expect(h.costRecords).toHaveLength(1);
    expect(specEvent(h)!.fallback).toBe(true);
  });

  it("记账自身抛错不影响产出", async () => {
    const h = await run({ costThrows: "数据库锁了" });
    expect(h.costRecords).toHaveLength(0);
    // 规格照样产出了
    expect(specEvent(h)).toBeDefined();
    expect(specEvent(h)!.fallback).toBe(false);
  });
});

/* ============================================================
   降级
   ============================================================ */

describe("规格化阶段 · 降级", () => {
  it("模型返回一坨非 JSON：降级为兜底规格，并说明原因", async () => {
    const h = await run({ modelResult: makeResult({ text: "我觉得这个需求挺清楚的" }) });
    const e = specEvent(h)!;
    expect(e.fallback).toBe(true);
    expect(e.spec.acceptance.length).toBeGreaterThan(0);

    const err = h.events.find(
      (x): x is Extract<SpecStageEvent, { kind: "error" }> => x.kind === "error",
    );
    expect(err).toBeDefined();
    expect(err!.message).toContain("没法解析");
  });

  it("【关键】降级之后兜底规格本身能过门禁 —— 不能把用户卡死", async () => {
    const h = await run({ modelResult: makeResult({ text: "随便说点什么" }) });
    expect(specEvent(h)!.gate.pass).toBe(true);
  });

  it("调用模型本身失败：也降级，产物照样出", async () => {
    const h = await run({ modelThrows: "网络超时" });
    const e = specEvent(h)!;
    expect(e.fallback).toBe(true);
    expect(h.saved).toHaveLength(1);

    const err = h.events.find(
      (x): x is Extract<SpecStageEvent, { kind: "error" }> => x.kind === "error",
    );
    expect(err!.message).toContain("调用模型失败");
  });

  it("调用失败时不记账（没有产生费用）", async () => {
    const h = await run({ modelThrows: "网络超时" });
    expect(h.costRecords).toHaveLength(0);
  });

  it("输出被截断时明确提醒，但不降级 —— 截断出来的内容往往还能用", async () => {
    const h = await run({ modelResult: makeResult({ truncated: true }) });
    expect(specEvent(h)!.fallback).toBe(false);
    const err = h.events.find(
      (x): x is Extract<SpecStageEvent, { kind: "error" }> => x.kind === "error",
    );
    expect(err!.message).toContain("截断");
  });
});

/* ============================================================
   预算与落盘
   ============================================================ */

describe("规格化阶段 · 预算闸门", () => {
  it("【关键】已经超预算时**根本不发起调用** —— 不能花完才说超了", async () => {
    const h = await run({ spentCny: 5, costLimitCny: 5 });
    expect(h.modelCalls).toBe(0);
    expect(h.costRecords).toHaveLength(0);
    const err = h.events.find(
      (x): x is Extract<SpecStageEvent, { kind: "error" }> => x.kind === "error",
    );
    expect(err!.message).toContain("达到上限");
  });

  it("没超预算时正常调用", async () => {
    const h = await run({ spentCny: 1, costLimitCny: 5 });
    expect(h.modelCalls).toBe(1);
  });
});

describe("规格化阶段 · 落盘失败", () => {
  it("写盘失败不降级 —— 规格已经拿到了，用户能看见", async () => {
    const h = await run({ artifactThrows: "磁盘只读" });
    expect(specEvent(h)!.fallback).toBe(false);
    const err = h.events.find(
      (x): x is Extract<SpecStageEvent, { kind: "error" }> => x.kind === "error",
    );
    expect(err!.message).toContain("写入");
  });

  it("写盘失败要说出来 —— 静默丢产物是最难查的一类问题", async () => {
    const h = await run({ artifactThrows: "磁盘只读" });
    expect(h.events.some((e) => e.kind === "error")).toBe(true);
  });
});

/* ============================================================
   事件顺序
   ============================================================ */

describe("规格化阶段 · 事件顺序", () => {
  it("先报阶段、再用量、再规格、最后收尾", async () => {
    const h = await run({});
    const kinds = h.events.map((e) => e.kind);
    expect(kinds[0]).toBe("phase");
    expect(kinds).toContain("usage");
    expect(kinds).toContain("spec");
    expect(kinds[kinds.length - 1]).toBe("phase");
  });

  it("用量事件在规格事件之前 —— 界面上的钱要比结论先到", async () => {
    const h = await run({});
    const usageIdx = h.events.findIndex((e) => e.kind === "usage");
    const specIdx = h.events.findIndex((e) => e.kind === "spec");
    expect(usageIdx).toBeGreaterThanOrEqual(0);
    expect(usageIdx).toBeLessThan(specIdx);
  });

  it("收尾的阶段标签里带上规格摘要，用户不用点开就知道结果", async () => {
    const h = await run({});
    const last = h.events[h.events.length - 1] as Extract<SpecStageEvent, { kind: "phase" }>;
    expect(last.label).toContain("验收标准");
  });

  it("有未回答的问题时，收尾标签说的是需要确认而不是已就绪", async () => {
    const withQuestions = JSON.stringify({
      goal: "看板",
      audience: "小团队",
      scenarios: ["新建", "拖动", "刷新"],
      acceptance: [
        { statement: "能新建", verifyBy: "点按钮", level: "must" },
        { statement: "能拖动", verifyBy: "拖一下", level: "must" },
        { statement: "能删除", verifyBy: "点删除", level: "should" },
        { statement: "能筛选", verifyBy: "选条件", level: "should" },
      ],
      scope: { inScope: ["看板"], outOfScope: ["不做账号"] },
      questions: ["要不要多人协作？"],
    });
    const h = await run({ modelResult: makeResult({ text: withQuestions }) });
    expect(specEvent(h)!.gate.pass).toBe(false);
    const last = h.events[h.events.length - 1] as Extract<SpecStageEvent, { kind: "phase" }>;
    expect(last.label).toContain("确认");
  });
});