import { describe, expect, it } from "vitest";
import {
  completeBlueprint,
  describeFallback,
  fallbackBlueprint,
  isFallbackBlueprint,
} from "@/core/blueprint/fallback";
import { validateBlueprint } from "@/core/blueprint/validate";
import { isClosed, loopStats } from "@/core/blueprint/loop";
import { orgStats } from "@/core/blueprint/org";

describe("降级骨架 · 完整性", () => {
  it("【最要紧】骨架必须通过校验", () => {
    /*
      骨架是给人看的第一份东西。它自己残缺的话，
      用户看到的是一个坏掉的产品，而不是"这次没生成出来"。

      这条也是给未来的自己上的锁：**改了模型忘了改骨架，它立刻红**。
      没有它，"骨架"会随着模型演进而悄悄烂掉，而没人会发现 ——
      因为它只在出错的时候才出现。
    */
    const r = validateBlueprint(fallbackBlueprint("测试"));
    expect(
      r.errors,
      `骨架自己也过不了校验：${r.errors.map((e) => `${e.path} ${e.message}`).join(" / ")}`,
    ).toHaveLength(0);
    expect(r.ok).toBe(true);
  });

  it("【同样要紧】骨架不该有一堆提醒", () => {
    // 全是通过但满是 warning，说明它是"勉强合法"而不是"完整"
    const r = validateBlueprint(fallbackBlueprint("测试"));
    expect(
      r.warnings,
      `骨架有 ${r.warnings.length} 处提醒：${r.warnings.map((w) => w.message).join(" / ")}`,
    ).toHaveLength(0);
  });

  it("七步一步不省 —— 那七步本身就是这套方法论", () => {
    const bp = fallbackBlueprint("测试");
    expect(bp.loop.steps).toHaveLength(7);
    expect(bp.loop.steps.map((s) => s.name)).toEqual([
      "接数据",
      "看现状",
      "给建议",
      "我拍板",
      "动手",
      "验收",
      "回流",
    ]);
  });

  it("顺序照搬参考图，且是闭合的", () => {
    const bp = fallbackBlueprint("测试");
    expect(isClosed(bp.loop)).toBe(true);
    expect(loopStats(bp.loop).closed).toBe(true);
  });

  it("权限是稳的：只有一步对外，且有一步人拍板", () => {
    const s = loopStats(fallbackBlueprint("测试").loop);
    // 参考图上也只有一步人拍板 —— 人管得越多，圈转得越慢
    expect(s.humanGated).toBe(1);
    // 读写分离：多数步骤只看不改
    expect(s.readOnly).toBeGreaterThanOrEqual(4);
  });

  it("组织结构是四层，且每个叶子都看得到数", () => {
    const bp = fallbackBlueprint("测试");
    const s = orgStats(bp.org);
    expect(s.depth).toBe(4);
    // 骨架里除了人和总管，其余节点都该有看数
    expect(s.watchedRatio).toBeGreaterThanOrEqual(0.7);
  });

  it("走通的例子每一步都填了，且和步骤对得上", () => {
    const bp = fallbackBlueprint("测试");
    expect(bp.walkthrough).toBeDefined();
    const beatIds = bp.walkthrough!.beats.map((b) => b.stepId);
    expect(beatIds).toEqual(bp.loop.steps.map((s) => s.id));
  });
});

describe("降级骨架 · 通用性", () => {
  it("没有具体业务词 —— 它是模板，不是例子", () => {
    /*
      骨架里出现「店铺 A」「抖音号」这种词的话，
      用户会以为"系统知道我开的是网店"。
      它是给任何软件项目的模板，措辞必须是通用的。
    */
    const text = JSON.stringify(fallbackBlueprint("测试"));
    // 参考图里那些电商词一个都不该有
    for (const word of ["店铺", "抖音", "仓库 A", "香型", "葡萄柚", "店主"]) {
      expect(text, `骨架里混进了具体业务词「${word}」`).not.toContain(word);
    }
  });

  it("骨架和现有产品同构 —— 需求/编码/测试/交付", () => {
    // 用一套和六道工序能对上的结构，用户不会觉得是两个东西
    const org = fallbackBlueprint("测试").org;
    const roles = org.root.children[0].children.map((c) => c.role);
    expect(roles).toEqual(["需求 Agent", "编码 Agent", "测试 Agent", "交付 Agent"]);
  });

  it("同一个原因两次调用得到同样的东西（没有随机）", () => {
    // 有随机的话，同一份日志里的两次降级会对不上，排查时很困惑
    const a = JSON.stringify(fallbackBlueprint("超时"));
    const b = JSON.stringify(fallbackBlueprint("超时"));
    expect(a).toBe(b);
  });
});

describe("降级骨架 · 承认自己是骨架", () => {
  it("打上了标记", () => {
    expect(isFallbackBlueprint(fallbackBlueprint("模型超时"))).toBe(true);
  });

  it("原因原样留着 —— 它是排查的线索", () => {
    expect(fallbackBlueprint("模型超时").fallback?.reason).toBe("模型超时");
  });

  it("给用户的话说清「这份是什么」，而不是「哪里失败了」", () => {
    /*
      失败是过程，用户关心的是**他手上这份东西是什么**。
      「生成失败」四个字说完，用户还是不知道屏幕上这是什么。
    */
    const text = describeFallback(fallbackBlueprint("模型超时"));
    expect(text).not.toBeNull();
    expect(text).toContain("通用模板");
    expect(text).toContain("不是根据你的描述生成的");
    expect(text).toContain("模型超时");
  });

  it("正常产物没有标记，也没有那句话", () => {
    const normal = completeBlueprint(
      { org: fallbackBlueprint("x").org, loop: fallbackBlueprint("x").loop, walkthrough: fallbackBlueprint("x").walkthrough },
      "不该用到",
    );
    expect(isFallbackBlueprint(normal)).toBe(false);
    expect(describeFallback(normal)).toBeNull();
  });
});

describe("降级骨架 · 补残缺的产物", () => {
  it("三块都给齐 = 不算降级，不打标记", () => {
    const full = fallbackBlueprint("x");
    const r = completeBlueprint(
      { org: full.org, loop: full.loop, walkthrough: full.walkthrough },
      "不该用到",
    );
    expect(isFallbackBlueprint(r)).toBe(false);
  });

  it("缺一块 = 补上那一块，**并且一定打标记**", () => {
    /*
      分三次调用时，成了两次的情况很常见。
      把成功的那两份丢掉太浪费 —— 用户拿到的图会更贴近他的描述。
      但补过的产物必须带标记：不标的话，
      用户会把通用模板当成为他定制的。
    */
    const full = fallbackBlueprint("x");
    const r = completeBlueprint({ org: full.org, loop: full.loop }, "例子那块没生成出来");

    expect(r.walkthrough).toBeDefined(); // 补上了
    expect(isFallbackBlueprint(r)).toBe(true); // 但打了标记
    expect(describeFallback(r)).toContain("例子那块没生成出来");
    // 补完的仍然要能通过校验
    expect(validateBlueprint(r).ok).toBe(true);
  });

  it("保住已经生成出来的那部分，不被骨架覆盖", () => {
    // 这条守的是"补"而不是"重来"
    const custom = fallbackBlueprint("x");
    custom.org.root.role = "我的团队";

    const r = completeBlueprint({ org: custom.org }, "缺两块");
    expect(r.org.root.role).toBe("我的团队");
  });

  it("什么都不给 = 整份骨架", () => {
    const r = completeBlueprint({}, "全都没生成出来");
    expect(isFallbackBlueprint(r)).toBe(true);
    expect(validateBlueprint(r).ok).toBe(true);
  });
});