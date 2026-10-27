import { describe, expect, it } from "vitest";
import {
  completeWithTruncationRetry,
  MAX_OUTPUT_TOKENS_CEILING,
} from "@/core/generate/truncation-retry";
import type { ModelPort, ModelRequest, ModelResult } from "@/core/ports/model";

/**
 * 「截断即加倍预算重试」：单测
 * ============================================================
 * 这一条是拿三次真实运行的教训换来的（模块 6000/16384/32768 都被顶满过），
 * 所以下面每一条正例都配一条反例 —— 尤其是"**没截断时一次都不许多调**"，
 * 它的反面（无脑重试）会让每一次运行的钱凭空翻倍，而且看不出来。
 */

function result(over: Partial<ModelResult> = {}): ModelResult {
  return {
    text: "{}",
    reasoning: "",
    usage: {
      inputTokens: 10,
      outputTokens: 20,
      reasoningTokens: 0,
      cacheHitTokens: 0,
      cacheMissTokens: 10,
    },
    costCny: 0.01,
    priceTier: "offPeak",
    model: "fake-model",
    latencyMs: 5,
    truncated: false,
    finishReason: "stop",
    ...over,
  };
}

interface Harness {
  calls: ModelRequest[];
}

/** 按顺序吐结果；跑完了还调就抛错（那正说明"多调了"） */
function makeModel(plan: Array<Partial<ModelResult> | { throws: string }>): {
  model: ModelPort;
  h: Harness;
} {
  const h: Harness = { calls: [] };
  const model: ModelPort = {
    async complete(req: ModelRequest): Promise<ModelResult> {
      h.calls.push(req);
      const step = plan[h.calls.length - 1];
      if (step === undefined) {
        throw new Error(`不该有第 ${h.calls.length} 次调用 —— 重试次数超了`);
      }
      if ("throws" in step) throw new Error(step.throws);
      return result(step);
    },
    async *stream(): AsyncIterable<never> {
      throw new Error("这个助手只走 complete，不该走流式");
    },
  };
  return { model, h };
}

const BASE: ModelRequest = {
  tier: "execute",
  messages: [{ role: "user", content: "写一个模块" }],
  maxOutputTokens: 8192,
};

describe("截断重试 · 该重试的时候", () => {
  it("【关键】第一次被截断 → 加倍预算重试一次，并以第二次为准", async () => {
    const { model, h } = makeModel([{ truncated: true }, { truncated: false, text: "完整产物" }]);
    const out = await completeWithTruncationRetry(model, BASE);

    expect(h.calls).toHaveLength(2);
    expect(h.calls[0].maxOutputTokens).toBe(8192);
    expect(h.calls[1].maxOutputTokens).toBe(16384); // 加倍
    expect(out.calls).toBe(2);
    expect(out.retriedWithMaxTokens).toBe(16384);
    expect(out.stillTruncated).toBe(false);
    expect(out.result.text).toBe("完整产物");
  });

  it("两次调用的结果**都**带出来 —— 第一次那笔钱也要记账", async () => {
    const first = { truncated: true, costCny: 0.07, usage: { outputTokens: 900 } };
    const second = { truncated: false, costCny: 0.02 };
    const { model } = makeModel([first, second]);
    const out = await completeWithTruncationRetry(model, BASE);

    expect(out.attempts).toHaveLength(2);
    expect(out.attempts[0].costCny).toBe(0.07);
    expect(out.attempts[1].costCny).toBe(0.02);
    // 顺序不能反：账本要按发生顺序记
    expect(out.attempts[0].truncated).toBe(true);
    expect(out.attempts[1].truncated).toBe(false);
  });

  it("请求的其它字段原样带过去（只改预算，别的一个字不动）", async () => {
    const req: ModelRequest = {
      ...BASE,
      tier: "decide",
      effort: "high",
      responseFormat: "json",
      temperature: 0.3,
    };
    const { model, h } = makeModel([{ truncated: true }, {}]);
    await completeWithTruncationRetry(model, req);

    const second = h.calls[1];
    expect(second.tier).toBe("decide");
    expect(second.effort).toBe("high");
    expect(second.responseFormat).toBe("json");
    expect(second.temperature).toBe(0.3);
    expect(second.messages).toEqual(req.messages);
  });
});

describe("截断重试 · 不该重试的时候（反例）", () => {
  it("★ 反例：没被截断 → **一次都不许多调**（无脑重试会让钱凭空翻倍）", async () => {
    const { model, h } = makeModel([{ truncated: false }]);
    const out = await completeWithTruncationRetry(model, BASE);

    expect(h.calls).toHaveLength(1);
    expect(out.calls).toBe(1);
    expect(out.retriedWithMaxTokens).toBeNull();
    expect(out.stillTruncated).toBe(false);
  });

  it("★ 反例：调用本身抛错 → 不重试，异常原样往上抛", async () => {
    const { model, h } = makeModel([{ throws: "网络断了" }]);
    await expect(completeWithTruncationRetry(model, BASE)).rejects.toThrow("网络断了");
    expect(h.calls).toHaveLength(1);
  });

  it("★ 反例：没给 maxOutputTokens（用的是适配器默认值）→ 不重试，如实报截断", async () => {
    const { model, h } = makeModel([{ truncated: true }]);
    const out = await completeWithTruncationRetry(model, {
      tier: "execute",
      messages: BASE.messages,
    });

    expect(h.calls).toHaveLength(1); // 看不见的预算没法"加倍"，不许猜
    expect(out.calls).toBe(1);
    expect(out.stillTruncated).toBe(true);
    expect(out.retriedWithMaxTokens).toBeNull();
  });

  it("★ 反例：预算已经顶到上限 → 不重试（加倍等于没加）", async () => {
    const { model, h } = makeModel([{ truncated: true }]);
    const out = await completeWithTruncationRetry(model, {
      ...BASE,
      maxOutputTokens: MAX_OUTPUT_TOKENS_CEILING,
    });

    expect(h.calls).toHaveLength(1);
    expect(out.stillTruncated).toBe(true);
    expect(out.retriedWithMaxTokens).toBeNull();
  });
});

describe("截断重试 · 加倍的边界", () => {
  it("加倍不会超过实测上限：100000 → 131072（而不是 200000）", async () => {
    const { model, h } = makeModel([{ truncated: true }, {}]);
    const out = await completeWithTruncationRetry(model, { ...BASE, maxOutputTokens: 100000 });

    expect(h.calls[1].maxOutputTokens).toBe(MAX_OUTPUT_TOKENS_CEILING);
    expect(out.retriedWithMaxTokens).toBe(MAX_OUTPUT_TOKENS_CEILING);
  });

  it("131072 的一半加倍后正好是上限：65536 → 131072", async () => {
    const { model, h } = makeModel([{ truncated: true }, {}]);
    await completeWithTruncationRetry(model, { ...BASE, maxOutputTokens: 65536 });
    expect(h.calls[1].maxOutputTokens).toBe(131072);
  });

  it("【关键】重试之后**仍然**被截断 → 如实标记 stillTruncated（不许当成功）", async () => {
    const { model, h } = makeModel([{ truncated: true }, { truncated: true }]);
    const out = await completeWithTruncationRetry(model, BASE);

    expect(h.calls).toHaveLength(2); // 只重试一次，不无限重试
    expect(out.calls).toBe(2);
    expect(out.stillTruncated).toBe(true);
    // 仍然把第二次的内容带出来 —— 它比第一次多一些，调用方自己决定怎么用
    expect(out.result.truncated).toBe(true);
  });
});

describe("截断重试 · 重试那一次自己失败（最容易漏账的一种）", () => {
  it("【关键】重试抛错 → **不往上抛**，把第一次的结果带出来并说清重试失败", async () => {
    /*
      为什么这一条最要紧：第一次调用是成功返回的、钱已经花掉了。
      如果把重试的异常往上抛，调用方只会记一笔"失败、花费 0" ——
      那笔真花掉的钱就凭空消失了。这个坑和"解析失败也要记账"是同一个。
    */
    const { model, h } = makeModel([{ truncated: true, costCny: 0.07 }, { throws: "网关超时" }]);
    const out = await completeWithTruncationRetry(model, BASE);

    expect(h.calls).toHaveLength(2);
    expect(out.retryError).toBe("网关超时");
    expect(out.calls).toBe(2); // 发起过 2 次
    expect(out.attempts).toHaveLength(1); // 但只拿到 1 个结果
    expect(out.attempts[0].costCny).toBe(0.07); // ★ 那 0.07 元要能被记上
    expect(out.stillTruncated).toBe(true);
    expect(out.retriedWithMaxTokens).toBe(16384);
  });

  it("★ 反例：重试成功时 retryError 必须是 null（别把正常路径也标成失败）", async () => {
    const { model } = makeModel([{ truncated: true }, {}]);
    const out = await completeWithTruncationRetry(model, BASE);
    expect(out.retryError).toBeNull();
  });
});