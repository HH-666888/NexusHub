import { describe, expect, it } from "vitest";
import { planModuleResume } from "@/core/generate/resume";

/**
 * 保护断点续跑：按内容哈希判断哪些模块产出可以沿用。
 * 文件在不等于是能用，对不上就重构建，半截代码不许装进产物。
 */

const ids = ["timer-core", "timer-ui", "state-persistence"];

describe("断点续跑 · 决定沿用还是重建", () => {
  it("三个都校验通过 → 全部沿用，一个都不用重跑", () => {
    const plan = planModuleResume(ids, [
      { moduleId: "timer-core", present: true, sha256Ok: true },
      { moduleId: "timer-ui", present: true, sha256Ok: true },
      { moduleId: "state-persistence", present: true, sha256Ok: true },
    ]);
    expect(plan.reuse).toEqual(ids);
    expect(plan.build).toEqual([]);
    expect(plan.rejected).toEqual([]);
    expect(plan.reason).toContain("全部沿用");
  });

  it("只有一个校验通过 → 只补另外两个，说明里写清数字", () => {
    const plan = planModuleResume(ids, [
      { moduleId: "timer-core", present: true, sha256Ok: true },
      { moduleId: "timer-ui", present: false, sha256Ok: false },
      { moduleId: "state-persistence", present: false, sha256Ok: false },
    ]);
    expect(plan.reuse).toEqual(["timer-core"]);
    expect(plan.build).toEqual(["timer-ui", "state-persistence"]);
    expect(plan.reason).toContain("沿用");
    expect(plan.reason).toContain("只补 2 个");
  });

  it("反例：哈希对不上 → **不许**沿用，而且要说清为什么又花了一次钱", () => {
    const plan = planModuleResume(ids, [
      { moduleId: "timer-core", present: true, sha256Ok: false },
      { moduleId: "timer-ui", present: true, sha256Ok: true },
      { moduleId: "state-persistence", present: true, sha256Ok: true },
    ]);
    expect(plan.reuse).toEqual(["timer-ui", "state-persistence"]);
    expect(plan.build).toEqual(["timer-core"]);
    expect(plan.rejected).toHaveLength(1);
    expect(plan.rejected[0].moduleId).toBe("timer-core");
    expect(plan.rejected[0].reason).toContain("哈希");
  });

  it("反例：文件不在（present=false）不算被拒，只算待构建（少写一句话给用户）", () => {
    const plan = planModuleResume(ids, [
      { moduleId: "timer-core", present: false, sha256Ok: false },
      { moduleId: "timer-ui", present: true, sha256Ok: true },
      { moduleId: "state-persistence", present: true, sha256Ok: true },
    ]);
    expect(plan.rejected).toEqual([]);
    expect(plan.build).toEqual(["timer-core"]);
  });

  it("反例：一个文件都没有 → reuse 空、reason 空（不该凭空说'沿用了'）", () => {
    const plan = planModuleResume(ids, []);
    expect(plan.reuse).toEqual([]);
    expect(plan.build).toEqual(ids);
    expect(plan.reason).toBe("");
  });

  it("反例：架构里没有的多余文件不许混进来（换了架构之后的老产出）", () => {
    const plan = planModuleResume(ids, [
      { moduleId: "timer-core", present: true, sha256Ok: true },
      { moduleId: "老的模块", present: true, sha256Ok: true },
    ]);
    expect(plan.reuse).toEqual(["timer-core"]);
    expect(plan.build).toEqual(["timer-ui", "state-persistence"]);
  });

  it("顺序跟着架构走，不跟着文件系统走（界面上的顺序要稳定）", () => {
    const plan = planModuleResume(ids, [
      { moduleId: "state-persistence", present: true, sha256Ok: true },
      { moduleId: "timer-core", present: true, sha256Ok: true },
    ]);
    expect(plan.reuse).toEqual(["timer-core", "state-persistence"]);
    expect(plan.build).toEqual(["timer-ui"]);
  });

  it("架构里没有模块（边角）→ 什么都不复用、也不构建", () => {
    const plan = planModuleResume(
      [],
      [{ moduleId: "timer-core", present: true, sha256Ok: true }],
    );
    expect(plan.reuse).toEqual([]);
    expect(plan.build).toEqual([]);
    expect(plan.reason).toBe("");
  });
});
