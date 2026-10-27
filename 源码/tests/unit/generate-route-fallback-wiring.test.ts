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
    expect(src).toContain("decideGate(spec, answers, specFallback)");
  });

  it("标记有初值，且初值是 false —— 没发过 spec 事件时不许凭空说兜底", () => {
    expect(src).toContain("let specFallbackFromStage = false");
  });
});