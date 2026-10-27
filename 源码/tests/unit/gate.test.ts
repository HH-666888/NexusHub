import { describe, expect, it } from "vitest";
import {
  answersToContext,
  applyAnswers,
  buildGateView,
  decideGate,
  isAcknowledged,
  isGateResume,
  summarizeAnswers,
  validateAnswers,
  type SpecAck,
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

/**
 * 保护人工门禁：疑问的拦截与放行、答案并回规格、兜底与续跑、知悉并继续。
 * 兜底规格与知悉记录都必须让调用方看见，不能悄悄放行。
 */

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
    // 并回去之后再判断，结果仍是该停。
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
    // 空白也留下，表示看了但不答
    expect(v.answers).toHaveLength(2);
  });

  it("【关键】丢掉对应不上任何疑问的回答", () => {
    // 不收会攒下与本次规格无关的陈旧回答，decideGate 的 pending 也会对不上。
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

describe("人工门禁 · 兜底规格", () => {
  // 兜底规格的 questions 是空的，门禁会放行并说规格没有疑问：实话但不完整。
  // 兜底这件事必须出现在 reason 里；正反成对断言，防止实现无脑往每句话里塞兜底。
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

describe("人工门禁 · 续跑判断", () => {
  // 续跑时若重跑规格化，疑问会换一批，用户答了又问永远走不到下一步。
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

describe("人工门禁 · 知悉并继续", () => {
  // 这一组区分系统替用户猜与用户让系统替他猜：后者是用户自己按的按钮。
  // 但同样必须把代价说出来，所以每条正例配一条不许悄悄放行的反例。
  const NO_QUESTIONS = fallbackSpec(meta);
  const ASKED = { ...NO_QUESTIONS, questions: ["要不要提示音？", "要不要休息阶段？"] };

  it("【关键】知悉 + 有疑问没答 → 放行（这是用户按的按钮，不是系统替他做主）", () => {
    const d = decideGate(ASKED, null, false, true);
    expect(d.pause).toBe(false);
    // 但没答的那几条仍然如实列着 —— 放行不等于"问题消失了"
    expect(d.pending).toEqual(["要不要提示音？", "要不要休息阶段？"]);
  });

  it("【关键】放行那句话必须写清代价，而不只是说「继续」", () => {
    const d = decideGate(ASKED, null, false, true);
    expect(d.reason).toContain("知悉");
    expect(d.reason).toContain("2 个疑问没答");
    expect(d.reason).toContain("模型会替你决定");
    // 代价：错了要到验收那一步才看得出来
    expect(d.reason).toContain("验收");
  });

  it("★ 反例：没知悉 → 照样停（不许因为「反正能知悉」就默认放行）", () => {
    const d = decideGate(ASKED, null, false, false);
    expect(d.pause).toBe(true);
    expect(d.reason).not.toContain("知悉");
  });

  it("★ 反例：没疑问时，知悉标记不产生任何影响（不该凭空多出一句知悉）", () => {
    const d = decideGate(NO_QUESTIONS, null, false, true);
    expect(d.pause).toBe(false);
    expect(d.reason).not.toContain("知悉");
    expect(d.reason).toContain("可以直接继续");
  });

  it("★ 反例：疑问都答完了 → 走「都已回答」，而不是走知悉那条", () => {
    const answers = answersFor([
      ["要不要提示音？", "要"],
      ["要不要休息阶段？", "不要"],
    ]);
    const d = decideGate(ASKED, answers, false, true);
    expect(d.pause).toBe(false);
    expect(d.reason).toContain("都已回答");
    expect(d.reason).not.toContain("知悉");
  });

  it("只答了一部分 + 知悉 → 放行，且 reason 说的是「没答的那几条」", () => {
    const d = decideGate(ASKED, answersFor([["要不要提示音？", "要"]]), false, true);
    expect(d.pause).toBe(false);
    expect(d.pending).toEqual(["要不要休息阶段？"]);
    expect(d.reason).toContain("1 个疑问没答");
  });

  it("知悉与兜底标记可以同时成立 —— 两件事都要说", () => {
    const d = decideGate(ASKED, null, true, true);
    expect(d.pause).toBe(false);
    expect(d.fallback).toBe(true); // 兜底这件事仍然要被调用方看见
    expect(d.reason).toContain("知悉");
  });
});

describe("人工门禁 · ack 记录本身算不算数", () => {
  const ack = (pending: string[]): SpecAck => ({
    runId: "run-1",
    pending,
    acknowledgedAt: 1,
  });

  it("记着「有没答的疑问」→ 算数", () => {
    expect(isAcknowledged(ack(["要不要提示音？"]))).toBe(true);
  });

  it("★ 反例：没有 ack 记录 → 不算数", () => {
    expect(isAcknowledged(null)).toBe(false);
  });

  it("★ 反例：**空的** ack（当时压根没疑问）→ 不算数", () => {
    // 一份"我知悉了 0 条疑问"的记录，不能当成"他同意我们替他猜"
    expect(isAcknowledged(ack([]))).toBe(false);
  });

  it("★ 反例：他知悉的是**别的问题** → 不算数（不许替他没看过的疑问放行）", () => {
    // 知悉记录对应的是当时那几条；待确认的变成别的时，新的那几条他没看过。
    expect(isAcknowledged(ack(["旧的疑问一", "旧的疑问二"]), ["新的疑问"])).toBe(false);
  });

  it("★ 反例：待确认的是他那几条的**超集** → 也不算数（多出来的那条他没看过）", () => {
    expect(isAcknowledged(ack(["q1", "q2"]), ["q1", "q2", "q3"])).toBe(false);
  });

  it("待确认的正好都在他知悉过的清单里 → 算数", () => {
    expect(isAcknowledged(ack(["q1", "q2"]), ["q1", "q2"])).toBe(true);
  });
});

describe("人工门禁 · 知悉也算续跑（★ 账上只许有一条 spec）", () => {
  const SPEC = fallbackSpec(meta);
  const ASKED = { ...SPEC, questions: ["q1", "q2"] };
  const ack: SpecAck = { runId: "r", pending: ["q1", "q2"], acknowledgedAt: 1 };

  it("【关键】有规格 + 知悉过 → 是续跑（不然规格化会被重跑，疑问换一批新的）", () => {
    // 知悉之后续跑时规格化又跑了一遍，账上出现两条 spec 流水。
    expect(isGateResume(ASKED, null, ack)).toBe(true);
  });

  it("★ 反例：没有回答、也没有知悉 → 不是续跑（第一次停在门禁就是这种）", () => {
    expect(isGateResume(ASKED, null, null)).toBe(false);
  });

  it("★ 反例：知悉的是别的问题 → 不算续跑（规格该重跑就跑）", () => {
    const stale: SpecAck = { runId: "r", pending: ["很久以前的疑问"], acknowledgedAt: 1 };
    expect(isGateResume(ASKED, null, stale)).toBe(false);
  });

  it("答过疑问（没知悉）仍然是续跑 —— 老行为一个字不变", () => {
    expect(isGateResume(ASKED, answersFor([["q1", "要"]]), null)).toBe(true);
  });
});

describe("人工门禁 · 界面用的现状视图", () => {
  const SPEC = fallbackSpec(meta);
  const ASKED = { ...SPEC, questions: ["q1", "q2"] };
  const ack = (pending: string[]): SpecAck => ({ runId: "r", pending, acknowledgedAt: 1 });

  it("只给**还没答**的那几条 —— 答过的再问一遍，用户会以为自己没提交成功", () => {
    const view = buildGateView(ASKED, answersFor([["q1", "要"]]), null);
    expect(view.pending).toEqual(["q2"]);
    expect(view.pause).toBe(true);
  });

  it("都答完了 → pending 为空、不放行也不拦（可以继续）", () => {
    const view = buildGateView(
      ASKED,
      answersFor([
        ["q1", "要"],
        ["q2", "不要"],
      ]),
      null,
    );
    expect(view.pending).toEqual([]);
    expect(view.pause).toBe(false);
  });

  it("知悉过了 → 不再拦，但 pending 照旧列着（放行不等于问题消失）", () => {
    const view = buildGateView(ASKED, null, ack(["q1", "q2"]));
    expect(view.pause).toBe(false);
    expect(view.acknowledged).toBe(true);
    expect(view.pending).toEqual(["q1", "q2"]);
  });

  it("★ 反例：没有 ack 时不许显示成「已知悉」", () => {
    const view = buildGateView(ASKED, null, null);
    expect(view.acknowledged).toBe(false);
    expect(view.pause).toBe(true);
  });

  it("兜底标记原样带出来（界面要把兜底与真规格分开显示）", () => {
    const view = buildGateView(ASKED, null, null, true);
    expect(view.fallback).toBe(true);
    expect(view.reason).toContain("兜底");
  });
});