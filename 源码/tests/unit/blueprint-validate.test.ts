import { describe, expect, it } from "vitest";
import {
  MAX_DEPTH,
  MAX_STEP_NAME_LEN,
  MIN_STEPS,
  validateBlueprint,
} from "@/core/blueprint/validate";
import type { Blueprint, Walkthrough } from "@/core/blueprint/model";
import type { OrgNode, OrgTree } from "@/core/blueprint/org";
import type { Loop, LoopStep } from "@/core/blueprint/loop";

/* ============================================================
   夹具：一份**完全合规**的产物
   每个用例从它出发，只改要测的那一处 ——
   这样断言里出现的问题一定是被改出来的那个，
   而不是夹具本身早就带着的
   ============================================================ */

function leaf(id: string, role: string): OrgNode {
  return {
    id,
    role,
    actions: [],
    watches: [{ label: "构建" }],
    actor: "program",
    children: [],
  };
}

const ORG: OrgTree = {
  root: {
    id: "owner",
    role: "我",
    actions: ["定方向"],
    watches: [],
    actor: "human",
    children: [
      {
        id: "hub-agent",
        role: "编排 Agent",
        actions: ["收汇报", "派活", "验收"],
        watches: [],
        actor: "ai",
        children: [
          {
            id: "fe",
            role: "前端 Agent",
            actions: ["做页面"],
            watches: [{ label: "构建" }],
            actor: "ai",
            children: [leaf("page-a", "页面 A")],
          },
        ],
      },
    ],
  },
  links: [],
};

function step(over: Partial<LoopStep> & { id: string; order: number }): LoopStep {
  return {
    name: "某步",
    actor: "ai",
    mode: "read",
    duty: "做点什么",
    rationale: "为什么要这么做",
    ...over,
  };
}

const LOOP: Loop = {
  title: "一圈",
  hub: { id: "hub", role: "编排", duties: [] },
  steps: [
    step({ id: "s1", order: 1, name: "接数据", actor: "program", mode: undefined }),
    step({ id: "s2", order: 2, name: "看数" }),
    step({ id: "s3", order: 3, name: "给建议" }),
    step({ id: "s4", order: 4, name: "人拍板", actor: "human", mode: undefined }),
    /*
    05 动手是 scope: "outward"，不是 internal。
    参考图上这一步是「出图、写标题和描述、建商品、**上架**」——
    上架就是对外的，而它对应的原理写着「只接批过的活；
    真动店铺前，再问店主一次」。夹具按 internal 写的话，
    "整个圈没有人"这件事就测不出来了 —— 因为没人在做对外的事。
  */
    step({ id: "s5", order: 5, name: "动手", mode: "write", scope: "outward" }),
    step({ id: "s6", order: 6, name: "验收" }),
    step({ id: "s7", order: 7, name: "回流" }),
  ],
  transitions: [{ from: "s7", to: "s1", label: "回到起点" }],
  closure: { label: "下一轮的数据，回到起点" },
};

function walkthrough(over: Partial<Walkthrough> = {}): Walkthrough {
  return {
    title: "走一圈",
    beats: LOOP.steps.map((s) => ({ stepId: s.id, content: `${s.name} 的具体内容` })),
    ...over,
  };
}

function bp(over: Partial<Blueprint> = {}): Blueprint {
  return { org: ORG, loop: LOOP, walkthrough: walkthrough(), ...over };
}

/* ============================================================
   基线与工具
   ============================================================ */

/** 只看某一类问题，断言时不被别的噪音干扰 */
function errorsOf(b: Blueprint, scope?: string) {
  return validateBlueprint(b).errors.filter((e) => !scope || e.scope === scope);
}
function warningsOf(b: Blueprint) {
  return validateBlueprint(b).warnings;
}

/** 深拷贝，避免用例之间互相污染 */
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

describe("校验 · 合规的产物", () => {
  it("【基线】这份夹具必须是完全通过的", () => {
    /*
      这条最重要：如果基线本身就有问题，
      后面每条"改了 X 应该报错"的用例都可能是因为夹具早就坏了而红 ——
      那种红会让人误以为改动生效了。
    */
    const r = validateBlueprint(bp());
    expect(r.errors, `基线有错：${r.errors.map((e) => e.message).join(" / ")}`).toHaveLength(0);
    expect(r.ok).toBe(true);
    expect(r.summary).toBe("没有问题");
  });
});

describe("校验 · 组织结构", () => {
  it("叶子没写看什么数 → 必须修", () => {
    const b = bp();
    const org = clone(b.org);
    org.root.children[0].children[0].children[0].watches = [];

    const errs = errorsOf({ ...b, org }, "org");
    expect(errs).toHaveLength(1);
    expect(errs[0].message).toContain("没写它看什么数");
    // 报错要带上怎么修，不能只说"请修正"
    expect(errs[0].fix).toContain("指标");
  });

  it("id 重复 → 必须修", () => {
    const b = bp();
    const org = clone(b.org);
    org.root.children[0].children[0].id = "page-a"; // 和它自己下面那个叶子撞了

    const errs = errorsOf({ ...b, org }, "org");
    expect(errs.some((e) => e.message.includes("重复"))).toBe(true);
  });

  it("角色没名字 → 必须修", () => {
    const b = bp();
    const org = clone(b.org);
    org.root.children[0].children[0].role = "   ";

    expect(errorsOf({ ...b, org }, "org").some((e) => e.message.includes("没有名字"))).toBe(true);
  });

  it("连线连到不存在的位置 → 必须修", () => {
    const b = bp();
    const org = clone(b.org);
    org.links = [
      { from: "fe", to: "不存在", down: { label: "派活" }, up: { label: "日报" } },
    ];

    expect(errorsOf({ ...b, org }, "org").some((e) => e.message.includes("不存在"))).toBe(true);
  });

  it("一条线连到自己 → 必须修", () => {
    const b = bp();
    const org = clone(b.org);
    org.links = [{ from: "fe", to: "fe", down: { label: "x" }, up: { label: "y" } }];

    expect(errorsOf({ ...b, org }, "org").some((e) => e.message.includes("连到了它自己"))).toBe(
      true,
    );
  });

  it("树太深 → 只是提醒，不拦", () => {
    /*
      这条守的是 error / warning 的分界：
      如果把"树有 6 层"也当 error，生成会因为一个版面问题整个失败 ——
      那比问题本身糟得多。
    */
    const b = bp();
    const org = clone(b.org);
    let cursor = org.root.children[0].children[0];
    for (let i = 0; i < MAX_DEPTH + 1; i++) {
      const next = leaf(`deep-${i}`, `深层 ${i}`);
      cursor.children.push(next);
      cursor = next;
    }

    const r = validateBlueprint({ ...b, org });
    expect(r.ok, "树深不该拦下整份产物").toBe(true);
    expect(r.warnings.some((w) => w.message.includes("层"))).toBe(true);
  });

  it("没有人 → 提醒（人属于权限，不是结构问题）", () => {
    const b = bp();
    const org = clone(b.org);
    org.root.actor = "ai";

    const w = warningsOf({ ...b, org });
    expect(w.some((x) => x.message.includes("没有人"))).toBe(true);
  });
});

describe("校验 · 闭环", () => {
  it("【最要紧】原理没写 → 必须修", () => {
    /*
      缺了原理，这一步就只是"一个名字 + 一个箭头"，
      而看的人只会问"凭什么这么设计"。
    */
    const b = bp();
    const loop = clone(b.loop);
    loop.steps[2].rationale = "";

    const errs = errorsOf({ ...b, loop }, "loop");
    expect(errs).toHaveLength(1);
    expect(errs[0].message).toContain("没写原理");
    // 报错文案本身要示范一句好的原理长什么样
    expect(errs[0].fix).toContain("为什么要有这一步");
  });

  it("步数太少 → 必须修", () => {
    const b = bp();
    const loop = clone(b.loop);
    loop.steps = loop.steps.slice(0, MIN_STEPS - 1);

    expect(errorsOf({ ...b, loop }, "loop").some((e) => e.message.includes("谈不上"))).toBe(true);
  });

  it("序号重复 → 必须修", () => {
    const b = bp();
    const loop = clone(b.loop);
    loop.steps[2].order = 2;

    expect(errorsOf({ ...b, loop }, "loop").some((e) => e.message.includes("用了两次"))).toBe(true);
  });

  it("步骤 id 撞上 hub → 必须修", () => {
    // 撞了之后连线会连到中心去，而画面上看不出来
    const b = bp();
    const loop = clone(b.loop);
    loop.steps[0].id = "hub";

    expect(errorsOf({ ...b, loop }, "loop").some((e) => e.message.includes("hub"))).toBe(true);
  });

  it("没闭上 → 必须修", () => {
    const b = bp();
    const loop = clone(b.loop);
    loop.transitions = [];
    delete loop.closure;

    expect(errorsOf({ ...b, loop }, "loop").some((e) => e.message.includes("没有闭上"))).toBe(true);
  });

  it("【权限失守】对外动作 + 整个圈没人 → 必须修，且说清原因", () => {
    // 把「人拍板」换成 AI：于是这一圈会自己上架，没有人为它负责
    const b = bp();
    const loop = clone(b.loop);
    loop.steps[3].actor = "ai";
    loop.steps[3].mode = "read";

    const errs = errorsOf({ ...b, loop }, "loop");
    const hit = errs.find((e) => e.message.includes("对外产生后果"));
    expect(hit, "权限失守没有被拦下来").toBeDefined();
    // 报错要点出是哪一步在对外，而不是笼统说"缺少审批"
    expect(hit!.message).toContain("动手");
    // 修法要指回参考图的 04，而不是只说"请补一步人"
    expect(hit!.fix).toContain("04");
  });

  it("有人的话，同一个对外动作只是「要人点头」，不算失守", () => {
    // 反面对照：只动一处（把人放回来），结论就该翻过来
    const b = bp();
    const loop = clone(b.loop);

    const r = validateBlueprint({ ...b, loop });
    expect(r.ok).toBe(true);
    expect(r.errors.some((e) => e.message.includes("对外产生后果"))).toBe(false);
  });

  it("连线连到不存在的位置 → 必须修", () => {
    const b = bp();
    const loop = clone(b.loop);
    loop.transitions.push({ from: "s1", to: "s99", label: "x" });

    expect(errorsOf({ ...b, loop }, "loop").some((e) => e.message.includes("不存在的位置"))).toBe(
      true,
    );
  });

  it("动手排在拍板前面 → 提醒，不拦", () => {
    // 「先让它看，再让它干」是顺序问题，不是自相矛盾
    const b = bp();
    const loop = clone(b.loop);
    loop.steps[4].order = 3;
    loop.steps[2].order = 5;

    const r = validateBlueprint({ ...b, loop });
    expect(r.warnings.some((w) => w.message.includes("排在它后面"))).toBe(true);
  });

  it("步骤名太长 → 提醒", () => {
    const b = bp();
    const loop = clone(b.loop);
    loop.steps[1].name = "看".repeat(MAX_STEP_NAME_LEN + 1);

    expect(warningsOf({ ...b, loop }).some((w) => w.message.includes("个字"))).toBe(true);
  });

  it("AI 没写模式 → 提醒（会被按对外处理，也就是会多问一次人）", () => {
    const b = bp();
    const loop = clone(b.loop);
    delete loop.steps[1].mode;

    expect(warningsOf({ ...b, loop }).some((w) => w.message.includes("只读还是干活"))).toBe(true);
  });
});

describe("校验 · 走通的例子", () => {
  it("漏了一步 → 必须修", () => {
    const b = bp();
    const wt = clone(b.walkthrough!);
    wt.beats = wt.beats.filter((x) => x.stepId !== "s3");

    const errs = errorsOf({ ...b, walkthrough: wt }, "walkthrough");
    expect(errs).toHaveLength(1);
    expect(errs[0].message).toContain("漏了");
  });

  it("多了一块对不上任何步骤 → 必须修", () => {
    const b = bp();
    const wt = clone(b.walkthrough!);
    wt.beats.push({ stepId: "s99", content: "多出来的" });

    expect(
      errorsOf({ ...b, walkthrough: wt }, "walkthrough").some((e) => e.message.includes("对不上")),
    ).toBe(true);
  });

  it("有一块是空的 → 必须修", () => {
    const b = bp();
    const wt = clone(b.walkthrough!);
    wt.beats[0].content = "  ";

    expect(
      errorsOf({ ...b, walkthrough: wt }, "walkthrough").some((e) => e.message.includes("空")),
    ).toBe(true);
  });

  it("没有走通的例子不算错 —— 阶段 1 先做渲染时就是这样", () => {
    const r = validateBlueprint(bp({ walkthrough: undefined }));
    expect(r.ok).toBe(true);
    expect(r.issues.some((i) => i.scope === "walkthrough")).toBe(false);
  });

  it("里程碑只写一半 → 提醒（底部那条链会断断续续）", () => {
    const b = bp();
    const wt = clone(b.walkthrough!);
    wt.beats[0].milestone = "有了点什么";

    expect(warningsOf({ ...b, walkthrough: wt }).some((w) => w.message.includes("里程碑"))).toBe(
      true,
    );
  });
});

describe("校验 · 报告本身", () => {
  it("ok 只看 error，不看 warning", () => {
    const b = bp();
    const loop = clone(b.loop);
    loop.steps[1].name = "很长的步骤名字";

    const r = validateBlueprint({ ...b, loop });
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.ok).toBe(true);
  });

  it("每条问题都要带修法 —— 只说错在哪帮不上忙", () => {
    const b = bp();
    const loop = clone(b.loop);
    const org = clone(b.org);
    loop.steps[0].rationale = "";
    org.root.children[0].children[0].children[0].watches = [];

    for (const i of validateBlueprint({ ...b, loop, org }).issues) {
      expect(i.fix.trim().length, `「${i.message}」没有给修法`).toBeGreaterThan(0);
    }
  });

  it("汇总是一句人话", () => {
    const b = bp();
    const loop = clone(b.loop);
    loop.steps[0].rationale = "";
    loop.steps[1].name = "很长的步骤名字";

    expect(validateBlueprint({ ...b, loop }).summary).toBe("1 处必须修，1 处建议改");
  });

  it("多处问题一次全报出来，不是遇到第一个就停", () => {
    // 只报第一个的话，生成要重试很多轮才能改完
    const b = bp();
    const loop = clone(b.loop);
    loop.steps[0].rationale = "";
    loop.steps[1].rationale = "";
    loop.steps[2].duty = "";

    expect(errorsOf({ ...b, loop }, "loop").length).toBeGreaterThanOrEqual(3);
  });
});