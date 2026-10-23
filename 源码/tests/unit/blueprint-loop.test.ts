import { describe, expect, it } from "vitest";
import {
  HUB_ID,
  actorBadge,
  findStep,
  isClosed,
  loopStats,
  sortSteps,
  transitionsOf,
  type Loop,
  type LoopStep,
} from "@/core/blueprint/loop";

/**
 * 一个镜像参考图形状的闭环夹具：7 步 + 中心一个编排角色。
 *
 * ⚠️ 测试夹具，不是产品里的演示数据。
 *    词汇换成了研发（参考图里是电商），因为产品的定位是研发团队 ——
 *    但**形状和参考图完全一致**：01 收 → 02 看 → 03 建议 → 04 人拍板
 *    → 05 动手 → 06 验收 → 07 回流。这个顺序本身就是那套方法论，
 *    换业务时也不该变。
 */
function step(
  order: number,
  name: string,
  over: Partial<LoopStep> = {},
): LoopStep {
  return {
    id: `s${order}`,
    order,
    name,
    actor: "ai",
    mode: "read",
    duty: `${name}的具体动作`,
    rationale: `为什么要有「${name}」这一步`,
    ...over,
  };
}

const LOOP: Loop = {
  title: "一支研发团队的 AI 闭环：7 步转一圈",
  hint: "建议先交编排 Agent，再到我",
  hub: {
    id: HUB_ID,
    role: "编排 Agent",
    note: "盯着每一块转没转",
    duties: [
      { label: "汇总", detail: "几条建议合成一份，每天按点报我" },
      { label: "派活", detail: "我点了头，再交给干活的 AI" },
      { label: "验收", detail: "干完对着要求查，就是 06 这一站" },
    ],
  },
  steps: [
    step(1, "接数据", {
      actor: "program",
      mode: undefined,
      duty: "构建结果、错误日志、用户反馈，每天按点收进来",
      rationale: "AI 看不到的，它判断不了；拿不到就直说，不估",
      watches: [{ label: "构建" }, { label: "日志" }],
    }),
    step(2, "看现状", {
      duty: "哪些用例没过、哪一块最慢、哪一步掉了",
      rationale: "只看不改：看错了，最多写错一句话",
      watches: [{ label: "用例" }, { label: "性能" }],
    }),
    step(3, "给建议", {
      duty: "只说一句「建议……，因为……」",
      rationale: "带着理由，我才判断得了对错",
    }),
    step(4, "我拍板", {
      actor: "human",
      mode: undefined,
      duty: "同意、不同意，或者改一改",
      rationale: "对外发布、删数据、改线上配置，只有人能点头",
    }),
    step(5, "动手", {
      mode: "write",
      duty: "写代码、改接口、补测试",
      rationale: "只接批过的活；真动线上前，再问我一次",
    }),
    step(6, "验收", {
      duty: "做完了没有？做对了没有？",
      rationale: "说做完不算，查过才算；不过就返工",
    }),
    step(7, "回流", {
      duty: "上线后跑得怎么样，下一轮又是新数据",
      rationale: "圈每转一次，团队就多一分有数",
    }),
  ],
  transitions: [
    { from: "s3", to: HUB_ID, label: "建议先交编排", direction: "across" },
    { from: HUB_ID, to: "s4", label: "汇总报我", direction: "up" },
    { from: "s4", to: HUB_ID, label: "「同意」", direction: "down" },
    { from: HUB_ID, to: "s5", label: "派活", direction: "across" },
    { from: "s5", to: HUB_ID, label: "做完交编排", direction: "up" },
    { from: "s6", to: HUB_ID, label: "查过才算完", direction: "across" },
    { from: "s7", to: "s1", label: "下一轮的数据，回到起点", direction: "across" },
  ],
  closure: { label: "下一轮的数据，回到起点", hint: "圈每转一次，就多一分有数" },
};

describe("闭环 · 排序与查找", () => {
  it("按序号排好 —— 输入乱序也照排", () => {
    // 生成出来的东西不该要求顺序正确
    const shuffled = [LOOP.steps[4], LOOP.steps[0], LOOP.steps[6], LOOP.steps[2]];
    expect(sortSteps(shuffled).map((s) => s.order)).toEqual([1, 3, 5, 7]);
  });

  it("排完不改原数组", () => {
    const before = LOOP.steps.map((s) => s.id);
    sortSteps(LOOP.steps);
    expect(LOOP.steps.map((s) => s.id)).toEqual(before);
  });

  it("找得到步骤，找不到给 null", () => {
    expect(findStep(LOOP, "s4")?.name).toBe("我拍板");
    expect(findStep(LOOP, "s99")).toBeNull();
  });

  it("中心的 id 不撞任何步骤", () => {
    expect(findStep(LOOP, HUB_ID)).toBeNull();
  });

  it("取某个角色的所有转换 —— 进出都算", () => {
    // 04 我拍板：进来一条（汇总报我）、出去一条（「同意」）
    expect(transitionsOf(LOOP, "s4")).toHaveLength(2);
    /*
      中心：六条 ——
        s3 → hub  建议先交编排
        hub → s4  汇总报我
        s4 → hub  「同意」
        hub → s5  派活
        s5 → hub  做完交编排
        s6 → hub  查过才算完
    */
    expect(transitionsOf(LOOP, HUB_ID)).toHaveLength(6);
  });
});

describe("闭环 · 是不是真的闭上了", () => {
  it("有说明 + 有回到起点的线 = 闭环成立", () => {
    expect(isClosed(LOOP)).toBe(true);
  });

  it("【关键】只有说明、没有那条线 = 不算闭环", () => {
    /*
      这条挡的是「嘴上说闭环」：
      closure 那段话可以随便写，但图上没有那条线就是没闭上。
      少这一条断言，界面上就会出现一张"自称闭环"的开口流程图。
    */
    const noEdge: Loop = {
      ...LOOP,
      transitions: LOOP.transitions.filter((t) => !(t.from === "s7" && t.to === "s1")),
    };
    expect(isClosed(noEdge)).toBe(false);
  });

  it("只有线、没有说明 = 也不算", () => {
    // 反过来的漏洞：线画了，但没人说"这是一圈的结束"，读图的人看不出来
    const { closure: _drop, ...noClosure } = LOOP;
    expect(isClosed(noClosure as Loop)).toBe(false);
  });

  it("经过中心中转回到起点，也算闭上", () => {
    const viaHub: Loop = {
      ...LOOP,
      transitions: [
        ...LOOP.transitions.filter((t) => !(t.from === "s7" && t.to === "s1")),
        { from: "s7", to: HUB_ID, label: "结果交编排" },
        { from: HUB_ID, to: "s1", label: "新的数据进来" },
      ],
    };
    expect(isClosed(viaHub)).toBe(true);
  });

  it("只有一半的中转不算 —— 去得了回不来", () => {
    const half: Loop = {
      ...LOOP,
      transitions: [
        ...LOOP.transitions.filter((t) => !(t.from === "s7" && t.to === "s1")),
        { from: "s7", to: HUB_ID, label: "结果交编排" },
      ],
    };
    expect(isClosed(half)).toBe(false);
  });

  it("少于两步的圈谈不上闭环", () => {
    const tiny: Loop = { ...LOOP, steps: [LOOP.steps[0]], closure: LOOP.closure };
    expect(isClosed(tiny)).toBe(false);
  });
});

describe("闭环 · 统计", () => {
  it("数得出来每种角色几步", () => {
    const s = loopStats(LOOP);
    expect(s.steps).toBe(7);
    expect(s.byActor.human).toBe(1);
    expect(s.byActor.program).toBe(1);
    // 02 03 05 06 07 = 5 个 AI
    expect(s.byActor.ai).toBe(5);
  });

  it("byActor 加起来等于步数", () => {
    const s = loopStats(LOOP);
    expect(s.byActor.human + s.byActor.ai + s.byActor.program).toBe(s.steps);
  });

  it("只读步骤数 —— 这个数越大，这套流程越安全", () => {
    /*
      02 看现状、03 给建议、06 验收、07 回流 = 4 步只读。
      唯一动手的是 05 —— 这正是那套方法论的核心：
      **读写分离**，先只读，确认了再写。
    */
    expect(loopStats(LOOP).readOnly).toBe(4);
  });

  it("需要人点头的步骤数", () => {
    /*
      参考图上只有一步。
      这个数**不是越大越好**：人管得越多，圈转得越慢。
      它该刚好覆盖"对外动作"。
    */
    expect(loopStats(LOOP).humanGated).toBe(1);
  });

  it("统计里带着闭环结论，界面不用自己再算一遍", () => {
    expect(loopStats(LOOP).closed).toBe(true);
  });

  it("空圈不会崩", () => {
    const empty: Loop = { ...LOOP, steps: [], transitions: [] };
    const s = loopStats(empty);
    expect(s.steps).toBe(0);
    expect(s.closed).toBe(false);
  });
});

describe("闭环 · 徽章", () => {
  it("【关键】AI 必须说清是读还是写", () => {
    /*
      不写模式的话，「看数」和「上架」会显示成同一个徽章，
      而这两件事的风险差了一个数量级 —— 参考图上 02 和 05
      也正是靠这个区分开的。
    */
    expect(actorBadge({ actor: "ai", mode: "read" })).toBe("AI · 只读");
    expect(actorBadge({ actor: "ai", mode: "write" })).toBe("AI · 干活");
  });

  it("AI 没写模式时按「干活」算 —— 宁可保守", () => {
    // 漏填时按风险高的一档显示，而不是按"看起来无害"的那档
    expect(actorBadge({ actor: "ai" })).toBe("AI · 干活");
  });

  it("人和程序不分读写", () => {
    expect(actorBadge({ actor: "human", mode: "read" })).toBe("人");
    expect(actorBadge({ actor: "human", mode: "write" })).toBe("人");
    expect(actorBadge({ actor: "program" })).toBe("程序自动");
  });
});