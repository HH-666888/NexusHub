import { describe, expect, it } from "vitest";
import {
  actorCapability,
  authorityOf,
  explainAuthority,
  needsHumanSignoff,
  requiredApproval,
  resolveScope,
} from "@/core/blueprint/authority";
import type { Loop, LoopStep } from "@/core/blueprint/loop";

/** 造一步。默认是"AI 只读"，需要什么改什么 */
function step(over: Partial<LoopStep> = {}): LoopStep {
  return {
    id: "s",
    order: 1,
    name: "某一步",
    actor: "ai",
    mode: "read",
    duty: "做点什么",
    rationale: "为什么要这么做",
    ...over,
  };
}

describe("权限 · 这一步碰什么", () => {
  it("写了范围就用写的", () => {
    expect(resolveScope(step({ scope: "outward", mode: "write" }))).toBe("outward");
    expect(resolveScope(step({ scope: "internal", mode: "write" }))).toBe("internal");
    expect(resolveScope(step({ scope: "observe", mode: "read" }))).toBe("observe");
  });

  it("只读就是只看不改", () => {
    expect(resolveScope(step({ mode: "read" }))).toBe("observe");
  });

  it("【关键】写操作没写范围 = 按「对外」算", () => {
    /*
      这条是整个权限模型里最要紧的一个默认值。
      如果默认按「自己这边」处理，一个漏填范围的线上动作
      就会被放过去 —— 而线上动作不可逆。
      多问一次的代价是烦；放过一次的代价是不可逆。这两个不对等。
    */
    expect(resolveScope(step({ mode: "write" }))).toBe("outward");
  });

  it("人做的事默认算「自己这边」—— 他就是批准者", () => {
    expect(resolveScope(step({ actor: "human", mode: undefined }))).toBe("internal");
  });

  it("程序默认只读 —— 参考图上「接数据」就是程序自动收", () => {
    expect(resolveScope(step({ actor: "program", mode: undefined }))).toBe("observe");
  });

  it("连模式都没写的 AI：也往严的一边倒", () => {
    // 不知道它要干什么的时候，当成"可能对外"处理
    expect(resolveScope(step({ actor: "ai", mode: undefined }))).toBe("outward");
  });
});

describe("权限 · 谁要点头", () => {
  it("只看不改 → 不用批", () => {
    // 参考图 02：「看错了，最多写错一句话」
    expect(requiredApproval(step({ mode: "read" }))).toBe("none");
  });

  it("在自己这边改 → 不用批", () => {
    expect(requiredApproval(step({ mode: "write", scope: "internal" }))).toBe("none");
  });

  it("【关键】对外 → 必须人批", () => {
    // 参考图 04：「上新、下架、对外回复，只有人能点头」
    expect(requiredApproval(step({ mode: "write", scope: "outward" }))).toBe("human");
  });

  it("人自己做的事不用再批自己", () => {
    expect(requiredApproval(step({ actor: "human", scope: "outward" }))).toBe("none");
  });

  it("程序做对外的事，一样要人批", () => {
    // 角色不是豁免理由 —— 会不会对外产生后果才是
    expect(
      requiredApproval(step({ actor: "program", scope: "outward" })),
    ).toBe("human");
  });

  it("needsHumanSignoff 和 requiredApproval 永远一致", () => {
    const cases = [
      step({ mode: "read" }),
      step({ mode: "write" }),
      step({ mode: "write", scope: "internal" }),
      step({ actor: "human" }),
    ];
    for (const c of cases) {
      expect(needsHumanSignoff(c)).toBe(requiredApproval(c) === "human");
    }
  });
});

describe("权限 · 解释给用户听", () => {
  it("每种情况都给得出人话", () => {
    expect(explainAuthority(step({ mode: "read" }))).toContain("只看不改");
    expect(explainAuthority(step({ scope: "outward" }))).toContain("不可逆");
    expect(explainAuthority(step({ scope: "internal" }))).toContain("自己这边");
    expect(explainAuthority(step({ actor: "human" }))).toContain("批准者");
  });

  it("解释里不含代码词 —— 它是给用户看的", () => {
    const words = ["observe", "internal", "outward", "scope", "actor"];
    for (const c of [
      step({ mode: "read" }),
      step({ scope: "outward" }),
      step({ scope: "internal" }),
      step({ actor: "human" }),
    ]) {
      const text = explainAuthority(c);
      for (const w of words) {
        expect(text, `解释里漏了内部词 ${w}`).not.toContain(w);
      }
    }
  });

  it("角色能力说成一句话，不是布尔值", () => {
    expect(actorCapability("human")).toContain("人");
    expect(actorCapability("program")).toContain("只读");
    expect(actorCapability("ai", "read")).toContain("改不了");
    expect(actorCapability("ai", "write")).toContain("问你");
  });
});

/* ============================================================
   整个圈的画像
   ============================================================ */

function loopOf(steps: LoopStep[]): Loop {
  return {
    title: "测试用",
    hub: { id: "hub", role: "编排", duties: [] },
    steps,
    transitions: [],
  };
}

describe("权限 · 整个圈的画像", () => {
  const healthy = loopOf([
    step({ id: "a", order: 1, name: "接数据", actor: "program", mode: undefined }),
    step({ id: "b", order: 2, name: "看数", mode: "read" }),
    step({ id: "c", order: 3, name: "给建议", mode: "read" }),
    step({ id: "d", order: 4, name: "人拍板", actor: "human", mode: undefined }),
    step({ id: "e", order: 5, name: "动手", mode: "write", scope: "internal" }),
    step({ id: "f", order: 6, name: "发布", mode: "write", scope: "outward" }),
  ]);

  it("挑得出要人点头的步骤", () => {
    const r = authorityOf(healthy);
    expect(r.gated.map((g) => g.id)).toEqual(["f"]);
    expect(r.gated[0].reason).toContain("不可逆");
  });

  it("挑得出只看不改的步骤", () => {
    const r = authorityOf(healthy);
    expect(r.observeOnly.map((o) => o.id)).toEqual(["a", "b", "c"]);
  });

  it("有人的圈不算失守", () => {
    expect(authorityOf(healthy).unguarded).toHaveLength(0);
  });

  it("【最要紧的一条】整个圈没有人的话，对外动作就是失守的", () => {
    /*
      这条挡的是：整套流程可以自己对外做决定。
      参考图的 04 就是为这件事存在的 ——
      少了它，前面六步做得再漂亮，这套东西也不能交给它自己跑。
    */
    const noHuman = loopOf([
      step({ id: "a", order: 1, name: "看数", mode: "read" }),
      step({ id: "b", order: 2, name: "发布", mode: "write", scope: "outward" }),
    ]);
    const r = authorityOf(noHuman);
    expect(r.unguarded.map((u) => u.id)).toEqual(["b"]);
    expect(r.verdict).toContain("没有任何一步需要人点头");
  });

  it("有人的话，同一批对外动作就不再是失守", () => {
    // 反面对照：只加一个"人拍板"，结论就该翻过来
    const withHuman = loopOf([
      step({ id: "a", order: 1, name: "看数", mode: "read" }),
      step({ id: "h", order: 2, name: "人拍板", actor: "human", mode: undefined }),
      step({ id: "b", order: 3, name: "发布", mode: "write", scope: "outward" }),
    ]);
    expect(authorityOf(withHuman).unguarded).toHaveLength(0);
    expect(authorityOf(withHuman).gated.map((g) => g.id)).toEqual(["b"]);
  });

  it("失守的结论不软化 —— 这是唯一一条不能让的事", () => {
    const bad = loopOf([step({ mode: "write" })]);
    expect(authorityOf(bad).verdict).toContain("没有任何一步需要人点头");
  });

  it("正常圈的结论是一句人话", () => {
    const v = authorityOf(healthy).verdict;
    expect(v).toContain("3 步只看不改");
    expect(v).toContain("1 步要人点头");
  });

  it("空圈给一句空话，不崩", () => {
    const r = authorityOf(loopOf([]));
    expect(r.verdict).toBe("这个圈还没有步骤");
    expect(r.unguarded).toHaveLength(0);
  });
});