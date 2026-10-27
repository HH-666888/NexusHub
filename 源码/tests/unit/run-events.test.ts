import { describe, expect, it } from "vitest";
import { recordRunEvents } from "@/core/generate/recorder";
import type { GenerateEvent } from "@/core/generate/service";
import { createInMemoryEventStore } from "@/core/ports/event-store";
import {
  frameAt,
  offsetOfSeq,
  parseRunEvent,
  replayDurationMs,
  serializeRunEvent,
  type RunEvent,
} from "@/core/domain/run-event";

/** 造一个可控的事件流 */
async function* from(events: GenerateEvent[]): AsyncIterable<GenerateEvent> {
  for (const e of events) yield e;
}

/** 把记录器跑完，返回落库的内容 */
async function record(events: GenerateEvent[], opts?: { flushIntervalMs?: number }) {
  const store = createInMemoryEventStore();
  const seen: GenerateEvent[] = [];
  for await (const e of recordRunEvents(from(events), store, "run-1", opts)) {
    seen.push(e);
  }
  return { store, rows: await store.listByRun("run-1"), seen };
}

const text = (delta: string): GenerateEvent => ({ kind: "text", delta });
const think = (delta: string): GenerateEvent => ({ kind: "reasoning", delta });

describe("事件记录器 · 转发", () => {
  it("原样转发每一个事件 —— 实时体验不受记录影响", async () => {
    const events: GenerateEvent[] = [
      { kind: "phase", phase: "generating", label: "模型正在写" },
      text("a"),
      text("b"),
      { kind: "error", message: "炸了" },
    ];
    const { seen } = await record(events);
    expect(seen).toEqual(events);
  });

  it("片段被合并，但事件条数远少于片段数", async () => {
    const events: GenerateEvent[] = [
      text("一"),
      text("二"),
      text("三"),
      text("四"),
      text("五"),
    ];
    const { rows } = await record(events);
    // 五次片段合成一条
    expect(rows.length).toBe(1);
    expect(rows[0].kind).toBe("text");
    expect((rows[0].payload as { delta: string }).delta).toBe("一二三四五");
  });

  it("正文与思考分开合并，不会串在一起", async () => {
    const events: GenerateEvent[] = [
      think("想"),
      text("写"),
      think("再想"),
      text("再写"),
    ];
    const { rows } = await record(events);
    const texts = rows.filter((r) => r.kind === "text");
    const thinks = rows.filter((r) => r.kind === "reasoning");
    expect(texts.length).toBe(1);
    expect(thinks.length).toBe(1);
    expect((texts[0].payload as { delta: string }).delta).toBe("写再写");
    expect((thinks[0].payload as { delta: string }).delta).toBe("想再想");
  });
});

describe("事件记录器 · 顺序", () => {
  it("【关键】非片段事件之前必须先冲刷缓冲区", async () => {
    // usage 若比它前面的正文先落库，回放到那一刻就是钱已经花了、字还没出来。
    const events: GenerateEvent[] = [
      text("先写的字"),
      {
        kind: "usage",
        usage: {
          inputTokens: 1,
          outputTokens: 2,
          reasoningTokens: 0,
          cacheHitTokens: 0,
          cacheMissTokens: 0,
        },
        costCny: 0.5,
        priceTier: "offPeak",
        model: "m",
        latencyMs: 1,
        truncated: false,
      },
      text("后写的字"),
    ];
    const { rows } = await record(events);
    expect(rows.map((r) => r.kind)).toEqual(["text", "usage", "text"]);
    expect((rows[0].payload as { delta: string }).delta).toBe("先写的字");
    expect((rows[2].payload as { delta: string }).delta).toBe("后写的字");
  });

  it("序号从 0 开始且连续 —— 回放要靠它定位", async () => {
    const events: GenerateEvent[] = [
      { kind: "phase", phase: "generating", label: "a" },
      text("x"),
      { kind: "phase", phase: "checking", label: "b" },
      { kind: "phase", phase: "saving", label: "c" },
    ];
    const { rows } = await record(events);
    expect(rows.map((r) => r.seq)).toEqual([0, 1, 2, 3]);
  });

  it("时间戳单调不减", async () => {
    const events: GenerateEvent[] = [text("a"), text("b"), text("c")];
    const { rows } = await record(events, { flushIntervalMs: 0 });
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].at).toBeGreaterThanOrEqual(rows[i - 1].at);
    }
  });
});

describe("事件记录器 · 健壮性", () => {
  it("落库失败不能中断生成 —— 记账是附加能力", async () => {
    const broken = {
      async appendMany() {
        throw new Error("磁盘满了");
      },
      async listByRun() {
        return [];
      },
      async countByRun() {
        return 0;
      },
      async deleteByRun() {
        return 0;
      },
    };
    const events: GenerateEvent[] = [text("a"), { kind: "phase", phase: "done", label: "完" }];
    const seen: GenerateEvent[] = [];
    for await (const e of recordRunEvents(from(events), broken, "r")) {
      seen.push(e);
    }
    // 事件一个不少地转发出来了，生成没被记账失败拖垮
    expect(seen).toEqual(events);
  });

  it("流结束时把最后一点尾巴也写掉", async () => {
    // 最后几个片段还没攒够冲刷条件，流就结束了
    const { rows } = await record([text("尾巴")], { flushIntervalMs: 999_999 });
    expect(rows.length).toBe(1);
    expect((rows[0].payload as { delta: string }).delta).toBe("尾巴");
  });

  it("空流不写任何东西", async () => {
    const { rows } = await record([]);
    expect(rows).toEqual([]);
  });
});

function makeEvents(rows: Array<{ at: number; payload: GenerateEvent }>): RunEvent[] {
  return rows.map((r, i) => ({
    id: i + 1,
    runId: "run-1",
    seq: i,
    at: r.at,
    kind: r.payload.kind,
    payload: r.payload,
  }));
}

describe("回放 · frameAt", () => {
  const events = makeEvents([
    { at: 1000, payload: { kind: "phase", phase: "generating", label: "模型正在写" } },
    { at: 1100, payload: text("你好") },
    { at: 1300, payload: text("，世界") },
    {
      at: 1500,
      payload: {
        kind: "usage",
        usage: {
          inputTokens: 10,
          outputTokens: 20,
          reasoningTokens: 0,
          cacheHitTokens: 0,
          cacheMissTokens: 0,
        },
        costCny: 0.0256,
        priceTier: "offPeak",
        model: "m",
        latencyMs: 500,
        truncated: false,
      },
    },
    {
      at: 1600,
      payload: {
        kind: "check",
        results: [],
        summary: { passed: 7, total: 7, failed: 0, items: [] },
      } as unknown as GenerateEvent,
    },
  ]);

  it("停在 0 毫秒：什么都还没发生", () => {
    const f = frameAt(events, 0);
    expect(f.text).toBe("");
    expect(f.costCny).toBeNull();
    expect(f.checks).toBeNull();
  });

  it("停在中间：只看到那一刻已经发生的事", () => {
    const f = frameAt(events, 150);
    expect(f.text).toBe("你好");
    expect(f.costCny).toBeNull();
    expect(f.phaseLabel).toBe("模型正在写");
  });

  it("【关键】没有花费时不显示 0 —— 0 是「花了零元」，null 是「还不知道」", () => {
    expect(frameAt(events, 150).costCny).toBeNull();
    expect(frameAt(events, 600).costCny).toBeCloseTo(0.0256, 6);
  });

  it("拖到最后：全部信息都在", () => {
    const f = frameAt(events, 9999);
    expect(f.text).toBe("你好，世界");
    expect(f.costCny).toBeCloseTo(0.0256, 6);
    expect(f.checks).toEqual({ passed: 7, total: 7 });
    expect(f.consumed).toBe(5);
  });

  it("时间以第一条事件为基准，不是运行创建时间", () => {
    // 事件从 1000 开始，那么 1000 就该是偏移 0
    expect(frameAt(events, 0).consumed).toBe(1);
  });

  it("空事件列表不炸", () => {
    const f = frameAt([], 100);
    expect(f.text).toBe("");
    expect(f.consumed).toBe(0);
  });
});

describe("回放 · 时长与定位", () => {
  const events = makeEvents([
    { at: 500, payload: text("a") },
    { at: 1500, payload: text("b") },
    { at: 3000, payload: text("c") },
  ]);

  it("总时长是首尾事件之差", () => {
    expect(replayDurationMs(events)).toBe(2500);
  });

  it("少于两条事件时时长为 0", () => {
    expect(replayDurationMs([])).toBe(0);
    expect(replayDurationMs([events[0]])).toBe(0);
  });

  it("按序号定位到对应时刻", () => {
    expect(offsetOfSeq(events, 0)).toBe(0);
    expect(offsetOfSeq(events, 1)).toBe(1000);
    expect(offsetOfSeq(events, 2)).toBe(2500);
  });

  it("序号超出范围时停在末尾，不会越界", () => {
    expect(offsetOfSeq(events, 999)).toBe(2500);
  });
});

describe("事件序列化", () => {
  it("存进去再读出来，内容不变", () => {
    const original: GenerateEvent = text("含换行\n和引号\"的文本");
    const restored = parseRunEvent({
      id: 1,
      runId: "r",
      seq: 0,
      at: 0,
      kind: "text",
      payload: serializeRunEvent(original),
    });
    expect(restored.payload).toEqual(original);
  });
});