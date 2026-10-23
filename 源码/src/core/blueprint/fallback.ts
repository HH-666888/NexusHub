/**
 * 研发团队运转图 —— 降级骨架
 * ============================================================
 * 模型会失败。超时、JSON 不合法、接口 500、余额不够 ——
 * 这些都不是"如果"，是"什么时候"。
 *
 * 失败时不能白屏。
 *
 * ── 但也不能拿骨架冒充生成结果 ──
 *   所以骨架必须**自己承认是骨架**：Blueprint 上带一个 fallback 标记，
 *   界面上据此明确标出「这是通用模板，不是为你定制的」。
 *   这和规格化那一块是同一条纪律：
 *   未接入的工序不许标成"已通过"，降级的骨架不许标成"已生成"。
 *
 * ── 骨架为什么也要通过校验 ──
 *   骨架是给人看的第一份东西。如果它自己都是残缺的，
 *   用户看到的是一个坏掉的产品，而不是"这次没生成出来"。
 *   所以这里有一条硬测试：**骨架必须通过 validateBlueprint**。
 *   它逼着骨架保持完整 —— 改了模型忘了改骨架，测试立刻红。
 */

import type { Blueprint, Walkthrough } from "./model";
import type { OrgNode, OrgTree } from "./org";
import type { Loop, LoopStep } from "./loop";

/* ============================================================
   标记
   ============================================================ */

/** 这份是不是降级骨架 */
export function isFallbackBlueprint(bp: Blueprint): boolean {
  return bp.fallback !== undefined;
}

/**
 * 给用户看的一句话。
 *
 * 措辞上刻意不说「生成失败」—— 失败是过程，
 * 用户关心的是**他手上这份东西是什么**。
 */
export function describeFallback(bp: Blueprint): string | null {
  if (!bp.fallback) return null;
  return `这是一份通用模板，不是根据你的描述生成的（${bp.fallback.reason}）`;
}

/* ============================================================
   骨架内容
   ============================================================ */

/** 造一个叶子资产。骨架里它们都是"程序在收数" */
function asset(id: string, role: string, metrics: string[]): OrgNode {
  return {
    id,
    role,
    actions: [],
    watches: metrics.map((label) => ({ label })),
    actor: "program",
    children: [],
  };
}

/**
 * 一棵通用的研发团队树。
 *
 * ── 为什么是这四个领域 ──
 *   需求 / 编码 / 测试 / 交付 —— 这是任何软件项目都绕不开的四块，
 *   而且它们和六道工序能对上（规格化↔需求、构建↔编码、
 *   验收↔测试、交付↔交付）。
 *   骨架用一套和现有产品同构的结构，用户看到它时不会觉得是两个东西。
 */
function fallbackOrg(): OrgTree {
  return {
    root: {
      id: "owner",
      role: "我",
      actions: ["定方向"],
      note: "只说做什么，不管怎么做",
      watches: [],
      actor: "human",
      children: [
        {
          id: "orchestrator",
          role: "编排 Agent",
          actions: ["收汇报", "派活", "验收"],
          note: "盯着每一块转没转",
          watches: [],
          actor: "ai",
          children: [
            {
              id: "req",
              role: "需求 Agent",
              actions: ["梳理"],
              watches: [{ label: "需求条目" }, { label: "变更" }],
              actor: "ai",
              children: [asset("req-list", "需求清单", ["每天"])],
            },
            {
              id: "code",
              role: "编码 Agent",
              actions: ["写代码"],
              watches: [{ label: "构建" }, { label: "报错" }],
              actor: "ai",
              children: [asset("repo", "代码仓库", ["提交", "分支"])],
            },
            {
              id: "test",
              role: "测试 Agent",
              actions: ["跑用例"],
              watches: [{ label: "覆盖" }, { label: "失败" }],
              actor: "ai",
              children: [asset("cases", "用例集", ["通过率"])],
            },
            {
              id: "ship",
              role: "交付 Agent",
              actions: ["打包发布"],
              watches: [{ label: "版本" }, { label: "发布" }],
              actor: "ai",
              children: [asset("build", "构建产物", ["大小", "耗时"])],
            },
          ],
        },
      ],
    },
    // 人和总管之间说的话和下面几层不一样，显式写出来
    links: [
      {
        from: "owner",
        to: "orchestrator",
        down: { label: "定方向", hint: "拍板" },
        up: { label: "汇报", hint: "每天按点" },
      },
    ],
  };
}

function fbStep(
  order: number,
  name: string,
  over: Partial<LoopStep> & { id: string },
): LoopStep {
  return {
    order,
    name,
    actor: "ai",
    mode: "read",
    duty: "",
    rationale: "",
    ...over,
  };
}

/**
 * 通用的七步圈。
 *
 * 顺序照搬参考图，一步不省 ——
 * **那七步本身就是这套方法论**，换业务时也不该变。
 * 骨架只换措辞（研发而不是电商），不换结构。
 */
function fallbackLoop(): Loop {
  return {
    title: "一支研发团队的 AI 闭环：7 步转一圈",
    hint: "建议先交编排 Agent，再到我",
    hub: {
      id: "hub",
      role: "编排 Agent",
      note: "盯着每一块转没转",
      duties: [
        { label: "汇总", detail: "几条建议合成一份，每天按点报我" },
        { label: "派活", detail: "我点了头，再交给干活的 AI" },
        { label: "验收", detail: "干完对着要求查，就是 06 这一站" },
      ],
    },
    steps: [
      fbStep(1, "接数据", {
        id: "s1",
        actor: "program",
        duty: "仓库状态、构建结果、报错日志，每天按点收进来",
        rationale: "AI 看不到的，它判断不了；拿不到就直说，不估",
        watches: [{ label: "构建" }, { label: "日志" }],
      }),
      fbStep(2, "看现状", {
        id: "s2",
        duty: "哪些用例没过、哪一块最慢、哪一步掉了",
        rationale: "只看不改：看错了，最多写错一句话",
        watches: [{ label: "用例" }, { label: "性能" }],
      }),
      fbStep(3, "给建议", {
        id: "s3",
        duty: "只说一句「建议……，因为……」",
        rationale: "带着理由，我才判断得了对错",
      }),
      fbStep(4, "我拍板", {
        id: "s4",
        actor: "human",
        duty: "同意、不同意，或者改一改",
        rationale: "发布、删数据、改线上配置，只有人能点头",
      }),
      fbStep(5, "动手", {
        id: "s5",
        mode: "write",
        scope: "outward",
        duty: "写代码、改配置、发布新版本",
        rationale: "只接批过的活；真动线上前，再问我一次",
      }),
      fbStep(6, "验收", {
        id: "s6",
        duty: "做完了没有？做对了没有？",
        rationale: "说做完不算，查过才算；不过就返工",
      }),
      fbStep(7, "回流", {
        id: "s7",
        duty: "上线后跑得怎么样，下一轮又是新数据",
        rationale: "圈每转一次，团队就多一分有数",
      }),
    ],
    transitions: [
      { from: "s3", to: "hub", label: "建议先交编排", direction: "across" },
      { from: "hub", to: "s4", label: "汇总报我", direction: "up" },
      { from: "s4", to: "hub", label: "「同意」", direction: "down" },
      { from: "hub", to: "s5", label: "派活", direction: "across" },
      { from: "s5", to: "hub", label: "做完交编排", direction: "up" },
      { from: "s6", to: "hub", label: "查过才算完", direction: "across" },
      { from: "s7", to: "s1", label: "下一轮的数据，回到起点", direction: "across" },
    ],
    closure: { label: "下一轮的数据，回到起点", hint: "圈每转一次，就多一分有数" },
  };
}

/**
 * 通用的走通例子。
 *
 * 骨架也要有它 —— 缺一整块的骨架比没有骨架更糟：
 * 用户会以为"这个产品就是画不出例子"，而不是"这次没生成出来"。
 */
function fallbackWalkthrough(): Walkthrough {
  return {
    title: "修一个 bug，完整走一圈",
    hint: "同一个圈，这次走修问题这条路",
    beats: [
      { stepId: "s1", content: "把仓库状态、构建结果、报错收进来", milestone: "每天按点自动收" },
      { stepId: "s2", content: "三个用例没过，都在登录那一块", milestone: "定位到登录" },
      { stepId: "s3", content: "建议先修登录，因为它是所有流程的入口", milestone: "建议先修登录" },
      { stepId: "s4", content: "同意，先修登录校验，别的往后放", milestone: "「同意」" },
      { stepId: "s5", content: "改了登录校验，本地跑通那三个用例", milestone: "改完了" },
      { stepId: "s6", content: "三条用例都过了，报错也清了", milestone: "查过才算完" },
      { stepId: "s7", content: "下一轮构建又出新数据，接着看", milestone: "回到起点" },
    ],
    artifacts: [
      { name: "定位结果", hint: "登录那一块" },
      { name: "改动", hint: "登录校验" },
      { name: "通过记录", hint: "3 条用例" },
    ],
  };
}

/* ============================================================
   组装
   ============================================================ */

/**
 * 造一份完整的降级骨架。
 *
 * @param reason 为什么降级。会显示给用户，所以要写人话 ——
 *               「模型返回的 JSON 不合法」而不是「parse error」。
 */
export function fallbackBlueprint(reason: string): Blueprint {
  return {
    org: fallbackOrg(),
    loop: fallbackLoop(),
    walkthrough: fallbackWalkthrough(),
    fallback: { reason },
  };
}

/**
 * 给一份残缺的产物补上缺的部分，并打上降级标记。
 *
 * ── 为什么要有它，而不是"失败就整份重来" ──
 *   生成是**分三次调用**的（先运转图、再闭环、再例子）。
 *   三次里成了两次的话，把成功的那两份丢掉太浪费 ——
 *   用户拿到的图会更贴近他的描述。
 *   所以这里只补缺的那一块：给了的保留，没给的用骨架。
 *
 * 注意：补过的产物**一定带降级标记**，因为至少有一块不是生成的。
 *   不标的话，用户会把通用模板当成为他定制的。
 */
export function completeBlueprint(
  partial: Partial<Omit<Blueprint, "fallback">>,
  reason: string,
): Blueprint {
  const base = fallbackBlueprint(reason);
  const filled = {
    org: partial.org ?? base.org,
    loop: partial.loop ?? base.loop,
    walkthrough: partial.walkthrough ?? base.walkthrough,
  };

  // 三块都是给的 → 没有用到骨架，不打标记
  const usedFallback =
    !partial.org || !partial.loop || !partial.walkthrough;

  return usedFallback ? { ...filled, fallback: { reason } } : filled;
}