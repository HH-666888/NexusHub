import { describe, expect, it } from "vitest";
import { generateApp, type GenerateEvent } from "@/core/generate/service";
import { buildAssemblePrompt, type BuildBatch, type ModuleBuild } from "@/core/domain/module-build";
import type { ArtifactStore } from "@/core/ports/artifact-store";
import type { CostStore } from "@/core/ports/cost-store";
import type { RunStore } from "@/core/ports/run-store";
import type { ModelChunk, ModelPort, ModelRequest, ModelResult } from "@/core/ports/model";
import type { Artifact, NewArtifact } from "@/core/domain/artifact";
import type { NewCostRecord } from "@/core/domain/cost";

/**
 * 生成编排（装配那一段）：单测
 * ============================================================
 * 这个文件是**这一期那条诚实约束的守门人**：
 *
 *   并行构建的产出必须真的喂给最终产物 ——
 *   不是"并行跑 N 次、结果扔掉、最后照旧单次生成"。
 *
 * 五条按重要性排：
 *   ⑧ 不传 batch → 行为与改动之前**完全一致**（旧路径不许坏）；
 *   ⑨ 传 batch   → 装配那一次的**用户消息里真的带上了各模块的代码片段**；
 *   ⑩ 产物含片段 → 新检查通过；
 *   ⑪ ★ 探针 ★ 产物**不含**片段 → 新检查必须红，而且指名道姓说是哪个模块；
 *   ⑫ 不传 batch → 那条新检查**根本不出现**（不占名额、不计入通过数）。
 *
 * ⑪ 和 ⑫ 是这个文件存在的理由：
 *   只有 ⑩ 的话，"新检查"完全可能是一条永远为真的假断言，
 *   而假断言比没有断言更糟 —— 它会让人以为这件事被验过了。
 */

/* ============================================================
   夹具
   ============================================================ */

const PROMPT = "做一个团队任务看板";

/**
 * 一份"合格"的自包含页面。
 *
 * ⚠️ 基础样式里**刻意不出现任何模块名**（没有 .task-store-box 这种类名）：
 *    探针那条用例要的是"产物里一个模块特征都没有"，
 *    夹具自己带一个模块类名的话，那条断言会因为夹具而变成半绿，
 *    验到的就不是"表演式并行会被拦下"了。
 */
function htmlWith(fragments: string[]): string {
  return [
    "<!DOCTYPE html>",
    '<html lang="zh-CN"><head><meta charset="utf-8">',
    "<style>body{background:#0f172a;color:#e2e8f0} #board{display:flex}</style>",
    "</head><body>",
    "<h1>团队任务看板</h1>",
    "<p>这是并行构建出来的几个模块拼成的页面，中文文案足够通过检查。</p>",
    ...fragments,
    "<script>",
    "  const KEY = 'tasks';",
    "  function boot(){ document.querySelector('#board').addEventListener('click', () => { localStorage.setItem(KEY, '[]'); }); }",
    "  boot();",
    "</script>",
    "</body></html>",
  ].join("\n");
}

/** 一份"没有模块代码"的页面：七项全过，但没有任何模块特征片段 */
const PLAIN_HTML = htmlWith(["<section id='board'>看板</section>"]);

/** 一份含模块特征片段的页面 */
const HTML_WITH_MODULES = htmlWith([
  '<section data-module="task-store" class="task-store-box">任务存储</section>',
  '<section data-module="board-ui" class="board-ui-box">看板</section>',
  "<script>function taskStoreInit(){ return 1; } function boardUiInit(){ return 2; }</script>",
]);

function moduleBuild(over: Partial<ModuleBuild> & { moduleId: string }): ModuleBuild {
  return {
    summary: `${over.moduleId} 做好了`,
    html: `<section data-module="${over.moduleId}"></section>`,
    css: `.${over.moduleId}-box{color:red}`,
    js: `function ${over.moduleId.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())}Init(){}`,
    costCny: 0.01,
    usage: {
      inputTokens: 10,
      outputTokens: 20,
      reasoningTokens: 0,
      cacheHitTokens: 0,
      cacheMissTokens: 10,
    },
    model: "fake-model",
    priceTier: "offPeak",
    latencyMs: 5,
    truncated: false,
    ...over,
  };
}

const BATCH: BuildBatch = {
  modules: [moduleBuild({ moduleId: "task-store" }), moduleBuild({ moduleId: "board-ui" })],
  failed: [],
  concurrency: 3,
  totalCostCny: 0.02,
  totalUsage: {
    inputTokens: 20,
    outputTokens: 40,
    reasoningTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 20,
  },
  wallClockMs: 12,
  peakInFlight: 2,
};

/* ============================================================
   假端口
   ============================================================ */

interface Harness {
  events: GenerateEvent[];
  requests: ModelRequest[];
  saved: Array<Omit<NewArtifact, "bytes" | "sha256"> & { content: string }>;
  costRecords: NewCostRecord[];
  runUpdates: Array<Record<string, unknown>>;
}

function makeResult(text: string, over: Partial<ModelResult> = {}): ModelResult {
  return {
    text,
    reasoning: "",
    usage: {
      inputTokens: 100,
      outputTokens: 200,
      reasoningTokens: 0,
      cacheHitTokens: 0,
      cacheMissTokens: 100,
    },
    costCny: 0.05,
    priceTier: "offPeak",
    model: "fake-model",
    latencyMs: 900,
    truncated: false,
    finishReason: "stop",
    ...over,
  };
}

async function run(opts: {
  /** 装配那一次返回的正文 */
  text?: string;
  batch?: BuildBatch | null;
  spentCny?: number;
  costLimitCny?: number;
  modelThrows?: string;
}): Promise<Harness> {
  const h: Harness = {
    events: [],
    requests: [],
    saved: [],
    costRecords: [],
    runUpdates: [],
  };

  const model: ModelPort = {
    async complete(): Promise<ModelResult> {
      // 装配走的是流式（用户要看着它一个字一个字写出来）
      throw new Error("装配不该走 complete");
    },
    async *stream(req: ModelRequest): AsyncIterable<ModelChunk> {
      h.requests.push(req);
      if (opts.modelThrows) throw new Error(opts.modelThrows);
      const text = opts.text ?? PLAIN_HTML;
      yield { kind: "reasoning", delta: "先把结构想清楚" };
      yield { kind: "text", delta: text };
      yield { kind: "done", result: makeResult(text) };
    },
  };

  const artifacts: ArtifactStore = {
    async save(data): Promise<Artifact> {
      h.saved.push(data);
      return {
        id: h.saved.length,
        runId: data.runId,
        kind: data.kind,
        path: data.path,
        bytes: data.content.length,
        sha256: "x".repeat(64),
        createdAt: 0,
      };
    },
    async listByRun(): Promise<Artifact[]> {
      return [];
    },
    async findLatest(): Promise<Artifact | null> {
      return null;
    },
    async readContent(): Promise<string | null> {
      return null;
    },
    async removeByRun(): Promise<number> {
      return 0;
    },
  };

  const runs: RunStore = {
    async create() {
      throw new Error("用不到");
    },
    async findById() {
      return null;
    },
    async listByUser() {
      return [];
    },
    async update(_id, patch) {
      h.runUpdates.push(patch);
    },
    async remove() {
      return false;
    },
    async countByUser() {
      return 0;
    },
  };

  const costs: CostStore = {
    async record(data) {
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
  };

  for await (const e of generateApp(
    { model, artifacts, runs, costs },
    {
      runId: "run-1",
      prompt: PROMPT,
      costLimitCny: opts.costLimitCny ?? 5,
      spentCny: opts.spentCny ?? 0,
      batch: opts.batch,
    },
  )) {
    h.events.push(e);
  }
  return h;
}

const checksOf = (h: Harness) =>
  h.events.flatMap((e) => (e.kind === "check" ? e.results : []));
const summaryOf = (h: Harness) =>
  h.events.flatMap((e) => (e.kind === "check" ? [e.summary] : []))[0];
const userMessageOf = (h: Harness): string => {
  const user = h.requests[0]?.messages.find((m) => m.role === "user");
  return typeof user?.content === "string" ? user.content : "";
};

/* ============================================================
   ⑧ 不传 batch：旧路径一个字节都不许变
   ============================================================ */

describe("⑧ 不传 batch → 行为与改动之前完全一致", () => {
  it("用户消息就是那句原话，没有多出任何东西", async () => {
    const h = await run({});
    expect(h.requests).toHaveLength(1);
    expect(userMessageOf(h)).toBe(PROMPT);
  });

  it("检查项仍然是原来那七项，数量与名字都不变", async () => {
    const h = await run({});
    const checks = checksOf(h);

    expect(checks).toHaveLength(7);
    expect(checks.map((c) => c.name)).not.toContain("模块代码确实进入了产物");
    expect(summaryOf(h)).toMatchObject({ total: 7, passed: 7, failed: 0 });
  });

  it("事件序列与改动之前一致：phase → reasoning → text → usage → check → artifact → done", async () => {
    const h = await run({});
    const kinds = h.events.map((e) => e.kind);

    expect(kinds[0]).toBe("phase");
    expect(kinds.filter((k) => k === "usage")).toHaveLength(1);
    expect(kinds.filter((k) => k === "check")).toHaveLength(1);
    expect(kinds.filter((k) => k === "artifact")).toHaveLength(1);
    // 收尾那条 phase 必须是 done
    const last = h.events[h.events.length - 1];
    expect(last.kind === "phase" && last.phase).toBe("done");
    // 装的是原样提取出来的 HTML
    expect(h.saved[0]?.content).toBe(PLAIN_HTML);
  });

  it("花费记账只记装配那一次（模块那几笔由编排层记，这里不重复记）", async () => {
    const h = await run({ spentCny: 0.3 });
    expect(h.costRecords).toHaveLength(1);
    expect(h.costRecords[0].costCny).toBeCloseTo(0.05, 6);
    expect(h.costRecords[0].stage).toBe("build");
    // 累计值 = 传进来的 spent + 这一次装配
    const total = h.runUpdates.find((u) => "totalCostCny" in u);
    expect(total?.totalCostCny).toBeCloseTo(0.35, 6);
  });
});

/* ============================================================
   ⑨ 传 batch：模块产出真的进了装配提示词
   ============================================================ */

describe("⑨ 传 batch → 装配的用户消息里带上了各模块的代码片段", () => {
  it("每个模块的 html / css / js 片段都真的在装配提示词里", async () => {
    const h = await run({ batch: BATCH, text: HTML_WITH_MODULES });
    const user = userMessageOf(h);

    expect(user).toContain(PROMPT); // 原话仍然在最前面
    for (const m of BATCH.modules) {
      expect(user).toContain(`data-module="${m.moduleId}"`);
      expect(user).toContain(m.css);
      expect(user).toContain(m.js);
    }
    // 逐段标明了是哪个模块 —— 装配时认领的依据
    expect(user).toContain("task-store");
    expect(user).toContain("board-ui");
  });

  it("提示词与 buildAssemblePrompt 逐字一致（不是另拼一份）", async () => {
    const h = await run({ batch: BATCH, text: HTML_WITH_MODULES });
    expect(userMessageOf(h)).toBe(buildAssemblePrompt({ prompt: PROMPT, batch: BATCH }));
  });

  it("阶段文案说清楚这次是「装配」而不是从头写", async () => {
    const h = await run({ batch: BATCH, text: HTML_WITH_MODULES });
    const first = h.events[0];
    expect(first.kind === "phase" && first.label).toContain("装配");
  });

  it("失败的模块也会被写进提示词：不替它编，是这一段的诚实要求", async () => {
    const batch: BuildBatch = {
      ...BATCH,
      failed: [
        {
          moduleId: "local-persistence",
          message: "调用模型失败：超时",
          costCny: 0,
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
            cacheHitTokens: 0,
            cacheMissTokens: 0,
          },
          model: null,
          priceTier: null,
          latencyMs: 3,
        },
      ],
    };
    const h = await run({ batch, text: HTML_WITH_MODULES });
    const user = userMessageOf(h);

    expect(user).toContain("local-persistence");
    expect(user).toContain("超时");
    expect(user).toContain("不要替它们编造");
  });
});

/* ============================================================
   ⑩ / ⑪ 新检查：产物里到底有没有模块代码
   ============================================================ */

describe("⑩ 产物真的包含模块代码 → 新检查通过", () => {
  it("多出第八项「模块代码确实进入了产物」，且它是通过的", async () => {
    const h = await run({ batch: BATCH, text: HTML_WITH_MODULES });
    const checks = checksOf(h);
    const probe = checks.find((c) => c.name === "模块代码确实进入了产物");

    expect(checks).toHaveLength(8); // 七项老的 + 这一项
    expect(probe).toBeDefined();
    expect(probe?.pass).toBe(true);
    expect(probe?.detail).toContain('data-module="task-store"');
    expect(summaryOf(h)).toMatchObject({ total: 8, passed: 8, failed: 0 });
  });

  it("七个老检查仍然各自独立地判（新检查不是替代它们）", async () => {
    const h = await run({ batch: BATCH, text: HTML_WITH_MODULES });
    const names = checksOf(h).map((c) => c.name);

    expect(names).toContain("完整 HTML 结构");
    expect(names).toContain("完全自包含（无外部引用）");
    expect(names).toContain("数据能持久化");
    expect(names.indexOf("模块代码确实进入了产物")).toBe(7); // 追加在最后
  });
});

describe("⑪ ★ 探针：产物里没有模块代码 → 新检查必须不通过 ★", () => {
  it("七项全过但一个模块片段都没有 → 第八项红，并指名道姓说是哪个模块", async () => {
    /*
      ★★★ 这一条是"表演式并行"的探针 ★★★

      场景就是那件必须被拦住的事：并行跑了几次、结果扔掉了，
      最后照旧单次生成一份完整的页面。
      那份页面**七项检查全过**（结构完整、内联、自包含、能交互、
      能持久化、中文、无外链）—— 旧的检查体系完全看不出问题。
      而"并行构建"这四个字是假的。

      所以这里断言两件事，缺一不可：
        ① 第八项**必须红**（只有第七项之前那些绿的话，这条特性等于没验）；
        ② detail 里必须说出**是哪个模块**的哪一段没找到 ——
           "有模块没进去"和"哪个模块没进去"是两条不同的信息，
           后者才是用户能拿去处置的。
    */
    const h = await run({ batch: BATCH, text: PLAIN_HTML });
    const checks = checksOf(h);
    const probe = checks.find((c) => c.name === "模块代码确实进入了产物");

    // 前提：这份产物确实能过原来那七项 —— 否则红是因为别的原因，探针就没意义了
    expect(checks.filter((c) => c.name !== "模块代码确实进入了产物")).toHaveLength(7);
    expect(summaryOf(h)?.failures.map((f) => f.name)).toEqual(["模块代码确实进入了产物"]);

    expect(probe?.pass, "产物里没有模块代码，第八项却是绿的 —— 这条检查是假的").toBe(false);
    expect(probe?.detail).toContain("task-store");
    expect(probe?.detail).toContain("board-ui");
    expect(probe?.detail).toContain("找不到");
  });

  it("只差一个模块也要红，而且只报缺的那一个", async () => {
    // 两个模块一个进了一个没进 —— "部分进去"不能算通过
    const html = htmlWith(['<section data-module="task-store" class="task-store-box"></section>']);
    const h = await run({ batch: BATCH, text: html });
    const probe = checksOf(h).find((c) => c.name === "模块代码确实进入了产物");

    expect(probe?.pass).toBe(false);
    expect(probe?.detail).toContain("board-ui");
    expect(probe?.detail).not.toContain("模块 task-store");
  });

  it("一个成功模块都没有（全失败）→ 不通过，并说明没有可核对的东西", async () => {
    const batch: BuildBatch = {
      ...BATCH,
      modules: [],
      failed: [
        {
          moduleId: "task-store",
          message: "调用模型失败：超时",
          costCny: 0,
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
            cacheHitTokens: 0,
            cacheMissTokens: 0,
          },
          model: null,
          priceTier: null,
          latencyMs: 1,
        },
      ],
    };
    const h = await run({ batch, text: HTML_WITH_MODULES });
    const probe = checksOf(h).find((c) => c.name === "模块代码确实进入了产物");

    expect(probe?.pass).toBe(false);
    expect(probe?.detail).toContain("没有任何成功模块");
    expect(summaryOf(h)?.failed).toBe(1);
  });

  it("失败的模块没有产出可核对，但它也不会把这条检查弄红（成功的都进去了）", async () => {
    const batch: BuildBatch = {
      ...BATCH,
      failed: [
        {
          moduleId: "local-persistence",
          message: "产出无法使用：JSON 解析失败",
          costCny: 0.02,
          usage: {
            inputTokens: 5,
            outputTokens: 5,
            reasoningTokens: 0,
            cacheHitTokens: 0,
            cacheMissTokens: 0,
          },
          model: "fake-model",
          priceTier: "offPeak",
          latencyMs: 9,
        },
      ],
    };
    const h = await run({ batch, text: HTML_WITH_MODULES });
    const probe = checksOf(h).find((c) => c.name === "模块代码确实进入了产物");

    expect(probe?.pass).toBe(true);
    // 但它的失败要在 detail 里如实说出来，不能被"通过"两个字盖住
    expect(probe?.detail).toContain("1 个模块构建失败");
    expect(summaryOf(h)?.failed).toBe(0);
  });

  it("产物被截断（没有 </html>）时，模块片段那条照样按事实判", async () => {
    // 两条检查各判各的：结构那条红，模块那条绿 —— 它们回答的不是同一个问题
    const truncated = HTML_WITH_MODULES.replace("</html>", "");
    const h = await run({ batch: BATCH, text: truncated });
    const checks = checksOf(h);

    expect(checks.find((c) => c.name.includes("完整"))?.pass).toBe(false);
    expect(checks.find((c) => c.name === "模块代码确实进入了产物")?.pass).toBe(true);
  });
});

/* ============================================================
   ⑫ 不传 batch：新检查不适用
   ============================================================ */

describe("⑫ 不传 batch → 新检查不适用（不占名额、不计入通过数）", () => {
  it("传 null 与不传，结果完全一样：只有七项", async () => {
    const withoutBatch = await run({});
    const withNull = await run({ batch: null });

    expect(checksOf(withoutBatch)).toHaveLength(7);
    expect(checksOf(withNull)).toHaveLength(7);
    expect(summaryOf(withNull)).toEqual(summaryOf(withoutBatch));
    expect(userMessageOf(withNull)).toBe(userMessageOf(withoutBatch));
  });

  it("总结里 total 仍然是 7 —— 没有拿一个没跑过的检查充数", async () => {
    /*
      另一种口径是"标成'未做并行构建'但计入通过数"。
      那样 `8/8 通过` 会被读成"连并行构建都验过了"，
      而实际上这一项什么都没查。宁可它不存在。
    */
    const h = await run({});
    const summary = summaryOf(h);

    expect(summary?.total).toBe(7);
    expect(summary?.passed).toBe(7);
    expect(summary?.failures).toEqual([]);
    expect(checksOf(h).some((c) => c.name.includes("模块代码"))).toBe(false);
  });
});

/* ============================================================
   兜底：装配本身失败时的行为不受影响
   ============================================================ */

describe("装配那一次调用失败时的行为不变", () => {
  it("模型抛错 → error 事件 + failed 收尾，不落盘", async () => {
    const h = await run({ batch: BATCH, modelThrows: "连接断开" });

    expect(h.saved).toHaveLength(0);
    expect(h.events.some((e) => e.kind === "error")).toBe(true);
    const last = h.events[h.events.length - 1];
    expect(last.kind === "phase" && last.phase).toBe("failed");
  });

  it("预算已经到顶 → 一次模型调用都不发（传了 batch 也一样）", async () => {
    const h = await run({ batch: BATCH, spentCny: 5, costLimitCny: 5 });

    expect(h.requests).toHaveLength(0);
    const err = h.events.find((e) => e.kind === "error");
    expect(err && err.kind === "error" && err.message).toContain("达到上限");
  });
});