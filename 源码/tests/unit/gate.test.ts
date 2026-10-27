import { describe, expect, it } from "vitest";
import {
  answersToContext,
  applyAnswers,
  decideGate,
  isGateResume,
  summarizeAnswers,
  validateAnswers,
  type SpecAnswers,
} from "@/core/generate/gate";
import { fallbackSpec, type AppSpec } from "@/core/domain/spec";

const meta = { prompt: "做一个任务看板", model: "test", generatedAt: 1 };

function specWith(questions: string[]): AppSpec {
  return { ...fallbackSpec(meta), questions };
}

function answersFor(pairs: Array<[string, string]>): SpecAnswers {
  return {
    runId: "run-1",
    answeredAt: 1,
    answers: pairs.map(([question, answer]) => ({ question, answer })),
  };
}

/* ============================================================
   门禁判断
   ============================================================ */

describe("人工门禁 · 该不该停", () => {
  it("没有疑问时不停 —— 不能为了走流程而无谓地拦人", () => {
    const d = decideGate(specWith([]), null);
    expect(d.pause).toBe(false);
    expect(d.pending).toEqual([]);
    expect(d.reason).toContain("可以直接继续");
  });

  it("【关键】有疑问且没答案时必须停 —— 这就是人工门禁", () => {
    const d = decideGate(specWith(["要不要多人协作？"]), null);
    expect(d.pause).toBe(true);
    expect(d.pending).toEqual(["要不要多人协作？"]);
  });

  it("答全了就放行", () => {
    const spec = specWith(["q1", "q2"]);
    const d = decideGate(spec, answersFor([["q1", "要"], ["q2", "不要"]]));
    expect(d.pause).toBe(false);
    expect(d.reason).toContain("都已回答");
  });

  it("只答了一部分：仍然停，且只列没答的那几条", () => {
    const spec = specWith(["q1", "q2", "q3"]);
    const d = decideGate(spec, answersFor([["q1", "要"]]));
    expect(d.pause).toBe(true);
    expect(d.pending).toEqual(["q2", "q3"]);
    expect(d.reason).toContain("还有 2 个");
  });

  it("空白回答不算答过 —— 否则门禁会被一个空格绕过", () => {
    const spec = specWith(["q1"]);
    const d = decideGate(spec, answersFor([["q1", "   "]]));
    expect(d.pause).toBe(true);
    expect(d.pending).toEqual(["q1"]);
  });

  it("答案里混了不相干的问题时，不影响已答的判定", () => {
    const spec = specWith(["q1"]);
    const d = decideGate(spec, answersFor([["别的问题", "随便"], ["q1", "认真的回答"]]));
    expect(d.pause).toBe(false);
  });
});

/* ============================================================
   并回规格
   ============================================================ */

describe("人工门禁 · 把答案并回规格", () => {
  it("答过的问题从规格里清掉", () => {
    const spec = specWith(["q1", "q2"]);
    const merged = applyAnswers(spec, answersFor([["q1", "要"]]));
    expect(merged.questions).toEqual(["q2"]);
  });

  it("【关键】没答的问题留着 —— 门禁会再拦一次，而不是当成默认放弃", () => {
    const spec = specWith(["q1", "q2"]);
    const merged = applyAnswers(spec, answersFor([["q1", "要"]]));
    expect(merged.questions).toContain("q2");
    // 并回去之后再判断，仍然是「该停」
    expect(decideGate(merged, answersFor([["q1", "要"]])).pause).toBe(true);
  });

  it("不改动规格的其它部分", () => {
    const spec = specWith(["q1"]);
    const merged = applyAnswers(spec, answersFor([["q1", "要"]]));
    expect(merged.goal).toBe(spec.goal);
    expect(merged.acceptance).toEqual(spec.acceptance);
    expect(merged.scope).toEqual(spec.scope);
  });
});

/* ============================================================
   校验提交
   ============================================================ */

describe("人工门禁 · 校验用户提交", () => {
  const spec = specWith(["q1", "q2"]);

  it("正常提交", () => {
    const v = validateAnswers(spec, [
      { question: "q1", answer: "要" },
      { question: "q2", answer: "不要" },
    ]);
    expect(v.ok).toBe(true);
    expect(v.answers).toHaveLength(2);
    expect(v.blankCount).toBe(0);
  });

  it("允许留空 —— 用户有权说「你替我决定」", () => {
    const v = validateAnswers(spec, [
      { question: "q1", answer: "要" },
      { question: "q2", answer: "" },
    ]);
    expect(v.ok).toBe(true);
    expect(v.blankCount).toBe(1);
    // 空白也留下，表示「看了但不答」
    expect(v.answers).toHaveLength(2);
  });

  it("【关键】丢掉对应不上任何疑问的回答", () => {
    /*
      不收的话，answers.json 会慢慢攒下与本次规格无关的陈旧内容，
      而且 decideGate 的 pending 计算永远对不上。
    */
    const v = validateAnswers(spec, [
      { question: "q1", answer: "要" },
      { question: "上一个版本的问题", answer: "早就过期了" },
    ]);
    expect(v.answers).toHaveLength(1);
    expect(v.answers[0].question).toBe("q1");
    expect(v.issues.some((s) => s.includes("对应不上"))).toBe(true);
  });

  it("一条有效回答都没有时判为不通过", () => {
    const v = validateAnswers(spec, [{ question: "无关问题", answer: "x" }]);
    expect(v.ok).toBe(false);
  });

  it("回答前后空白被去掉", () => {
    const v = validateAnswers(spec, [{ question: "q1", answer: "  要  " }]);
    expect(v.answers[0].answer).toBe("要");
  });

  it("空提交不通过", () => {
    expect(validateAnswers(spec, []).ok).toBe(false);
  });
});

/* ============================================================
   给模型看的上下文
   ============================================================ */

describe("人工门禁 · 上下文与摘要", () => {
  it("把问答整理成一段可读文本", () => {
    const ctx = answersToContext(answersFor([["要不要登录？", "不要，单机用"]]));
    expect(ctx).toContain("问：要不要登录？");
    expect(ctx).toContain("答：不要，单机用");
  });

  it("没有答案时返回空串，不留一个空标题", () => {
    expect(answersToContext(null)).toBe("");
    expect(answersToContext(answersFor([]))).toBe("");
  });

  it("全是空白的答案不产生上下文", () => {
    expect(answersToContext(answersFor([["q1", "  "]]))).toBe("");
  });

  it("摘要说清楚答了几个", () => {
    expect(summarizeAnswers(null)).toContain("还没有回答");
    expect(summarizeAnswers(answersFor([["q1", "a"], ["q2", ""]]))).toContain("1 / 2");
  });
});

/* ============================================================
   兜底规格必须被门禁看见（修法 4）
   ============================================================ */

describe("人工门禁 · 兜底规格", () => {
  /*
    兜底规格（模型输出解析不出来时的替代品）的 questions 是空的，
    于是门禁会放行，reason 还写着"规格没有疑问，可以直接继续"。
    那是实话，但**不完整** —— 那份规格根本不是模型给出来的。
    真实运行里就发生过这一幕：降级了却没人拦，一路跑到成品。
    这一组断言钉的就是"兜底这件事必须说出来"。

    ── 为什么每条正例都配一条反例 ──
      只断言"reason 里含兜底"是不够的：如果实现无脑往每句话里
      都塞"兜底"，正例照样绿，而那种实现是错的（真规格也被说成兜底）。
      所以下面成对地钉：传了标记 → 有"兜底"；没传 → **没有**"兜底"。
  */
  const FALLBACK = fallbackSpec(meta);

  it("不传第三参 → fallback 是 false（向后兼容，老调用方读到的东西不变）", () => {
    const d = decideGate(specWith([]), null);
    expect(d.fallback).toBe(false);
  });

  it("传 true → fallback 原样带回来，调用方能看见", () => {
    const d = decideGate(FALLBACK, null, true);
    expect(d.fallback).toBe(true);
  });

  it("【关键】兜底 + 没疑问：**照旧不拦**，但 reason 里必须出现「兜底」", () => {
    const d = decideGate(FALLBACK, null, true);
    // 不拦是有意的：没有可回答的问题，停下来用户也无从回答
    expect(d.pause).toBe(false);
    expect(d.pending).toEqual([]);
    expect(d.reason).toContain("兜底");
  });

  it("★ 反例：同一份规格、不传标记时 reason 里**没有**「兜底」—— 证明上面那条不是恒真", () => {
    const d = decideGate(FALLBACK, null);
    expect(d.reason).not.toContain("兜底");
    expect(d.reason).toContain("可以直接继续");
  });

  it("【关键】兜底 + 有疑问：该停照样停，reason 里也要含「兜底」", () => {
    const d = decideGate({ ...FALLBACK, questions: ["要不要多人协作？"] }, null, true);
    expect(d.pause).toBe(true);
    expect(d.pending).toEqual(["要不要多人协作？"]);
    expect(d.reason).toContain("兜底");
  });

  it("★ 反例：有疑问但没传标记 → reason 里同样没有「兜底」", () => {
    const d = decideGate({ ...FALLBACK, questions: ["要不要多人协作？"] }, null);
    expect(d.reason).not.toContain("兜底");
  });

  it("兜底 + 疑问答全了：放行，但 reason 里仍要说清这是兜底", () => {
    const spec = { ...FALLBACK, questions: ["q1"] };
    const d = decideGate(spec, answersFor([["q1", "要"]]), true);
    expect(d.pause).toBe(false);
    expect(d.reason).toContain("兜底");
  });

  it("兜底 + 只答了一部分：停，reason 里仍要说清这是兜底", () => {
    const spec = { ...FALLBACK, questions: ["q1", "q2"] };
    const d = decideGate(spec, answersFor([["q1", "要"]]), true);
    expect(d.pause).toBe(true);
    expect(d.pending).toEqual(["q2"]);
    expect(d.reason).toContain("兜底");
  });

  it("兜底标记不影响 pending 的计算 —— 加的是说明，不是新的拦人理由", () => {
    const spec = { ...FALLBACK, questions: ["q1", "q2"] };
    const withFlag = decideGate(spec, answersFor([["q1", "要"]]), true);
    const without = decideGate(spec, answersFor([["q1", "要"]]));
    expect(withFlag.pending).toEqual(without.pending);
    expect(withFlag.pause).toBe(without.pause);
  });
});

/* ============================================================
   续跑判断（答完疑问再点生成，不许重跑规格化）
   ============================================================ */

describe("人工门禁 · 续跑判断", () => {
  /*
    这一组钉的是真实运行里暴露的一个死角：
    续跑时如果重跑规格化，疑问会换一批新的，用户"答了又问"永远走不到下一步。
    实测 run ed8fcdc3 连点三次：3 个疑问 → 4 个 → 3 个，一次都没到架构。
  */
  const SPEC = fallbackSpec(meta);

  it("有规格 + 有非空回答 → 是续跑（这时不许再重跑规格化）", () => {
    expect(isGateResume(SPEC, answersFor([["q1", "要"]]))).toBe(true);
  });

  it("只答了一部分也算续跑 —— 剩下的由门禁再拦一次，问题只会变少", () => {
    expect(isGateResume({ ...SPEC, questions: ["q1", "q2"] }, answersFor([["q1", "要"]]))).toBe(
      true,
    );
  });

  it("★ 反例：还没有规格（第一次跑）→ 不是续跑", () => {
    expect(isGateResume(null, answersFor([["q1", "要"]]))).toBe(false);
  });

  it("★ 反例：有规格但还没回答过（第一次停在门禁就是这种）→ 不是续跑", () => {
    expect(isGateResume(SPEC, null)).toBe(false);
  });

  it("★ 反例：答案全是空白 → 不算表过态，不是续跑", () => {
    expect(isGateResume(SPEC, answersFor([["q1", "   "], ["q2", ""]]))).toBe(false);
  });

  it("★ 反例：答案列表是空的 → 不是续跑", () => {
    expect(isGateResume(SPEC, answersFor([]))).toBe(false);
  });

  it("兜底的规格也算规格 —— 它是用户看过并确认过的那一份", () => {
    // 兜底规格同样会被落盘、同样要经门禁，所以它一样能构成"续跑"
    expect(isGateResume(fallbackSpec(meta), answersFor([["q1", "要"]]))).toBe(true);
  });

  it("和 decideGate 对得上：续跑 + 疑问都答完了 → 门禁放行，循环到此为止", () => {
    const spec = { ...SPEC, questions: ["q1"] };
    const answers = answersFor([["q1", "要"]]);
    expect(isGateResume(spec, answers)).toBe(true);
    const d = decideGate(spec, answers, false);
    expect(d.pause).toBe(false);
  });
});