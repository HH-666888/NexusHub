import { describe, expect, it } from "vitest";
import { summarizeChecks, type CheckResult } from "@/core/domain/check";
import type { GenerateEvent, GeneratePhase } from "@/core/generate/service";
import {
  START_BLOCK_TITLE,
  blockHasContent,
  pickCurrentBlockId,
  toStepBlocks,
} from "@/core/planning/step-blocks";

/**
 * 步骤块的切分
 * ============================================================
 * 这是「生成过程」和右侧面板共用的唯一一份切分逻辑，
 * 所以这里钉的不是渲染，是**归属**：
 *   哪一条事件算哪一步的、序号的边界在哪、语气由什么决定。
 *
 * 其中有一条是**不变量**（下面「块数 === phase 数」那条）：
 * 它不是"顺手多写一条"，而是这个模块存在的意义 ——
 * 一旦有人往切分里塞进"按计划补一个步骤"之类的逻辑，它会立刻红。
 *
 * 第 6 节钉的是另一个口径：**右侧面板默认打开在哪一块**
 * （pickCurrentBlockId）。它和切分一样是纯函数，所以也在这里钉死 ——
 * 尤其是"往前找"必须仍然是真实的那一块，而不是挑一个好看的。
 */

/* ============================================================
   夹具：形状与真实事件逐字段一致
   ============================================================ */

const ev = (seq: number, payload: GenerateEvent) => ({ seq, payload });

const phase = (seq: number, label: string, p: GeneratePhase = "generating") =>
  ev(seq, { kind: "phase", phase: p, label });

const text = (seq: number, delta: string) => ev(seq, { kind: "text", delta });
const think = (seq: number, delta: string) => ev(seq, { kind: "reasoning", delta });

const usage = (
  seq: number,
  costCny: number,
  tokens: { input: number; output: number; reasoning: number },
) =>
  ev(seq, {
    kind: "usage",
    usage: {
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      reasoningTokens: tokens.reasoning,
      cacheHitTokens: 0,
      cacheMissTokens: 0,
    },
    costCny,
    priceTier: "offPeak",
    model: "test-model",
    latencyMs: 1200,
    truncated: false,
  });

const check = (seq: number, results: CheckResult[]) =>
  ev(seq, { kind: "check", results, summary: summarizeChecks(results) });

const RESULTS: CheckResult[] = [
  { name: "完整 HTML 结构", pass: true, detail: "含 html/head/body 三段" },
  { name: "有事件处理", pass: false, detail: "没有找到 addEventListener" },
];

/* ============================================================
   1 · 分块边界
   ============================================================ */

describe("步骤块 · 分块边界", () => {
  it("空事件流 → 空数组（没有过程就没有块）", () => {
    expect(toStepBlocks([])).toEqual([]);
  });

  it("第一条 phase 之前的事件归到「开始」块", () => {
    const blocks = toStepBlocks([think(0, "先想"), text(1, "再写")]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].title).toBe(START_BLOCK_TITLE);
    expect(blocks[0].reasoning).toBe("先想");
    expect(blocks[0].text).toBe("再写");
  });

  it("两条 phase → 两块，标题各是各自的 label", () => {
    const blocks = toStepBlocks([
      phase(0, "正在把你的需求整理成规格", "spec"),
      phase(1, "正在生成"),
    ]);
    expect(blocks).toHaveLength(2);
    expect(blocks.map((b) => b.title)).toEqual([
      "正在把你的需求整理成规格",
      "正在生成",
    ]);
  });

  it("【不变量】块数 === phase 数（含「开始」块当且仅当首条不是 phase）", () => {
    /*
      ★ 这一条是这个模块的底线 ★
      分块边界只许来自**真实存在的 phase 事件** ——
      所以块数和 phase 数之间只差一个「开始」块，多一块都算凭空造步骤。
      谁要是往里加了"按六道工序补全"之类的逻辑，这条立刻红。
    */
    const leadingPhase = [
      phase(0, "a"),
      text(1, "x"),
      phase(2, "b"),
      think(3, "y"),
      phase(4, "c"),
    ];
    const leadingOther = [text(0, "x"), phase(1, "a"), text(2, "y"), phase(3, "b")];
    const noPhase = [text(0, "x"), think(1, "y")];

    for (const events of [leadingPhase, leadingOther, noPhase]) {
      const phaseCount = events.filter((e) => e.payload.kind === "phase").length;
      const startsWithPhase = events[0]?.payload.kind === "phase";
      expect(toStepBlocks(events)).toHaveLength(
        phaseCount + (startsWithPhase ? 0 : 1),
      );
    }
  });

  it("一条 phase 都没有时，只切出一块「开始」（不凭空造六道工序）", () => {
    const blocks = toStepBlocks([text(0, "只写了一行")]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].title).toBe(START_BLOCK_TITLE);
  });

  it("★ 空块保留：phase 后面什么都没跟，也必须留下「这一步发生过」", () => {
    const blocks = toStepBlocks([phase(0, "正在保存产物")]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].title).toBe("正在保存产物");
    expect(blocks[0].reasoning).toBe("");
    expect(blocks[0].text).toBe("");
    expect(blocks[0].checks).toBeNull();
    expect(blocks[0].usage).toBeNull();
  });

  it("最后一块是空块时也保留（生成到一半断在这里）", () => {
    const blocks = toStepBlocks([phase(0, "第一步"), text(1, "内容"), phase(2, "第二步")]);
    expect(blocks).toHaveLength(2);
    expect(blocks[1].text).toBe("");
    expect(blocks[1].toSeq).toBe(2);
  });

  it("phase 没带 label 时说「未命名」，不编一个名字", () => {
    const blocks = toStepBlocks([
      { seq: 0, payload: { kind: "phase", phase: "generating", label: "  " } },
    ]);
    expect(blocks[0].title).toBe("（未命名步骤）");
  });
});

/* ============================================================
   2 · 内容归属
   ============================================================ */

describe("步骤块 · 内容归属", () => {
  it("reasoning 多段 delta 按序拼接", () => {
    const blocks = toStepBlocks([phase(0, "正在生成"), think(1, "先看"), think(2, "需求"), think(3, "再动手")]);
    expect(blocks[0].reasoning).toBe("先看需求再动手");
  });

  it("text 多段 delta 按序拼接", () => {
    const blocks = toStepBlocks([phase(0, "正在生成"), text(1, "<html>"), text(2, "<body>"), text(3, "</body>")]);
    expect(blocks[0].text).toBe("<html><body></body>");
  });

  it("正文与思考不会串到别的块里（phase 是硬边界）", () => {
    const blocks = toStepBlocks([
      phase(0, "第一步"),
      text(1, "第一段的字"),
      think(2, "第一段的想"),
      phase(3, "第二步"),
      text(4, "第二段的字"),
    ]);
    expect(blocks[0].text).toBe("第一段的字");
    expect(blocks[0].reasoning).toBe("第一段的想");
    expect(blocks[1].text).toBe("第二段的字");
    expect(blocks[1].reasoning).toBe("");
  });

  it("check 归**当前**块；多条 check 合并而不是覆盖", () => {
    const blocks = toStepBlocks([
      phase(0, "正在检查产物"),
      check(1, [RESULTS[0]]),
      check(2, [RESULTS[1]]),
      phase(3, "正在保存产物"),
    ]);
    expect(blocks[0].checks).toEqual([RESULTS[0], RESULTS[1]]);
    // 后一个块没收到过 check，不许"继承"前一块的结果
    expect(blocks[1].checks).toBeNull();
  });

  it("usage 归**当前**块；块内多条 usage 求和（一条都不丢账）", () => {
    const blocks = toStepBlocks([
      phase(0, "第一步"),
      usage(1, 0.0012, { input: 100, output: 20, reasoning: 0 }),
      usage(2, 0.0345, { input: 300, output: 400, reasoning: 150 }),
    ]);
    const total = blocks[0].usage;
    expect(total).not.toBeNull();
    // 逐字段比：token 是整数，钱是浮点（0.0012 + 0.0345 在二进制里不精确）
    expect(total?.inputTokens).toBe(400);
    expect(total?.outputTokens).toBe(420);
    expect(total?.reasoningTokens).toBe(150);
    expect(total?.costCny).toBeCloseTo(0.0357, 10);
    // 归到当前块之后，别的块不许再"继承"这笔账
    expect(toStepBlocks([phase(0, "第一步"), usage(1, 0.5, { input: 1, output: 1, reasoning: 0 }), phase(2, "第二步")])[1].usage).toBeNull();
  });

  it("没收到 check / usage 时是 null，不是空数组也不是 0", () => {
    const blocks = toStepBlocks([phase(0, "正在生成"), text(1, "字")]);
    // null 是「还不知道」，[] 和 0 都是「知道，就是零」—— 两者不能混
    expect(blocks[0].checks).toBeNull();
    expect(blocks[0].usage).toBeNull();
  });

  it("check 事件带着 0 项结果时是空数组，不是 null（检查确实跑过）", () => {
    const blocks = toStepBlocks([phase(0, "正在检查产物"), check(1, [])]);
    expect(blocks[0].checks).toEqual([]);
  });

  it("spec / artifact 不进块内容，但仍然算这一块里发生的事（扩展 toSeq）", () => {
    const blocks = toStepBlocks([
      phase(0, "正在生成"),
      {
        seq: 1,
        payload: {
          kind: "artifact",
          artifact: { runId: "r", kind: "html", path: "r/index.html", bytes: 2048, createdAt: 1 },
        },
      },
    ]);
    expect(blocks[0].toSeq).toBe(1);
    expect(blocks[0].text).toBe("");
  });
});

/* ============================================================
   3 · tone
   ============================================================ */

describe("步骤块 · 语气", () => {
  it("phase:done → ok", () => {
    const blocks = toStepBlocks([phase(0, "正在生成"), phase(1, "完成 · 7/7 项检查通过", "done")]);
    expect(blocks[1].tone).toBe("ok");
  });

  it("phase:failed → error", () => {
    const blocks = toStepBlocks([phase(0, "正在生成"), phase(1, "生成失败", "failed")]);
    expect(blocks[1].tone).toBe("error");
  });

  it("kind:error → error；同一块里既出错又 done 时，出错优先", () => {
    /*
      phase 一定会开新块，所以"同一块里既 done 又 error"只有一种排法：
      错误出现在这条 done 之后（收尾阶段又炸了一下）。
      真实代码里 error 多半落在前一块，这里守的是**万一**：
      它一出现，这一块就必须红 —— 说"完成了"而把出过的事盖掉，是界面撒谎。
      下面那条对照同时钉住"不是恒红"。
    */
    const withError = toStepBlocks([
      phase(0, "正在生成"),
      phase(1, "完成 · 6/7 项检查通过", "done"),
      ev(2, { kind: "error", message: "落库失败：磁盘满了" }),
    ]);
    expect(withError[0].tone).toBe("normal");
    expect(withError[1].tone).toBe("error");

    const clean = toStepBlocks([
      phase(0, "正在生成"),
      phase(1, "完成 · 6/7 项检查通过", "done"),
    ]);
    expect(clean[1].tone).toBe("ok");
  });

  it("普通 phase → normal（不许把「在跑」染成成功或失败）", () => {
    const blocks = toStepBlocks([phase(0, "正在生成")]);
    expect(blocks[0].tone).toBe("normal");
  });

  it("「开始」块默认 normal，但真的出过错时照样是红的", () => {
    /*
      预算闸门就是这种形状：第一条事件是 error，然后什么都没有
      （spec-stage.ts 里 spent >= costLimitCny 那一支）。
      这时候如果因为"没有 phase"就一律 normal，
      界面上会是一块灰色的、看不出出过事的「开始」——
      而 tone 说的是"发生了什么"，不是"有没有 phase"。
    */
    const clean = toStepBlocks([text(0, "先写一行")]);
    expect(clean[0].tone).toBe("normal");

    const failed = toStepBlocks([
      ev(0, { kind: "error", message: "本次运行已花费 ¥0.5000，达到上限 ¥0.50" }),
    ]);
    expect(failed[0].title).toBe(START_BLOCK_TITLE);
    expect(failed[0].tone).toBe("error");
  });
});

/* ============================================================
   4 · 序号与身份
   ============================================================ */

describe("步骤块 · 序号与身份", () => {
  it("fromSeq / toSeq 是这一块的首尾事件", () => {
    const blocks = toStepBlocks([
      text(0, "开头"),
      phase(1, "第一步"),
      text(2, "a"),
      think(3, "b"),
      phase(4, "第二步"),
      text(5, "c"),
    ]);
    expect(blocks.map((b) => [b.fromSeq, b.toSeq])).toEqual([
      [0, 0],
      [1, 3],
      [4, 5],
    ]);
  });

  it("空块的 fromSeq === toSeq === 那条 phase 自己的 seq", () => {
    const blocks = toStepBlocks([phase(7, "正在保存产物")]);
    expect(blocks[0].fromSeq).toBe(7);
    expect(blocks[0].toSeq).toBe(7);
  });

  it("id 由起始 seq 拼出：稳定、唯一，且同一个 seq 每次都切出同一个 id", () => {
    const events = [text(0, "x"), phase(1, "第一步"), phase(2, "第二步")];
    const ids = toStepBlocks(events).map((b) => b.id);
    expect(ids).toEqual(["step-0", "step-1", "step-2"]);
    expect(new Set(ids).size).toBe(ids.length);
    // 同一份事件流切两次，id 一模一样（React key 与 e2e 把手都靠它）
    expect(toStepBlocks(events).map((b) => b.id)).toEqual(ids);
  });

  it("事件流从非 0 的 seq 开始时，边界照样对", () => {
    const blocks = toStepBlocks([phase(11, "第一步"), text(12, "字"), phase(13, "第二步")]);
    expect(blocks.map((b) => [b.id, b.fromSeq, b.toSeq])).toEqual([
      ["step-11", 11, 12],
      ["step-13", 13, 13],
    ]);
  });
});

/* ============================================================
   5 · 坏数据
   ============================================================ */

describe("步骤块 · 坏数据不炸也不编", () => {
  it("payload 不成形时不抛异常，也不往块里塞编出来的内容", () => {
    const blocks = toStepBlocks([
      { seq: 0, payload: null },
      { seq: 1, payload: "这不是一个对象" },
      { seq: 2, payload: { kind: "text" } }, // 缺 delta
      { seq: 3, payload: { kind: "usage" } }, // 缺 usage / costCny
      { seq: 4, payload: { kind: "check", results: [null, { name: 123 }] } },
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe("");
    expect(blocks[0].usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      costCny: 0,
    });
    // 形状不对的检查项按"没通过"处理 —— 不许让来路不明的项冒充通过
    expect(blocks[0].checks).toEqual([
      { name: "（未命名检查项）", pass: false, detail: "" },
    ]);
  });
});

/* ============================================================
   6 · 面板默认停在哪一块（pickCurrentBlockId）
   ============================================================ */

/**
 * 这一节钉的是"打开面板第一眼看到什么"。
 *
 * 改动前是**最后一块**；一次跑完的运行里，最后一块常常是收尾的
 * phase:"done"（没有任何输出），于是面板一打开就写
 * 「这一步没有返回思考内容 / 没有返回正文」——
 * 是实话，但把整条运行读起来像"什么都没做"。
 *
 * ⚠️ 这里一条断言都没有说"要挑好看的"：
 *    判据只有 **有没有内容** 这一个，选出来的永远是事件流里真实的那一块。
 */
describe("步骤块 · 面板默认停在哪一块", () => {
  it("空数组 → null（没有过程就没有块，面板照旧走空态）", () => {
    expect(pickCurrentBlockId([])).toBeNull();
  });

  it("只有一块且有内容 → 就是它自己", () => {
    const blocks = toStepBlocks([phase(0, "正在生成"), text(1, "正文")]);
    expect(blocks).toHaveLength(1);
    expect(pickCurrentBlockId(blocks)).toBe(blocks[0].id);
  });

  it("★ 最后一块是空的（收尾 phase:\"done\"）→ 停在倒数第二块", () => {
    /*
      这是**一次跑完的运行最常见的样子**：
      正文那一步之后，再来一条"完成 · 7/7 项检查通过"的收尾 phase。
      它是一次真实发生过的步骤，但一个字都没输出。
    */
    const blocks = toStepBlocks([
      phase(0, "正在生成"),
      text(1, "模型写出来的正文"),
      phase(2, "完成 · 7/7 项检查通过", "done"),
    ]);
    expect(blocks).toHaveLength(2);
    // 先把"收尾那块确实是空的"钉死 —— 否则下面那条可能只是碰巧成立
    expect(blocks[1].text).toBe("");
    expect(blocks[1].reasoning).toBe("");
    expect(blocks[1].checks).toBeNull();
    expect(blockHasContent(blocks[0])).toBe(true);

    expect(pickCurrentBlockId(blocks)).toBe(blocks[0].id);
    // 而且它真的**不是**最后一块：面板正是靠这个差来说"后面还有 N 步没有输出"
    expect(blocks[0].id).not.toBe(blocks[blocks.length - 1].id);
  });

  it("最后两块都空 → 继续往前找，直到有内容的那一块", () => {
    const blocks = toStepBlocks([
      phase(0, "正在生成"),
      text(1, "有内容的那一步"),
      phase(2, "正在落盘"), // 空
      phase(3, "完成", "done"), // 空
    ]);
    expect(blocks).toHaveLength(3);
    // 末尾两个空块被一路跳过，落回第一块（正文那一块）
    expect(blocks.slice(1).every((b) => !blockHasContent(b))).toBe(true);
    expect(pickCurrentBlockId(blocks)).toBe(blocks[0].id);
  });

  it("★ 全都空 → 退回**最后一块**（不是 null）", () => {
    /*
      为什么不能返回 null：
      null 在面板那里是另一句话 —— 「这次运行还没有产生任何过程事件」。
      而这里的事实是"步骤都真的发生了，只是都没留下输出"。
      返回 null 等于把后者说成前者，那是假话；
      退回最后一块，面板就会照实说"这一步没有返回思考内容 / 正文"。
    */
    const blocks = toStepBlocks([
      phase(0, "正在把你的需求整理成规格"),
      phase(1, "正在生成"),
      phase(2, "完成 · 7/7 项检查通过", "done"),
    ]);
    expect(blocks).toHaveLength(3);
    expect(blocks.every((b) => !blockHasContent(b))).toBe(true);

    const picked = pickCurrentBlockId(blocks);
    expect(picked).not.toBeNull();
    expect(picked).toBe(blocks[blocks.length - 1].id);
  });

  it("有 checks 也算有内容（检查清单本身就是这一步的输出）", () => {
    const blocks = toStepBlocks([
      phase(0, "正在生成"),
      text(1, "正文"),
      phase(2, "正在检查产物"),
      check(3, RESULTS),
      phase(4, "完成", "done"),
    ]);
    expect(blocks).toHaveLength(3);
    // 检查项归**检查那一步**（block[1]），收尾的 block[2] 依旧是空的
    expect(blocks[1].checks).toEqual(RESULTS);
    expect(blockHasContent(blocks[2])).toBe(false);
    expect(pickCurrentBlockId(blocks)).toBe(blocks[1].id);
  });

  it("reasoning / text 只要有一个非空就算有内容", () => {
    // 只有思考：正文那一栏会说"没有返回正文"，但这一块确实是有内容的
    const onlyThink = toStepBlocks([
      phase(0, "正在生成"),
      think(1, "只有思考"),
      phase(2, "完成", "done"),
    ]);
    expect(pickCurrentBlockId(onlyThink)).toBe(onlyThink[0].id);

    // 只有正文：最常见的真实情况（很多步骤就是不返回思考）
    const onlyText = toStepBlocks([
      phase(0, "正在生成"),
      text(1, "只有正文"),
      phase(2, "完成", "done"),
    ]);
    expect(pickCurrentBlockId(onlyText)).toBe(onlyText[0].id);
  });

  it("纯空白不算内容 —— 判空和面板一样走 trim()", () => {
    /*
      面板渲染前就是这么判的（step-content.tsx：trim() 之后为空才说"没有返回"）。
      两处口径必须同源：这里算"有"、面板却渲染成"没有返回"，
      面板就会停在一个实质空白的步骤上，而这在界面上看不出来。
    */
    const blocks = toStepBlocks([
      phase(0, "正在生成"),
      text(1, "   \n  "),
      phase(2, "完成", "done"),
    ]);
    expect(blocks[0].text.trim()).toBe("");
    expect(pickCurrentBlockId(blocks)).toBe(blocks[1].id);
  });

  it("checks 是空数组（检查跑了但一项结果都没有）不算有内容", () => {
    /*
      `checks === null` 是"没收到过 check 事件"，
      而 `[]` 是"检查跑了、一项结果都没有"。
      后者面板**一个字都渲染不出来**（检查清单只在有项时才画）——
      把它算成有内容，面板就会停在另一个看上去同样空白的步骤上，
      等于没修这次要修的问题。
    */
    const blocks = toStepBlocks([
      phase(0, "正在生成"),
      check(1, []),
      phase(2, "完成", "done"),
    ]);
    expect(blocks[0].checks).toEqual([]);
    expect(blockHasContent(blocks[0])).toBe(false);
    expect(pickCurrentBlockId(blocks)).toBe(blocks[1].id);
  });

  it("★ 出过错的块只要写了东西，照样被选中（判据与 tone 无关）", () => {
    /*
      "往前找"只认有没有内容，不认好不好看：
      失败那一步写了半截正文，它就是这次运行里最后一个有内容的块。
      挑一个"看起来成功"的块，才是这一版最不能做的事。
    */
    const blocks = toStepBlocks([
      phase(0, "正在生成"),
      text(1, "写了一半的正文"),
      ev(2, { kind: "error", message: "传输中断" }),
      phase(3, "完成", "done"),
    ]);
    expect(blocks[0].tone).toBe("error");
    expect(pickCurrentBlockId(blocks)).toBe(blocks[0].id);
  });

  it("⚠️ 只选一个 id：块本身一个字段都不改（不合并、不搬运内容）", () => {
    const blocks = toStepBlocks([
      phase(0, "正在生成"),
      text(1, "第一块的字"),
      phase(2, "完成", "done"),
    ]);
    const before = JSON.parse(JSON.stringify(blocks)) as unknown;
    pickCurrentBlockId(blocks);
    expect(blocks).toEqual(before);
  });
});