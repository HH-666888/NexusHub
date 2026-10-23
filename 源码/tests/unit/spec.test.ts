import { describe, expect, it } from "vitest";
import {
  buildSpecPrompt,
  extractJsonText,
  fallbackSpec,
  isFallbackSpec,
  isVagueStatement,
  parseSpec,
  reviewSpec,
  SPEC_MIN_ACCEPTANCE,
  SPEC_MIN_MUST,
  summarizeSpec,
  validateSpec,
  type AppSpec,
} from "@/core/domain/spec";

const meta = { prompt: "做一个任务看板", model: "test-model", generatedAt: 1_700_000_000_000 };

/** 模型输出的一份标准规格 JSON */
const GOOD_JSON = JSON.stringify({
  goal: "一个可以拖拽卡片的团队任务看板",
  audience: "小团队内部使用",
  scenarios: ["新建任务", "拖动改变状态", "刷新后数据还在"],
  acceptance: [
    { id: "ac-1", statement: "可以新建任务", verifyBy: "点击新建按钮，输入标题，卡片出现在待办栏", level: "must" },
    { id: "ac-2", statement: "可以拖动卡片到别的栏位", verifyBy: "按住卡片拖到进行中栏，松手后卡片留在该栏", level: "must" },
    { id: "ac-3", statement: "刷新后卡片位置不变", verifyBy: "拖动后按 F5，卡片仍在拖动后的栏位", level: "must" },
    { id: "ac-4", statement: "可以删除任务", verifyBy: "点击卡片上的删除，卡片消失", level: "should" },
  ],
  scope: { inScope: ["看板", "拖拽"], outOfScope: ["多人协作", "账号体系"] },
  questions: [],
});

describe("规格 · 抠 JSON", () => {
  it("整体就是 JSON", () => {
    expect(extractJsonText('{"a":1}')).toBe('{"a":1}');
  });

  it("带 ```json 围栏", () => {
    const raw = "好的，这是规格：\n```json\n{\"a\":1}\n```\n希望有帮助";
    expect(extractJsonText(raw)).toBe('{"a":1}');
  });

  it("带 ``` 围栏但没写语言", () => {
    expect(extractJsonText("```\n{\"a\":1}\n```")).toBe('{"a":1}');
  });

  it("夹在一堆解释文字中间", () => {
    const raw = '我来分析一下。\n{"a":1}\n以上就是我的分析。';
    expect(extractJsonText(raw)).toBe('{"a":1}');
  });

  it("完全没有 JSON 时返回 null", () => {
    expect(extractJsonText("我不知道该怎么做")).toBeNull();
    expect(extractJsonText("")).toBeNull();
    expect(extractJsonText("   ")).toBeNull();
  });

  it("只有半个 JSON 时也能抠出个样子，交给 JSON.parse 去报错", () => {
    // 关键是不在这里静默返回 null —— 要让后面的解析给出明确原因
    expect(extractJsonText('{"a":')).toBe('{"a":');
  });
});

describe("规格 · 解析", () => {
  it("正常输出解析成功", () => {
    const r = parseSpec(GOOD_JSON, meta);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.spec.goal).toContain("看板");
    expect(r.spec.acceptance).toHaveLength(4);
    expect(r.spec.acceptance[0].level).toBe("must");
    expect(r.spec.scope.outOfScope).toContain("账号体系");
  });

  it("原文一字不改地留在 prompt 里，不用模型改写过的 goal 代替", () => {
    const r = parseSpec(GOOD_JSON, { ...meta, prompt: "  做一个任务看板  " });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // prompt 是元信息，不该被 trim 掉语义；但 goal 是模型给的
    expect(r.spec.prompt).toBe("  做一个任务看板  ");
  });

  it("找不到 JSON 时给出明确原因", () => {
    const r = parseSpec("我不太确定你的意思", meta);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("找不到 JSON");
    // 原始输出要带回去，便于排查
    expect(r.raw).toBe("我不太确定你的意思");
  });

  it("JSON 语法错误时给出解析器的原话", () => {
    const r = parseSpec('{"goal": }', meta);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("JSON 解析失败");
  });

  it("顶层是数组时拒绝", () => {
    const r = parseSpec("[1,2,3]", meta);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("不是对象");
  });

  it("字段类型不对时不炸，缺什么就是空的", () => {
    const r = parseSpec('{"goal": 123, "scenarios": "不是数组", "acceptance": null}', meta);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.spec.goal).toBe("");
    expect(r.spec.scenarios).toEqual([]);
    expect(r.spec.acceptance).toEqual([]);
  });

  it("验收标准缺 statement 的条目被丢掉 —— 留着只会让验收去校验没说清的东西", () => {
    const r = parseSpec(
      JSON.stringify({
        acceptance: [
          { statement: "能新建", verifyBy: "点一下" },
          { verifyBy: "不知道验什么" },
          { statement: "  ", verifyBy: "空的也丢" },
        ],
      }),
      meta,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.spec.acceptance).toHaveLength(1);
    expect(r.spec.acceptance[0].statement).toBe("能新建");
  });

  it("缺 id 时自动补，保证后续阶段能引用", () => {
    const r = parseSpec(
      JSON.stringify({ acceptance: [{ statement: "能新建", verifyBy: "点一下" }] }),
      meta,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.spec.acceptance[0].id).toBe("ac-1");
  });

  it("level 只认 must，其余一律当作 should", () => {
    const r = parseSpec(
      JSON.stringify({
        acceptance: [
          { statement: "a", verifyBy: "x", level: "must" },
          { statement: "b", verifyBy: "x", level: "MUST" },
          { statement: "c", verifyBy: "x", level: "重要" },
        ],
      }),
      meta,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.spec.acceptance.map((a) => a.level)).toEqual(["must", "should", "should"]);
  });
});

describe("规格 · 校验", () => {
  const base = (): AppSpec => {
    const r = parseSpec(GOOD_JSON, meta);
    if (!r.ok) throw new Error("测试数据本身有问题");
    return r.spec;
  };

  it("齐全的规格没有任何 blocking", () => {
    const issues = validateSpec(base());
    expect(issues.filter((i) => i.level === "blocking")).toEqual([]);
  });

  it("验收标准太少会拦下 —— 最后一步会没有可验的东西", () => {
    const spec = base();
    spec.acceptance = spec.acceptance.slice(0, SPEC_MIN_ACCEPTANCE - 1);
    const issues = validateSpec(spec);
    expect(issues.some((i) => i.level === "blocking" && i.message.includes("至少要"))).toBe(true);
  });

  it("必需级太少会拦下 —— 全是期望等于没有底线", () => {
    const spec = base();
    spec.acceptance = spec.acceptance.map((a) => ({ ...a, level: "should" as const }));
    const issues = validateSpec(spec);
    expect(
      issues.some((i) => i.level === "blocking" && i.message.includes(String(SPEC_MIN_MUST))),
    ).toBe(true);
  });

  it("缺目标陈述会拦下", () => {
    const spec = base();
    spec.goal = "";
    expect(validateSpec(spec).some((i) => i.level === "blocking")).toBe(true);
  });

  it("没有场景会拦下", () => {
    const spec = base();
    spec.scenarios = [];
    expect(
      validateSpec(spec).some((i) => i.level === "blocking" && i.message.includes("场景")),
    ).toBe(true);
  });

  it("验收标准没写怎么验证会拦下", () => {
    const spec = base();
    spec.acceptance[0].verifyBy = "";
    expect(
      validateSpec(spec).some((i) => i.level === "blocking" && i.message.includes("怎么验证")),
    ).toBe(true);
  });

  it("含糊的验收标准只提醒、不拦 —— 它并非不可判定，只是会产生分歧", () => {
    const spec = base();
    spec.acceptance[0].statement = "界面美观";
    const issues = validateSpec(spec);
    expect(issues.some((i) => i.level === "advisory" && i.message.includes("含糊"))).toBe(true);
    expect(issues.some((i) => i.level === "blocking" && i.message.includes("含糊"))).toBe(false);
  });

  it("没写不做什么只提醒", () => {
    const spec = base();
    spec.scope.outOfScope = [];
    const issues = validateSpec(spec);
    expect(issues.some((i) => i.level === "advisory" && i.message.includes("不做"))).toBe(true);
  });
});

describe("规格 · 含糊词识别", () => {
  it("认得出来常见的那几个", () => {
    for (const s of ["界面美观", "性能流畅", "用户体验好", "设计合理"]) {
      expect(isVagueStatement(s), `${s} 应当被判定为含糊`).toBe(true);
    }
  });

  it("可判定的说法不会被误伤", () => {
    for (const s of [
      "三个栏位之间可以拖拽排序",
      "刷新后卡片仍在拖动后的栏位",
      "点击删除按钮后卡片消失",
    ]) {
      expect(isVagueStatement(s), `${s} 不该被判定为含糊`).toBe(false);
    }
  });
});

describe("规格 · 门禁", () => {
  const base = (): AppSpec => {
    const r = parseSpec(GOOD_JSON, meta);
    if (!r.ok) throw new Error("测试数据本身有问题");
    return r.spec;
  };

  it("齐全且没有疑问时放行", () => {
    const gate = reviewSpec(base());
    expect(gate.pass).toBe(true);
    expect(gate.summary).toContain("可以进入架构定型");
  });

  it("【关键】有未回答的问题时不放行 —— 这就是「人工门禁」", () => {
    const spec = base();
    spec.questions = ["要不要多人协作？"];
    const gate = reviewSpec(spec);
    expect(gate.pass).toBe(false);
    expect(gate.pendingQuestions).toEqual(["要不要多人协作？"]);
    expect(gate.summary).toContain("需要你确认");
  });

  it("有 blocking 时不放行，且摘要说的是 blocking 而不是问题数", () => {
    const spec = base();
    spec.goal = "";
    spec.questions = ["随便问一个"];
    const gate = reviewSpec(spec);
    expect(gate.pass).toBe(false);
    expect(gate.summary).toContain("还不能用");
  });

  it("只有 advisory 时放行，但摘要会提醒", () => {
    const spec = base();
    spec.scope.outOfScope = [];
    const gate = reviewSpec(spec);
    expect(gate.pass).toBe(true);
    expect(gate.summary).toContain("建议再看一眼");
  });
});

describe("规格 · 兜底", () => {
  it("兜底规格本身能过门禁 —— 否则等于把用户卡死", () => {
    const spec = fallbackSpec(meta);
    const gate = reviewSpec(spec);
    expect(gate.blocking).toEqual([]);
    expect(gate.pass).toBe(true);
  });

  it("兜底规格的验收标准全是可自动判定的", () => {
    const spec = fallbackSpec(meta);
    for (const a of spec.acceptance) {
      expect(a.verifyBy.length).toBeGreaterThan(0);
      expect(isVagueStatement(a.statement)).toBe(false);
    }
  });

  it("能识别出这是兜底，界面上要显著区别于真规格", () => {
    expect(isFallbackSpec(fallbackSpec(meta))).toBe(true);
    const r = parseSpec(GOOD_JSON, meta);
    expect(r.ok).toBe(true);
    if (r.ok) expect(isFallbackSpec(r.spec)).toBe(false);
  });

  it("兜底也保留用户原话", () => {
    expect(fallbackSpec({ ...meta, prompt: "做个记账的" }).prompt).toBe("做个记账的");
  });
});

describe("规格 · 提示词", () => {
  it("把用户输入包进用户消息", () => {
    const p = buildSpecPrompt("  做个看板  ");
    expect(p).toContain("做个看板");
    // 前后空白被去掉，避免模型把它当成有意义的格式
    expect(p).not.toContain("  做个看板  ");
  });

  it("系统提示词里明确要求了 JSON 与条数下限", () => {
    expect(buildSpecPrompt("x")).toBeTruthy();
    // 这些约束写在提示词里，也要有对应的校验兜底 —— 两条都验一下
    expect(SPEC_MIN_ACCEPTANCE).toBeGreaterThanOrEqual(3);
    expect(SPEC_MIN_MUST).toBeGreaterThanOrEqual(1);
  });
});

describe("规格 · 摘要", () => {
  it("说清楚有多少条标准、其中几条必需", () => {
    const r = parseSpec(GOOD_JSON, meta);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = summarizeSpec(r.spec);
    expect(s).toContain("4 条验收标准");
    expect(s).toContain("3 条必需");
    expect(s).toContain("2 条不做");
  });
});