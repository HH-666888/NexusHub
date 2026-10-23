import { describe, expect, it } from "vitest";
import {
  answersToContext,
  applyAnswers,
  decideGate,
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