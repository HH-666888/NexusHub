import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 接线断言：兜底标记必须从 spec 事件一路走到门禁（修法 4 第 4 步）
 * ============================================================
 * ── 为什么这条是"源码级"，而不是把 route 跑一遍 ──
 *   `route.ts` 是 Next.js 的 route handler：import 它要拉起 Next 运行时、
 *   better-sqlite3 和会话校验，单测里跑不起来（本项目其余单测都只测 core，
 *   靠假端口把真实调用挡在外面）。
 *
 *   而这条链子的**两端**都已经有各自的单测钉死了：
 *     · spec 事件带着 fallback  —— spec-stage.test.ts
 *     · decideGate 认这个参数    —— gate.test.ts
 *   中间那一跳（事件 → 门禁）没有别的单测能覆盖，而它恰恰是真实运行里
 *   出过问题的那一跳：兜底规格的 questions 是空的，标记半路丢了，
 *   门禁就会说"规格没有疑问，可以直接继续"，把兜底说成了没问题。
 *
 *   所以这里退一步，把"这一跳在源码里确实存在"钉死。
 *   它**能红**：把第二个实参删掉、或改回只传 runId，这几条立刻失败
 *   （已做变异验证：改坏 → 红 → 恢复后 SHA256 逐字节一致）。
 *
 * ── 为什么断言"没有旧写法"，而不只是"有新写法" ──
 *   只断言新写法出现是不够的：函数体里同时留着旧调用也会绿。
 *   所以配一条反例，把 `readGateDecision(runId)` 这种"标记丢了"的形态
 *   明确钉死为不许出现。
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
    // ★ 反例：旧写法（只传 runId）必须不再出现 —— 那正是"标记半路丢了"的形态
    expect(src).not.toContain("readGateDecision(runId)");
  });

  it("readGateDecision 把标记转交给 decideGate —— 判据仍然只有 decideGate 一份", () => {
    expect(src).toContain("decideGate(spec, answers, specFallback, acknowledged)");
  });

  it("标记有初值，且初值是 false —— 没发过 spec 事件时不许凭空说兜底", () => {
    expect(src).toContain("let specFallbackFromStage = false");
  });

  /*
    「知悉并继续」那一跳。
    判据本身是纯函数、有单测（gate.test.ts 的 isAcknowledged / decideGate）；
    这里钉的是"接口真的读了 ack、并且先过 isAcknowledged 再交给门禁"。
    少了 isAcknowledged 这一道，一份**空的** ack（当时压根没疑问）
    就会被当成"他同意我们替他猜" —— 那是把用户的沉默当成授权。
  */
  it("接口读 ack.json，并且先过 isAcknowledged 再交给门禁", () => {
    expect(src).toContain("readJsonArtifact<SpecAck>(runId, ACK_ARTIFACT_NAME)");
    // 而且要**对上具体那几条**：只判断"有没有那份记录"会替他从没看过的疑问放行
    expect(src).toContain("isAcknowledged(ack, pendingQuestions(spec, answers))");
  });
});

/**
 * 续跑那一跳（同一类"接线"问题，所以放在同一个文件里）
 * ============================================================
 * 判据本身是纯函数、有单测（gate.test.ts 的 isGateResume）；
 * 这里钉的是"route.ts 真的去问了这个判据、并且据此跳过了规格化"。
 * 没有这一跳，用户答完疑问再点生成会换一批新疑问，永远走不到下一步 ——
 * 实测连点三次都没过去（run ed8fcdc3）。
 */
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
    // ★ 反例：无条件重跑的老形态必须不再出现 —— 那正是"答了又问"的成因
    expect(src).not.toContain("specFallbackFromStage = false; for await (const e of runSpecStage(");
  });

  it("续跑那一路也要把规格事件重新发一次 —— 每趟开始时事件日志会被清空", () => {
    expect(src).toContain("spec: storedSpec,");
    expect(src).toContain("gate: reviewSpec(storedSpec),");
    expect(src).toContain("isFallbackSpec(storedSpec)");
  });
});

/**
 * 模块思考的接线（还是同一类"接线"问题）
 * ============================================================
 * 数据那一头有单测（build-modules.test.ts 的「模块的思考」那一组），
 * 这里钉的是"编排层真的把它发成了 reasoning 事件、并且只发非空的"。
 * 少了这一跳，界面上并行构建那一步的「思考」tab 就永远是空的 ——
 * 而真实运行里单个模块的思考量到过 12706 tokens。
 */
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