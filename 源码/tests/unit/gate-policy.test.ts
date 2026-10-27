import { describe, expect, it } from "vitest";
import { declaredGates, resolveGatePolicy } from "@/core/pipeline/gate-policy";
import { STAGE_MAP, stageApproval, stageAuthorityNote } from "@/core/pipeline/stages";

/**
 * 保护门禁策略：声明说了算、加严永远允许、放松必须留下 overrideNote。
 * 改之前 humanGate 没有任何代码读它，实际门禁是 SPEC_GATE 环境变量。
 */

describe("门禁策略 · 权限模型说了算", () => {
  it("声明要人点头的工序，按声明来就是会停", () => {
    const p = resolveGatePolicy("spec", "declared");
    expect(p.declared).toBe(true);
    expect(p.active).toBe(true);
    expect(p.overridden).toBe(false);
    expect(p.overrideNote).toBeNull();
  });

  it("声明不用人点头的工序，按声明来就是不停", () => {
    const p = resolveGatePolicy("build", "declared");
    expect(p.declared).toBe(false);
    expect(p.active).toBe(false);
    expect(p.overridden).toBe(false);
  });

  it("只有规格化声明了要人点头", () => {
    expect(declaredGates()).toEqual(["spec"]);
  });

  it("策略里的 reason 就是工序自己的权限说明", () => {
    // 界面上的说明由核心层生成，不各写各的
    expect(resolveGatePolicy("spec", "declared").reason).toBe(
      stageAuthorityNote(STAGE_MAP.spec),
    );
  });
});

describe("门禁策略 · 加严永远允许", () => {
  it("强制停下：声明里没写也停", () => {
    // build 声明不用人点头，但强制 pause 时照样停
    const p = resolveGatePolicy("build", "pause");
    expect(p.declared).toBe(false);
    expect(p.active).toBe(true);
    // 加严不算"覆盖" —— 它没和声明冲突，只是比声明更严
    expect(p.overridden, "加严被标成了覆盖").toBe(false);
    expect(p.overrideNote).toBeNull();
  });

  it("加严时也不留痕迹 —— 多问一次人不需要解释", () => {
    // 多问一次只是烦，放过一次不可逆：所以加严不需要理由，放松才需要。
    expect(resolveGatePolicy("spec", "pause").overrideNote).toBeNull();
    expect(resolveGatePolicy("build", "pause").overrideNote).toBeNull();
  });
});

describe("门禁策略 · 放松必须说出来", () => {
  it("【关键】覆盖声明放行时，会留下 overrideNote", () => {
    const p = resolveGatePolicy("spec", "continue");
    expect(p.declared).toBe(true);
    expect(p.active).toBe(false);
    expect(p.overridden, "覆盖了却没标出来").toBe(true);
    expect(p.overrideNote).toBeTruthy();
  });

  it("那段话说清了三件事", () => {
    // 静默关掉的门禁比没有更糟：界面上还写着要人点头。
    // 这段话要说清哪一步被放行、会发生什么、代价什么时候暴露。
    const note = resolveGatePolicy("spec", "continue").overrideNote!;
    expect(note).toContain("规格化"); // 一
    expect(note).toContain("替你猜"); // 二
    expect(note).toContain("钱已经花完"); // 三
  });

  it("对本来就不用批的工序，「放行」不算是覆盖", () => {
    // 声明和实践一致，没什么好说的
    const p = resolveGatePolicy("build", "continue");
    expect(p.declared).toBe(false);
    expect(p.active).toBe(false);
    expect(p.overridden, "一致的情况被标成了覆盖").toBe(false);
    expect(p.overrideNote).toBeNull();
  });

  it("overrideNote 用 null 而不是空串表示「没有覆盖」", () => {
    // 空串的话调用方分不清"没有覆盖"和"有覆盖但理由为空"
    for (const o of ["declared", "pause"] as const) {
      expect(resolveGatePolicy("spec", o).overrideNote).toBeNull();
    }
  });
});

describe("门禁策略 · 三个档位都自洽", () => {
  it("active 永远等于「声明 or 强制停下」，且被放行时一定标了覆盖", () => {
    const stages = Object.keys(STAGE_MAP) as Array<keyof typeof STAGE_MAP>;
    for (const id of stages) {
      for (const o of ["declared", "pause", "continue"] as const) {
        const p = resolveGatePolicy(id, o);
        if (o === "pause") {
          expect(p.active, `${id} 强制停下却没停`).toBe(true);
        } else if (o === "continue") {
          expect(p.active).toBe(false);
          // 只有"声明要批"时放行才算覆盖
          expect(p.overridden, `${id} 的覆盖标记不对`).toBe(p.declared);
          expect(!!p.overrideNote).toBe(p.declared);
        } else {
          expect(p.active).toBe(p.declared);
          expect(p.overridden).toBe(false);
        }
      }
    }
  });

  it("没有一种组合会既不停、又不标覆盖、而声明又说要批", () => {
    // 出现这种组合，就说明界面上的要人点头是句空话。
    const stages = Object.keys(STAGE_MAP) as Array<keyof typeof STAGE_MAP>;
    for (const id of stages) {
      for (const o of ["declared", "pause", "continue"] as const) {
        const p = resolveGatePolicy(id, o);
        if (p.declared && !p.active) {
          expect(p.overridden, `${id} + ${o}：声明要批、实际没停，却没标覆盖`).toBe(true);
          expect(p.overrideNote, `${id} + ${o}：标了覆盖却不说为什么`).toBeTruthy();
        }
      }
    }
  });

  it("approval 和 declared 是同一件事的两种问法", () => {
    const stages = Object.keys(STAGE_MAP) as Array<keyof typeof STAGE_MAP>;
    for (const id of stages) {
      expect(resolveGatePolicy(id, "declared").declared).toBe(
        stageApproval(STAGE_MAP[id]) === "human",
      );
    }
  });
});