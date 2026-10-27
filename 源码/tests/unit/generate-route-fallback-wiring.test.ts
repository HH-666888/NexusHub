import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 保护生成接口的接线：兜底标记从 spec 事件走到门禁、续跑分支、模块思考事件。
 * route.ts 拉不起运行时，所以这里断言源码里的调用形态，并用反例钉住旧写法不存在。
 */

const ROUTE_PATH = fileURLToPath(
  new URL("../../src/app/api/runs/[id]/generate/route.ts", import.meta.url),
);

/** 压掉空白：断言盯的是"接线在不在"，不是缩进长什么样 */
const src = readFileSync(ROUTE_PATH, "utf8").replace(/\s+/g, " ");

describe("生成接口 · 兜底标记的接线", () => {
  it("spec 事件里的 fallback 被接下来了（spec.json 里没有这个字段）", () => {
    expect(src).toContain('if (e.kind === "spec")');
    expect(src).toContain("specFallbackFromStage = e.fallback");
  });

  it("【关键】门禁拿到的是那个标记，而不是默认的 false", () => {
    expect(src).toContain("readGateDecision(runId, specFallbackFromStage)");
    // 反例：只传 runId 的旧写法必须不再出现，那正是标记半路丢掉的形态。
    expect(src).not.toContain("readGateDecision(runId)");
  });

  it("readGateDecision 把标记转交给 decideGate —— 判据仍然只有 decideGate 一份", () => {
    expect(src).toContain("decideGate(spec, answers, specFallback, acknowledged)");
  });

  it("标记有初值，且初值是 false —— 没发过 spec 事件时不许凭空说兜底", () => {
    expect(src).toContain("let specFallbackFromStage = false");
  });

  // 这一跳的判据本身有单测；这里钉接口真的读了 ack，并且先过 isAcknowledged。
  // 少了那一道，一份空 ack 会被当成用户同意替她猜。
  it("接口读 ack.json，并且先过 isAcknowledged 再交给门禁", () => {
    expect(src).toContain("readJsonArtifact<SpecAck>(runId, ACK_ARTIFACT_NAME)");
    // 而且要**对上具体那几条**：只判断"有没有那份记录"会替他从没看过的疑问放行
    expect(src).toContain("isAcknowledged(ack, pendingQuestions(spec, answers))");
  });
});

// 判据本身有单测；这里钉 route.ts 真的据此跳过了规格化。
// 没有这一跳，用户答完疑问再点生成会换一批新疑问，永远走不到下一步。
describe("生成接口 · 续跑的接线", () => {
  it("重跑规格化之前，先问了「这一趟是不是续跑」", () => {
    // 钉的是"分支由这个判据决定"，不只是"调用了它" ——
    // 只调不用（或把条件改成恒假）在老形态下看不出区别，但用户会"答了又问"
    expect(src).toContain("if (!wantsRevision && isGateResume(storedSpec, storedAnswers, storedAck) && storedSpec) {");
    expect(src).toContain("readJsonArtifact<AppSpec>(runId, SPEC_ARTIFACT_NAME)");
    expect(src).toContain("readJsonArtifact<SpecAnswers>(");
  });

  it("★「按我的回答重出一版规格」那一跳：点了才重出，而且只消费一次", () => {
    // 用户明确要求时**不沿用**，而是把上一版规格与回答交给规格化重出一版
    expect(src).toContain("const wantsRevision =");
    expect(src).toContain("revision:");
    expect(src).toContain("previous: storedSpec, answers: storedAnswers");
    // 出完把标记改回 false —— 不消费的话每次续跑都会白花一次调用
    expect(src).toContain("{ ...storedAnswers, revise: false }");
  });

  it("【关键】续跑时**不跑**规格化那一趟：runSpecStage 必须在 else 分支里", () => {
    expect(src).toContain("} else { for await (const e of runSpecStage(ports, {");
    // 反例：无条件重跑的老形态必须不再出现，那正是答了又问的成因。
    expect(src).not.toContain("specFallbackFromStage = false; for await (const e of runSpecStage(");
  });

  it("续跑那一路也要把规格事件重新发一次 —— 每趟开始时事件日志会被清空", () => {
    expect(src).toContain("spec: storedSpec,");
    expect(src).toContain("gate: reviewSpec(storedSpec),");
    expect(src).toContain("isFallbackSpec(storedSpec)");
  });
});

// 数据那一头有单测；这里钉编排层真的把它发成 reasoning 事件、且只发非空的。
// 少了这一跳，并行构建那一步的思考 tab 永远是空的。
describe("生成接口 · 模块思考的接线", () => {
  it("成功的模块：按 arch 顺序逐条发，每条标出归属", () => {
    expect(src).toContain("【${m.moduleId}】");
  });

  it("失败的模块也要发 —— 截断的那些往往正是想得最多的", () => {
    expect(src).toContain("这个模块没构建成功】");
  });

  it("只有非空思考才发 —— 空思考不许占一条事件", () => {
    expect(src).toContain("if (m.reasoning.trim().length > 0) {");
    expect(src).toContain("if (f.reasoning.trim().length > 0) {");
  });
});