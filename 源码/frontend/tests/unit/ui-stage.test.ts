import { describe, expect, it, vi } from "vitest";
import {
  runUiStage,
  UI_ARTIFACT_NAME,
  UI_MAX_OUTPUT_TOKENS,
  type UiStageEvent,
} from "@/core/generate/ui-stage";
import { fallbackUi, parseUi, type UiSpec } from "@/core/domain/ui-spec";
import { inspectUi } from "@/core/generate/ui-check";
import { STAGE_MAP } from "@/core/pipeline/stages";
import type { ArchSpec } from "@/core/domain/arch";
import type { AppSpec } from "@/core/domain/spec";
import type { ModelPort, ModelRequest, ModelResult } from "@/core/ports/model";
import type { ArtifactStore } from "@/core/ports/artifact-store";
import type { CostStore } from "@/core/ports/cost-store";
import type { RunStore } from "@/core/ports/run-store";
import type { NewCostRecord } from "@/core/domain/cost";
import type { NewArtifact } from "@/core/domain/artifact";

/**
 * 保护界面设计阶段：正常产出、兜底两条路径都落盘、预算闸门、记账顺序、
 * 思考事件与兜底标签。假端口代替网络，真实模型一次都不调。
 */
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

/** 上一道工序的产物：两个模块，覆盖规格里全部条目 */
const ARCH: ArchSpec = {
  modules: [
    {
      id: "task-store",
      name: "任务存储",
      responsibility: "任务的增删改与本地持久化",
      dependsOn: [],
      coversFeatures: ["ac-1", "ac-3"],
    },
    {
      id: "board-ui",
      name: "看板界面",
      responsibility: "三栏看板与拖拽交互",
      dependsOn: ["task-store"],
      coversFeatures: ["ac-2"],
    },
  ],
  packages: [{ name: "dayjs", why: "格式化时间" }],
};

// 三条本地检查全过的界面设计 JSON：页面覆盖全部条目、
// 变量都有定义、dataNeeds 指到真实模块。
const GOOD_UI_JSON = JSON.stringify({
  tokens: [
    { name: "--color-surface", value: "#0f172a" },
    { name: "--space-1", value: "8px" },
  ],
  pages: [
    {
      id: "board",
      name: "看板页",
      route: "/",
      coversFeatures: ["ac-1", "ac-2"],
      dataNeeds: ["task-store"],
    },
    {
      id: "archive",
      name: "归档页",
      route: "/archive",
      coversFeatures: ["ac-3"],
      dataNeeds: ["board-ui"],
    },
  ],
  components: [
    {
      id: "task-card",
      name: "任务卡",
      usedOn: ["board"],
      usesTokens: ["--color-surface", "--space-1"],
    },
  ],
});

function makeResult(over: Partial<ModelResult> = {}): ModelResult {
  return {
    text: GOOD_UI_JSON,
    reasoning: "",
    usage: {
      inputTokens: 420,
      outputTokens: 520,
      reasoningTokens: 0,
      cacheHitTokens: 0,
      cacheMissTokens: 420,
    },
    costCny: 0.03,
    priceTier: "offPeak",
    model: "fake-model",
    latencyMs: 1100,
    truncated: false,
    finishReason: "stop",
    ...over,
  };
}

interface Harness {
  events: UiStageEvent[];
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
  arch?: ArchSpec;
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
    // 界面设计阶段不该走流式 —— 产出是 JSON，逐字蹦出来没有意义
    async *stream(): AsyncIterable<never> {
      throw new Error("界面设计阶段不该走流式");
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

  for await (const e of runUiStage(
    { model, artifacts, runs, costs },
    {
      runId: "run-1",
      prompt: "做一个任务看板",
      spec: opts.spec ?? SPEC,
      arch: opts.arch ?? ARCH,
      costLimitCny: opts.costLimitCny ?? 5,
      spentCny: opts.spentCny ?? 0,
    },
  )) {
    h.events.push(e);
  }
  return h;
}

const uiEvent = (h: Harness) =>
  h.events.find((e): e is Extract<UiStageEvent, { kind: "ui" }> => e.kind === "ui");

const errorEvents = (h: Harness) =>
  h.events.filter(
    (e): e is Extract<UiStageEvent, { kind: "error" }> => e.kind === "error",
  );

describe("界面设计阶段 · 正常路径", () => {
  it("产出一条 ui 事件，且不是兜底", async () => {
    const h = await run({});
    const e = uiEvent(h);
    expect(e).toBeDefined();
    expect(e!.fallback).toBe(false);
    expect(e!.ui.pages.map((p) => p.id)).toEqual(["board", "archive"]);
    expect(e!.ui.components.map((c) => c.id)).toEqual(["task-card"]);
    expect(e!.ui.tokens.map((t) => t.name)).toEqual(["--color-surface", "--space-1"]);
  });

  it("事件里带着三条本地检查的结果，而且这份夹具三条全过", async () => {
    const h = await run({});
    const e = uiEvent(h)!;
    expect(e.check.total).toBe(3);
    expect(e.check.passed).toBe(3);
    expect(e.check.results.map((r) => r.pass)).toEqual([true, true, true]);
  });

  it("产出 ui-spec.json（path = <runId>/ui-spec.json，内容是能解析的 JSON）", async () => {
    const h = await run({});
    expect(h.saved).toHaveLength(1);
    expect(h.saved[0].path).toBe(`run-1/${UI_ARTIFACT_NAME}`);
    expect(h.saved[0].kind).toBe("json");

    const parsed = JSON.parse(h.saved[0].content) as UiSpec;
    expect(parsed.pages).toHaveLength(2);
    expect(parsed.components[0].usesTokens).toEqual(["--color-surface", "--space-1"]);
  });

  it("产文件名与 stages.ts 里声明的那个一致 —— 两处写的是同一个字符串", () => {
    // 两处硬编码同一个字符串是有风险的，所以这条断言把它们钉在一起
    expect(UI_ARTIFACT_NAME).toBe("ui-spec.json");
    expect(STAGE_MAP.ui.artifact).toBe(UI_ARTIFACT_NAME);
  });

  it("用了决策级档位，并要求 JSON 输出、带上界面设计的输出上限", async () => {
    // 显式声明参数类型，否则 mock.calls[0] 被推成空元组，取 [0] 会编译不过
    const spy = vi.fn(async (_req: ModelRequest) => makeResult());
    const model = {
      complete: spy,
      stream: async function* () {},
    } as unknown as ModelPort;
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

    for await (const _ of runUiStage(
      { model, artifacts, runs, costs },
      { runId: "r", prompt: "x", spec: SPEC, arch: ARCH, costLimitCny: 5 },
    )) {
      void _;
    }

    const req = spy.mock.calls[0][0];
    expect(req.tier).toBe("decide");
    expect(req.responseFormat).toBe("json");
    expect(req.maxOutputTokens).toBe(UI_MAX_OUTPUT_TOKENS);

    // 规格与架构都必须真的进了提示词 —— 第一条检查要规格，第三条检查要架构
    const userMsg = req.messages.find((m) => m.role === "user")!;
    const content = typeof userMsg.content === "string" ? userMsg.content : "";
    expect(content).toContain("ac-1");
    expect(content).toContain("task-store");
    expect(content).toContain("board-ui");
  });

  it("phase 事件报的是第三道工序自己的 id：ui", async () => {
    const h = await run({});
    const phases = h.events.filter(
      (e): e is Extract<UiStageEvent, { kind: "phase" }> => e.kind === "phase",
    );
    expect(phases.length).toBeGreaterThan(0);
    for (const p of phases) expect(p.phase).toBe("ui");
    expect(phases[0].label).toContain("设计变量");
  });
});

describe("界面设计阶段 · 记账与用量", () => {
  it("usage 事件里的数字**原样来自模型返回**，一个都不估算", async () => {
    const h = await run({});
    const u = h.events.find(
      (e): e is Extract<UiStageEvent, { kind: "usage" }> => e.kind === "usage",
    )!;

    const expected = makeResult();
    expect(u.usage).toEqual(expected.usage);
    expect(u.costCny).toBeCloseTo(expected.costCny, 8);
    expect(u.priceTier).toBe(expected.priceTier);
    expect(u.model).toBe(expected.model);
    expect(u.latencyMs).toBe(expected.latencyMs);
    expect(u.truncated).toBe(expected.truncated);
  });

  it("记一条成本流水，阶段标为 ui、档位标为 decide", async () => {
    const h = await run({});
    expect(h.costRecords).toHaveLength(1);
    expect(h.costRecords[0].stage).toBe("ui");
    expect(h.costRecords[0].tier).toBe("decide");
    expect(h.costRecords[0].costCny).toBeCloseTo(0.03, 8);
  });

  it("累计值写进 runs —— 而且是 spent + 这一次，不是覆盖", async () => {
    const h = await run({ spentCny: 0.5 });
    expect(h.runUpdates).toHaveLength(1);
    expect(h.runUpdates[0].totalCostCny).toBeCloseTo(0.53, 8);
  });

  it("模型返回不可解析时**照样记账** —— 钱已经花了", async () => {
    const h = await run({
      modelResult: makeResult({ text: "我觉得这个界面挺清爽的" }),
    });
    expect(h.costRecords).toHaveLength(1);
    expect(uiEvent(h)!.fallback).toBe(true);
  });

  it("记账自身抛错不影响产出", async () => {
    const h = await run({ costThrows: "数据库锁了" });
    expect(h.costRecords).toHaveLength(0);
    expect(uiEvent(h)).toBeDefined();
    expect(uiEvent(h)!.fallback).toBe(false);
  });
});

describe("界面设计阶段 · 降级", () => {
  it("调用模型本身失败：产出兜底界面（fallback=true）而且**照样落盘**", async () => {
    const h = await run({ modelThrows: "网络超时" });
    const e = uiEvent(h)!;

    expect(e.fallback).toBe(true);
    expect(e.ui.pages.length).toBeGreaterThan(0);
    // 兜底也要落盘 —— 这是从 spec 那道工序学来的一条（那边第一版漏了）
    expect(h.saved).toHaveLength(1);
    expect(h.saved[0].path).toBe(`run-1/${UI_ARTIFACT_NAME}`);

    expect(errorEvents(h)[0].message).toContain("调用模型失败");
  });

  it("返回一坨不是 JSON 的东西：降级为兜底界面，说明原因，并落盘", async () => {
    const h = await run({ modelResult: makeResult({ text: "总之先做两个页面吧" }) });
    const e = uiEvent(h)!;

    expect(e.fallback).toBe(true);
    expect(h.saved).toHaveLength(1);
    expect(errorEvents(h)[0].message).toContain("没法解析");
  });

  it("合法 JSON 但一个页面都没有（pages 为空）→ 同样兜底", async () => {
    // 能解析不等于能用：空界面长不出任务点，第四道也不知道要做几个界面。
    // 说它解析成功只会把空洞带到清单上。
    const h = await run({
      modelResult: makeResult({
        text: JSON.stringify({ tokens: [], pages: [], components: [] }),
      }),
    });

    expect(uiEvent(h)!.fallback).toBe(true);
    expect(errorEvents(h)[0].message).toContain("页面");
  });

  it("兜底界面自己也过得了那三条本地检查（三条全绿都是实话，不是凑绿）", async () => {
    const h = await run({ modelThrows: "网络超时" });
    const e = uiEvent(h)!;

    expect(e.check.total).toBe(3);
    expect(e.check.passed).toBe(3);

    // 第一条：一个页面承接了规格里**全部**条目
    const only = e.ui.pages[0];
    expect([...only.coversFeatures].sort()).toEqual(
      SPEC.acceptance.map((a) => a.id).sort(),
    );
    // 第二条：它只引用自己定义过的变量，一个悬空都没有
    const defined = new Set(e.ui.tokens.map((t) => t.name));
    for (const c of e.ui.components) {
      for (const t of c.usesTokens) expect(defined.has(t)).toBe(true);
    }
    // 第三条：它声明需要架构里**每一个**模块的数据
    expect([...only.dataNeeds].sort()).toEqual(ARCH.modules.map((m) => m.id).sort());
  });

  it("兜底界面能被识别出来（名字里带着兜底标记）", async () => {
    const h = await run({ modelThrows: "网络超时" });
    const e = uiEvent(h)!;
    expect(e.ui.pages.some((p) => p.name.includes("兜底界面"))).toBe(true);

    // domain 层的兜底生成器与这里的产物要一致
    const direct = fallbackUi({
      spec: SPEC,
      arch: ARCH,
      model: "fallback",
      generatedAt: 0,
    });
    expect(direct.pages[0].coversFeatures).toEqual(SPEC.acceptance.map((a) => a.id));
    expect(inspectUi(direct, SPEC, ARCH).passed).toBe(3);
  });

  it("降级时记账照记 —— 模型可能已经吐了一半就被判不可解析", async () => {
    const h = await run({ modelResult: makeResult({ text: "不是 JSON" }) });
    expect(h.costRecords).toHaveLength(1);
  });

  it("输出被截断时明确提醒，但不降级 —— 截断出来的内容往往还能用", async () => {
    const h = await run({ modelResult: makeResult({ truncated: true }) });
    expect(uiEvent(h)!.fallback).toBe(false);
    expect(errorEvents(h)[0].message).toContain("截断");
  });
});

describe("界面设计阶段 · 预算闸门", () => {
  it("已经超预算时**一次模型调用都不发**，只发一条 error", async () => {
    // 闸门必须排在调用之前，否则超预算这句话会在钱花完之后才说出来。
    // 那时它已经不是闸门，只是一句事后通知。
    const h = await run({ spentCny: 5, costLimitCny: 5 });

    expect(h.modelCalls).toBe(0);
    expect(h.costRecords).toHaveLength(0);
    expect(h.saved).toHaveLength(0);
    // 只有一条事件，而且就是那条 error —— 连 phase 都不该发
    expect(h.events).toHaveLength(1);
    expect(h.events[0].kind).toBe("error");
    expect((h.events[0] as Extract<UiStageEvent, { kind: "error" }>).message).toContain(
      "达到上限",
    );
  });

  it("没超预算时正常调用一次", async () => {
    const h = await run({ spentCny: 1, costLimitCny: 5 });
    expect(h.modelCalls).toBe(1);
  });
});

describe("界面设计阶段 · 落盘失败", () => {
  it("写盘失败不降级 —— 界面已经拿到了，事件里也发出去了", async () => {
    const h = await run({ artifactThrows: "磁盘只读" });
    expect(uiEvent(h)!.fallback).toBe(false);
    expect(errorEvents(h)[0].message).toContain("写入");
  });

  it("写盘失败要说出来 —— 静默丢产物是最难查的一类问题", async () => {
    const h = await run({ artifactThrows: "磁盘只读" });
    expect(h.events.some((e) => e.kind === "error")).toBe(true);
  });
});

describe("界面设计阶段 · 事件顺序", () => {
  it("先报阶段、再用量、再界面、最后收尾", async () => {
    const h = await run({});
    const kinds = h.events.map((e) => e.kind);
    expect(kinds[0]).toBe("phase");
    expect(kinds).toContain("usage");
    expect(kinds).toContain("ui");
    expect(kinds[kinds.length - 1]).toBe("phase");
  });

  it("用量事件在界面事件之前 —— 界面上的钱要比结论先到", async () => {
    const h = await run({});
    const usageIdx = h.events.findIndex((e) => e.kind === "usage");
    const uiIdx = h.events.findIndex((e) => e.kind === "ui");
    expect(usageIdx).toBeGreaterThanOrEqual(0);
    expect(usageIdx).toBeLessThan(uiIdx);
  });

  it("收尾的阶段标签里带上界面摘要，用户不用点开就知道结果", async () => {
    const h = await run({});
    const last = h.events[h.events.length - 1] as Extract<
      UiStageEvent,
      { kind: "phase" }
    >;
    expect(last.label).toContain("2 个页面");
    expect(last.label).toContain("界面已设计");
  });

  it("检查没过时，收尾标签说的是哪一条没过，而不是含糊的“已设计”", async () => {
    // 这份界面只覆盖 ac-1，第一条检查会红。
    // 收尾标签必须说出哪一条没过，只写界面已产出会让人以为三条都过了。
    const bad = JSON.stringify({
      tokens: [{ name: "--color-surface", value: "#0f172a" }],
      pages: [
        {
          id: "board",
          name: "看板页",
          route: "/",
          coversFeatures: ["ac-1"],
          dataNeeds: ["task-store"],
        },
      ],
      components: [
        { id: "card", name: "卡", usedOn: ["board"], usesTokens: ["--color-surface"] },
      ],
    });
    const h = await run({ modelResult: makeResult({ text: bad }) });
    const e = uiEvent(h)!;
    expect(e.fallback).toBe(false);
    expect(e.check.passed).toBe(2);

    const last = h.events[h.events.length - 1] as Extract<
      UiStageEvent,
      { kind: "phase" }
    >;
    expect(last.label).toContain("2/3");
    expect(last.label).toContain("页面");
  });
});

describe("解析与兜底的一致性", () => {
  it("阶段用的就是 domain 层的 parseUi —— 判据只有一份", () => {
    // 阶段内部不另写一套解析：两份判据迟早会漂开
    const parsed = parseUi(GOOD_UI_JSON);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.ui.pages.map((p) => p.id)).toEqual(["board", "archive"]);
      expect(inspectUi(parsed.ui, SPEC, ARCH).passed).toBe(3);
    }
  });
});

describe("界面设计阶段 · 思考事件", () => {
  // 这一道也是 complete()，decide 档默认开思考。
  // 思考要发成 reasoning 事件，这是功能不是装饰。
  const THOUGHT = "先在脑子里过一遍：几个页面、共用哪几个变量、每页要哪块数据";

  const thoughts = (h: Harness) =>
    h.events.filter(
      (e): e is Extract<UiStageEvent, { kind: "reasoning" }> => e.kind === "reasoning",
    );

  it("complete() 返回的思考要发成 reasoning 事件，内容一字不改", async () => {
    const h = await run({ modelResult: makeResult({ reasoning: THOUGHT }) });
    const t = thoughts(h);
    expect(t).toHaveLength(1);
    expect(t[0].delta).toBe(THOUGHT);
  });

  it("反例：没有思考时**不发** reasoning 事件 —— 不许拿正文冒充思考", async () => {
    const h = await run({ modelResult: makeResult({ reasoning: "" }) });
    expect(thoughts(h)).toHaveLength(0);
  });

  it("反例：只有空白字符也不发 —— 空白思考等于没思考", async () => {
    const h = await run({ modelResult: makeResult({ reasoning: "\t\n " }) });
    expect(thoughts(h)).toHaveLength(0);
  });

  it("顺序：思考排在 ui 事件之前 —— 读起来就是“先想，再给答案”", async () => {
    const h = await run({ modelResult: makeResult({ reasoning: THOUGHT }) });
    const thinkAt = h.events.findIndex((e) => e.kind === "reasoning");
    const uiAt = h.events.findIndex((e) => e.kind === "ui");
    expect(thinkAt).toBeGreaterThanOrEqual(0);
    expect(thinkAt).toBeLessThan(uiAt);
  });

  it("反例：调用模型就失败时**不可能**有思考事件（压根没有 result）", async () => {
    const h = await run({ modelThrows: "网络超时" });
    expect(thoughts(h)).toHaveLength(0);
    expect(uiEvent(h)!.fallback).toBe(true);
  });

  it("降级路径上的思考照样发 —— 想过了就是想过了，不会因为它没解析成功而丢掉", async () => {
    const h = await run({
      modelResult: makeResult({ text: "这几个页面够了", reasoning: THOUGHT }),
    });
    expect(uiEvent(h)!.fallback).toBe(true);
    expect(thoughts(h)).toHaveLength(1);
    expect(thoughts(h)[0].delta).toBe(THOUGHT);
  });
});

describe("界面设计阶段 · 兜底标签", () => {
  // 兜底界面三条检查照样全绿，所以标签不能只说界面已设计。
  // 这一版没做过设计决策，标签要自报家门。
  const phaseLabels = (h: Harness) =>
    h.events
      .filter((e): e is Extract<UiStageEvent, { kind: "phase" }> => e.kind === "phase")
      .map((e) => e.label);

  it("降级时收尾标签必须自报家门 —— 否则“没做过设计决策”会被说成“已设计”", async () => {
    const h = await run({ modelResult: makeResult({ text: "这几个页面够了" }) });
    expect(uiEvent(h)!.fallback).toBe(true);
    const labels = phaseLabels(h);
    expect(labels[labels.length - 1]).toContain("（兜底）");
    expect(labels[labels.length - 1]).toContain("界面已设计");
  });

  it("反例：正常界面的标签里**不许**出现“（兜底）”—— 防恒真", async () => {
    const h = await run({});
    expect(uiEvent(h)!.fallback).toBe(false);
    expect(phaseLabels(h).some((l) => l.includes("（兜底）"))).toBe(false);
    expect(phaseLabels(h)[phaseLabels(h).length - 1]).toContain("界面已设计：");
  });
});
