import { describe, expect, it } from "vitest";
import {
  CALLBACK_ARTIFACT_NAME,
  buildCallbackContext,
  buildCallbackRecord,
  describeCallback,
  extractPreviousAttempt,
  hasSomethingToFeedBack,
  type PreviousAttempt,
} from "@/core/pipeline/callback";
import type { RunEvent } from "@/core/domain/run-event";

/**
 * 回流
 * ============================================================
 * 参考图上闭环的最后一步：「下一轮的数据，回到起点」。
 * 六道工序里原本没有这一环 —— 跑完就结束，
 * 再点一次「重新生成」等于把上一次原样重跑一遍。
 */

/* ---------- 造事件的辅助 ---------- */

/**
 * 一条已落库的事件。
 *
 * ⚠️ RunEvent 的 kind 在**顶层**，payload 是完整的事件对象
 *（它自己也带 kind）。两个地方都要写 ——
 * 只写 payload 的话，读取时按 e.kind 过滤的代码就一条都匹配不到。
 */
type Payload = RunEvent["payload"];

function ev(seq: number, payload: Payload): RunEvent {
  return { id: seq, runId: "r1", seq, at: 1000 + seq, kind: payload.kind, payload };
}

function checkEvent(
  // detail 可选：有些检查项本来就没有补充说明，
  // 而「没有说明」正是要单独测的一种情况
  failures: Array<{ name: string; detail?: string }>,
  total = 7,
): RunEvent {
  const passed = total - failures.length;
  const full = failures.map((f) => ({ name: f.name, detail: f.detail ?? "", pass: false }));
  return ev(1, {
    kind: "check",
    results: [
      ...full,
      ...Array.from({ length: passed }, (_, i) => ({
        name: `通过项 ${i}`,
        pass: true,
        detail: "没问题",
      })),
    ],
    summary: { total, passed, failed: failures.length, failures: full },
  });
}

/* ============================================================
   捞
   ============================================================ */

describe("回流 · 从事件里捞上一次", () => {
  it("没有事件就是没有上一次", () => {
    expect(extractPreviousAttempt([])).toBeNull();
  });

  it("只有文本事件（上一次没跑到检查）也算没有", () => {
    // 跑到一半被叫停，没有可回流的东西
    const events = [ev(0, { kind: "text", delta: "<!DOCTYPE html>" })];
    expect(extractPreviousAttempt(events)).toBeNull();
  });

  it("捞出没过的项，通过的不带", () => {
    const events = [
      checkEvent([
        { name: "导出可下载", detail: "没有找到下载入口" },
        { name: "响应式", detail: "窄屏下溢出" },
      ]),
    ];
    const prev = extractPreviousAttempt(events)!;
    expect(prev.failures.map((f) => f.name)).toEqual(["导出可下载", "响应式"]);
    expect(prev.total).toBe(7);
    expect(prev.passed).toBe(5);
  });

  it("全过的时候 failures 是空的（但还是有上一次）", () => {
    const prev = extractPreviousAttempt([checkEvent([])])!;
    expect(prev.failures).toHaveLength(0);
    expect(prev.passed).toBe(7);
  });

  it("知道上一次有没有产出过成品", () => {
    const withArtifact = extractPreviousAttempt([
      checkEvent([]),
      ev(2, {
        kind: "artifact",
        artifact: {
          id: 1,
          runId: "r1",
          kind: "html",
          path: "r1/index.html",
          bytes: 1234,
          sha256: "abc",
          createdAt: 1,
        },
      }),
    ])!;
    expect(withArtifact.hadArtifact).toBe(true);

    const without = extractPreviousAttempt([checkEvent([])])!;
    expect(without.hadArtifact).toBe(false);
  });

  it("把上一次的错误信息也留下", () => {
    const prev = extractPreviousAttempt([
      ev(0, { kind: "error", message: "模型返回 429" }),
    ])!;
    expect(prev.error).toBe("模型返回 429");
  });

  it("【关键】有多条 check 时取最后一条", () => {
    /*
      一次尝试里检查只该跑一次。但万一日志里有多条
      （中途崩了重来），最终结论是最后那条 ——
      取第一条的话，会把一次中间态当成结论。
    */
    const events = [
      checkEvent([{ name: "旧的失败", detail: "x" }], 7),
      checkEvent([{ name: "最终的失败", detail: "y" }], 7),
    ];
    const prev = extractPreviousAttempt(events)!;
    expect(prev.failures.map((f) => f.name)).toEqual(["最终的失败"]);
  });
});

/* ============================================================
   该不该回流
   ============================================================ */

describe("回流 · 什么情况下带", () => {
  it("没有上一次就不带", () => {
    expect(hasSomethingToFeedBack(null)).toBe(false);
    expect(buildCallbackContext(null)).toBeNull();
    expect(describeCallback(null)).toBeNull();
  });

  it("上一次全过 —— 没有要修的，不带", () => {
    const prev: PreviousAttempt = {
      failures: [],
      total: 7,
      passed: 7,
      hadArtifact: true,
      error: null,
    };
    expect(hasSomethingToFeedBack(prev)).toBe(false);
    expect(buildCallbackContext(prev)).toBeNull();
  });

  it("上一次有没过的项 —— 带", () => {
    const prev: PreviousAttempt = {
      failures: [{ name: "导出可下载", detail: "没有下载入口" }],
      total: 7,
      passed: 6,
      hadArtifact: true,
      error: null,
    };
    expect(hasSomethingToFeedBack(prev)).toBe(true);
  });

  it("上一次跑挂了 —— 也带（「上次在这儿挂了」很有用）", () => {
    const prev: PreviousAttempt = {
      failures: [],
      total: 0,
      passed: 0,
      hadArtifact: false,
      error: "模型返回 429",
    };
    expect(hasSomethingToFeedBack(prev)).toBe(true);
    expect(buildCallbackContext(prev)).toContain("429");
  });
});

/* ============================================================
   拼出来的那段话
   ============================================================ */

describe("回流 · 拼给模型的上下文", () => {
  const prev: PreviousAttempt = {
    failures: [
      { name: "导出可下载", detail: "没有找到下载入口" },
      { name: "响应式", detail: "窄屏下溢出" },
    ],
    total: 7,
    passed: 5,
    hadArtifact: true,
    error: null,
  };

  it("【关键】只说没过的，不说过了的", () => {
    /*
      把七项检查全列一遍等于没说 ——
      模型会以为要通过的是那七项，而它本来就知道该通过。
      要带的是**上一次实际没过的**那几项。
    */
    const ctx = buildCallbackContext(prev)!;
    expect(ctx).toContain("导出可下载");
    expect(ctx).toContain("响应式");
    expect(ctx, "把通过项也带上了").not.toContain("通过项");
  });

  it("【关键】说清是「上一轮」，不是泛泛的「检查没过」", () => {
    /*
      「检查没过」和「上一轮这项没过」对模型是两句不同的话。
      后者带着「我试过了，这样不行」的信息。
    */
    const ctx = buildCallbackContext(prev)!;
    expect(ctx).toContain("上一轮");
    expect(ctx).toContain("已经生成过一次");
  });

  it("带上「几项里过了几项」，让它知道差多远", () => {
    const ctx = buildCallbackContext(prev)!;
    expect(ctx).toContain("7 项检查里过了 5 项");
  });

  it("检查项的原因照原样带，不做加工", () => {
    const ctx = buildCallbackContext(prev)!;
    expect(ctx).toContain("导出可下载：没有找到下载入口");
  });

  it("【关键】原因是空的时候只写名字，不替它编一句", () => {
    /*
      编一句「大概是因为…」比不写更糟 ——
      模型会照着那句编的原因去改，而那个原因是我们猜的，
      不是检查器说的。
    */
    const ctx = buildCallbackContext({
      ...prev,
      failures: [{ name: "导出可下载", detail: "   " }],
    })!;
    expect(ctx).toContain("导出可下载");
    expect(ctx).not.toContain("导出可下载：");
    expect(ctx, "替检查器编了原因").not.toContain("大概");
    expect(ctx).not.toContain("可能是因为");
  });

  it("跑挂的时候，额外给一句「保守一点」的建议", () => {
    const ctx = buildCallbackContext({
      failures: [],
      total: 0,
      passed: 0,
      hadArtifact: false,
      error: "模型返回 429",
    })!;
    expect(ctx).toContain("没有跑完就中断");
    expect(ctx).toContain("保守");
  });

  it("既跑挂又有失败项时，两段都在", () => {
    const ctx = buildCallbackContext({ ...prev, error: "超时" })!;
    expect(ctx).toContain("超时");
    expect(ctx).toContain("导出可下载");
  });
});

/* ============================================================
   说给用户听
   ============================================================ */

describe("回流 · 说给用户听", () => {
  it("【关键】回流必须说出来 —— 它是用户看不见的动作", () => {
    /*
      一个偷偷改提示词的系统，和一个偷偷改代码的系统一样不可信。
      用户得知道「这一次它被提醒了什么」。
    */
    const msg = describeCallback({
      failures: [
        { name: "a", detail: "x" },
        { name: "b", detail: "y" },
      ],
      total: 7,
      passed: 5,
      hadArtifact: true,
      error: null,
    })!;
    expect(msg).toContain("上一轮没过的 2 项检查");
    expect(msg).toContain("别再犯");
  });

  it("跑挂的情况也说出来", () => {
    const msg = describeCallback({
      failures: [],
      total: 0,
      passed: 0,
      hadArtifact: false,
      error: "超时",
    })!;
    expect(msg).toContain("中断");
  });

  it("没有可带的就返回 null，而不是一句「没有」", () => {
    // 界面上不该出现「本轮没有回流」这种废话
    expect(describeCallback(null)).toBeNull();
    expect(
      describeCallback({ failures: [], total: 7, passed: 7, hadArtifact: true, error: null }),
    ).toBeNull();
  });
});

/* ============================================================
   落成产物
   ============================================================ */

describe("回流 · 落成 callback.json", () => {
  const prev: PreviousAttempt = {
    failures: [{ name: "导出可下载", detail: "没有找到下载入口" }],
    total: 7,
    passed: 6,
    hadArtifact: true,
    error: null,
  };

  it("存下拼好的那段话，不存原料", () => {
    /*
      存 prev 让读的人自己再拼一遍的话，
      哪天 buildCallbackContext 改了措辞，
      历史文件读出来的就和当时真正喂进去的不是同一段话了。
      那样这个文件就失去了「事后能查」的意义。
    */
    const ctx = buildCallbackContext(prev)!;
    const rec = buildCallbackRecord("r1", prev, ctx, 1234);
    expect(rec.context).toBe(ctx);
    expect(rec.context).toContain("上一轮");
  });

  it("失败项、上一轮的分数、错误都记下来", () => {
    const rec = buildCallbackRecord("r1", prev, "x", 1234);
    expect(rec.runId).toBe("r1");
    expect(rec.failures).toHaveLength(1);
    expect(rec.previousTotal).toBe(7);
    expect(rec.previousPassed).toBe(6);
    expect(rec.previousError).toBeNull();
    expect(rec.at).toBe(1234);
  });

  it("产物名字和别的产物不撞", () => {
    expect(CALLBACK_ARTIFACT_NAME).toBe("callback.json");
  });
});