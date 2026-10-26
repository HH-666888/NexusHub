import { describe, expect, it } from "vitest";
import {
  appendBorn,
  appendStatus,
  maxSeq,
  projectAt,
  type PlanningEvent,
} from "@/core/planning/planning-log";
import {
  hasOrphans,
  type TaskPoint,
  type TaskPointStatus,
} from "@/core/planning/task-point";

/**
 * 规划日志与「到点生成」的单测
 * ============================================================
 * 最要紧的一组在最上面：**到点语义** ——
 * 第 N 步的树里，绝不能出现第 N+1 步才该出生（或永远没出生）的东西。
 *
 * 为什么它排第一：
 *   「画布上第 4、5、6 道工序下面还是空的」这件事，
 *   用户是**看得出来**的。一旦投影多算了未来的点，画面上会先冒出几张
 *   还没到点的卡片 —— 而这不会崩、不会报错，只会让用户觉得
 *   「它是不是跳步了」。等到有人肉眼发现，通常已经改了三四个文件。
 *   这条测试把它变成一道机器守着的门。
 *
 * 第二组是**只增不改**：日志是整个方案里唯一的真相来源，
 * 它一旦可以被就地改写，「这一帧为什么是这样」就永远说不清了。
 */

/* ── 造点 ── */

function point(
  id: string,
  parentId: string | null,
  depth: number,
  status: TaskPointStatus,
  bornAtSeq: number,
): TaskPoint {
  return {
    id,
    parentId,
    depth,
    kind: depth <= 2 ? "control" : "exec",
    title: `任务点 ${id}`,
    status,
    bornAtSeq,
  };
}

const AGENT = point("agent-1", null, 1, "planning", 1);
const SPEC = point("spec", "agent-1", 2, "pending", 10);
const ARCH = point("arch", "agent-1", 2, "pending", 20);
const UI = point("ui", "agent-1", 2, "pending", 30);

/** 一级 + 三个二级，二级分别在第 10 / 20 / 30 个 seq 诞生 */
function threeStagesLog(): PlanningEvent[] {
  let log: PlanningEvent[] = [];
  log = appendBorn(log, AGENT);
  log = appendBorn(log, SPEC);
  log = appendBorn(log, ARCH);
  log = appendBorn(log, UI);
  return log;
}

/** 再往里长出第 3 层的执行点 —— 它们才是「干活的最小单元」 */
function richLog(): PlanningEvent[] {
  let log = threeStagesLog();
  log = appendBorn(log, point("spec-1", "spec", 3, "done", 12));
  log = appendBorn(log, point("spec-2", "spec", 3, "running", 14));
  log = appendBorn(log, point("arch-1", "arch", 3, "ready", 22));
  log = appendBorn(log, point("ui-1", "ui", 3, "pending", 32));
  return log;
}

const ids = (points: readonly TaskPoint[]): string[] => points.map((p) => p.id);

function find(points: readonly TaskPoint[], id: string): TaskPoint {
  const hit = points.find((p) => p.id === id);
  if (!hit)
    throw new Error(`投影里没有 ${id}（现有：${ids(points).join(", ") || "空"}）`);
  return hit;
}

/* ── ① 到点语义 ── */

describe("到点语义：第 N 步的树里没有未来的东西", () => {
  it("seq 5：只有一级 Agent，第 1 道工序还没到点", () => {
    expect(ids(projectAt(threeStagesLog(), 5))).toEqual(["agent-1"]);
  });

  it("seq 15：一级 + 第 1 个二级（规格化在第 10 个 seq 出生）", () => {
    expect(ids(projectAt(threeStagesLog(), 15))).toEqual(["agent-1", "spec"]);
  });

  it("seq 25：一级 + 前两个二级", () => {
    expect(ids(projectAt(threeStagesLog(), 25))).toEqual(["agent-1", "spec", "arch"]);
  });

  it("seq 100：三个二级全在", () => {
    expect(ids(projectAt(threeStagesLog(), 100))).toEqual([
      "agent-1",
      "spec",
      "arch",
      "ui",
    ]);
  });

  it("边界取 <=：seq 9 还差一步，seq 10 正好到点", () => {
    /*
      差一步和正好到点是两件事。把 <= 写成 < 的话，
      卡片会晚一帧出现 —— 而「晚一帧」在流式渲染里看起来就像卡了一下。
    */
    expect(ids(projectAt(threeStagesLog(), 9))).toEqual(["agent-1"]);
    expect(ids(projectAt(threeStagesLog(), 10))).toEqual(["agent-1", "spec"]);
  });

  it("seq 0：什么都还没发生，树是空的", () => {
    // 空树是合法状态，不是异常。第 1 个事件（agent 出生在 seq 1）还没来
    expect(projectAt(threeStagesLog(), 0)).toEqual([]);
  });

  it("任何 seq 下都不含 bornAtSeq > seq 的点", () => {
    /*
      这条是上面前四条的机器化表述：不去枚举每个具体 seq，
      而是把「到点」这件事本身写成断言 —— 遍历整条时间轴，
      任何一个投影结果里都不许出现还没出生的点。
      将来日志变长、层级变深，这条照样管用。
    */
    const log = richLog();
    for (let seq = 0; seq <= maxSeq(log) + 5; seq++) {
      for (const p of projectAt(log, seq)) {
        expect(
          p.bornAtSeq,
          `seq=${seq} 时投影出了 ${p.id}（它的 bornAtSeq=${p.bornAtSeq}）`,
        ).toBeLessThanOrEqual(seq);
      }
    }
  });

  it("任何 seq 下都没有孤儿", () => {
    /*
      树的完整性是布局的前提（见 hasOrphans 的注释）。
      这条不变量不是投影算出来的，而是**追加顺序**的责任：
      父节点总是先出生。这里把它在整条时间轴上验一遍，
      保证「到点生成」不会顺手破坏树的结构。
    */
    const log = richLog();
    for (let seq = 0; seq <= maxSeq(log) + 5; seq++) {
      expect(hasOrphans(projectAt(log, seq)), `seq=${seq} 时出现了孤儿`).toBe(false);
    }
  });

  it("未来的点不是「存在但隐藏」—— 它根本不在数组里", () => {
    /*
      这两种做法在界面上看起来一样，在代码里差得很远：
      「存在但隐藏」意味着每个下游函数都得记得判断 visible；
      「不在数组里」意味着下游什么都不用做。
      所以这里断言的是数组本身，而不是某个标志位。
    */
    const now = projectAt(threeStagesLog(), 15);
    expect(now).toHaveLength(2);
    expect(now.some((p) => p.id === "build")).toBe(false);
  });

  it("执行层也按到点生成：第 3 道工序的执行点，在第 3 道工序还没到点时不存在", () => {
    const log = richLog();
    // seq 25：规格化的两个执行点（12 / 14）已经在，架构定型的那个（22）也在，
    // 但界面设计的执行点（32）还没出生
    expect(ids(projectAt(log, 25))).toEqual([
      "agent-1",
      "spec",
      "spec-1",
      "spec-2",
      "arch",
      "arch-1",
    ]);
    expect(ids(projectAt(log, 30))).not.toContain("ui-1");
    expect(ids(projectAt(log, 32))).toContain("ui-1");
  });
});

/* ── ② 只增不改 ── */

describe("只增不改：历史不许被改写", () => {
  it("appendBorn 遇到已存在的 id：整个日志逐项不变", () => {
    /*
      这是幂等性的核心断言，也是「删改现有断言」之外最容易被放松的一条：
      实现里很容易写成「已存在就把状态更新一下」——那正是改写历史。
      这里比对的是**整个数组**，不是长度，也不是某一个字段。
    */
    const log = threeStagesLog();
    const before = structuredClone(log);
    const after = appendBorn(log, SPEC);
    expect(after).toEqual(before);
  });

  it("appendBorn 遇到已存在的 id 时，连新数组都不分配（同一个引用）", () => {
    /*
      调用方多半在 useMemo / reducer 里用它，「没变化」这件事要能被 === 感觉到，
      否则每次重放都会触发一轮无谓的重渲染。
    */
    const log = threeStagesLog();
    expect(appendBorn(log, SPEC)).toBe(log);
  });

  it("appendBorn 遇到已存在的 id 时，传进来的那份点也不会被改写", () => {
    // 换个 bornAtSeq 再传一次，老事件里存的仍然是第一次的那份
    const log = threeStagesLog();
    const after = appendBorn(log, point("spec", "agent-1", 2, "failed", 99));
    expect(find(projectAt(after, 100), "spec").bornAtSeq).toBe(10);
  });

  it("appendBorn 追加新点：老事件一个不动，只在末尾多一条", () => {
    const log = threeStagesLog();
    const after = appendBorn(log, point("build", "agent-1", 2, "pending", 40));
    expect(after).toHaveLength(log.length + 1);
    expect(after.slice(0, log.length)).toEqual(log);
    // 老日志本身没有被就地改（不是因为共享引用才「看起来没变」）
    expect(log).toHaveLength(4);
  });

  it("appendBorn 用 point.bornAtSeq 作为事件的 seq —— 一个事实只有一个来源", () => {
    /*
      如果这里改用 maxSeq(log)+1，就会出现两个数字描述同一件事：
      点说自己生于 7，事件说它是第 0 个。两者一旦对不上，
      投影的「到点」和排序就会各说各话。
    */
    const p = point("x", null, 1, "pending", 7);
    expect(appendBorn([], p)).toEqual([{ kind: "born", seq: 7, point: p }]);
  });

  it("appendStatus 只追加：长度 +1，原有事件逐项不变", () => {
    const log = threeStagesLog();
    const after = appendStatus(log, "spec", "running", 11);
    expect(after).toHaveLength(log.length + 1);
    expect(after.slice(0, log.length)).toEqual(log);
    expect(after[after.length - 1]).toEqual({
      kind: "status",
      seq: 11,
      id: "spec",
      status: "running",
    });
    expect(log).toHaveLength(4);
  });

  it("appendStatus 不查重：同一状态写两遍就是两条，投影结果不受影响", () => {
    /*
      运行器可能只是又确认了一次「它还在跑」。
      在追加这一层查重，就要先扫一遍日志，把 O(1) 变成 O(n)；
      而重复对投影是无害的（取最后一条）。
    */
    let log = threeStagesLog();
    log = appendStatus(log, "spec", "running", 11);
    log = appendStatus(log, "spec", "running", 11);
    expect(log).toHaveLength(6);
    expect(find(projectAt(log, 100), "spec").status).toBe("running");
  });

  it("projectAt 不修改日志", () => {
    const log = threeStagesLog();
    const before = structuredClone(log);
    projectAt(log, 100);
    expect(log).toEqual(before);
  });

  it("projectAt 返回的是快照：改投影结果不会污染日志", () => {
    /*
      投影结果是「某一刻的样子」，不是日志本身。
      如果它返回的是日志里那份点对象，调用方一改，
      就等于绕过日志改了历史 —— 只增不改这条不变量当场破产。
    */
    const log = appendStatus(threeStagesLog(), "spec", "done", 11);
    const projected = projectAt(log, 100);
    const spec = find(projected, "spec");
    spec.status = "failed";
    spec.title = "被就地改过的标题";
    expect(find(projectAt(log, 100), "spec")).toMatchObject({
      status: "done",
      title: "任务点 spec",
    });
  });
});

/* ── ③ 状态投影 ── */

describe("状态投影：最后一条生效，未来的一条不算", () => {
  it("没有状态事件时，用出生时带进来的状态", () => {
    const now = projectAt(threeStagesLog(), 100);
    expect(find(now, "agent-1").status).toBe("planning");
    expect(find(now, "spec").status).toBe("pending");
  });

  it("取最后一条状态事件", () => {
    let log = threeStagesLog();
    log = appendStatus(log, "spec", "running", 11);
    log = appendStatus(log, "spec", "done", 13);
    expect(find(projectAt(log, 100), "spec").status).toBe("done");
  });

  it("截止时刻之后的状态事件不算数", () => {
    /*
      这条和「到点语义」是一体两面：点不会提前出现，
      状态也不会提前生效。回放第 12 步时，第 13 步才写下的 done 不该可见。
    */
    let log = threeStagesLog();
    log = appendStatus(log, "spec", "running", 11);
    log = appendStatus(log, "spec", "done", 13);
    expect(find(projectAt(log, 12), "spec").status).toBe("running");
  });

  it("同一 seq 上的两条状态：后追加的那条赢", () => {
    // 同一时刻写了两条，日志顺序就是唯一的裁决依据
    let log = threeStagesLog();
    log = appendStatus(log, "spec", "done", 11);
    log = appendStatus(log, "spec", "failed", 11);
    expect(find(projectAt(log, 100), "spec").status).toBe("failed");
  });

  it("乱序追加时取 seq 最大的那条，而不是日志里最后一条", () => {
    /*
      正常追加时两者等价（日志按 seq 非递减）。这条测的是**万一有人乱序追加**：
      「最后一条」如果按日志顺序取，就会让一条更早写下的旧状态盖住新状态，
      画面上表现为卡片颜色莫名其妙地退回去 —— 这种错极难查。
      取 seq 最大，代价只是比较一个数字。
    */
    let log = threeStagesLog();
    log = appendStatus(log, "spec", "done", 40);
    log = appendStatus(log, "spec", "running", 25);
    expect(find(projectAt(log, 100), "spec").status).toBe("done");
  });

  it("给还没出生的点写状态：不报错、不影响此刻的投影", () => {
    /*
      事件是流，谁在场由投影决定。为一个暂时不在场的点写状态不是错误，
      在 appendStatus 里拦它反而需要先扫一遍日志。
    */
    let log = threeStagesLog();
    log = appendStatus(log, "build", "running", 5);
    expect(ids(projectAt(log, 5))).toEqual(["agent-1"]);
  });

  it("那条早写的状态事件，等点真的出生后会立刻生效", () => {
    /*
      这是上一条的直接后果，也是有意承认的行为：
      日志里已经写下的历史不会被投影偷偷扔掉。
      真要禁止「出生前的状态」，该拦的地方是 appendStatus，不是投影。
    */
    let log = threeStagesLog();
    log = appendStatus(log, "build", "running", 5);
    log = appendBorn(log, point("build", "agent-1", 2, "pending", 40));
    expect(find(projectAt(log, 100), "build").status).toBe("running");
  });

  it("状态事件指向一个永远不存在的 id：投影里不会凭空多出这个点", () => {
    const log = appendStatus(threeStagesLog(), "ghost", "running", 11);
    const now = projectAt(log, 100);
    expect(now.some((p) => p.id === "ghost")).toBe(false);
    expect(ids(now)).toEqual(["agent-1", "spec", "arch", "ui"]);
  });
});

/* ── ④ 顺序 ── */

describe("顺序：按出生先后，同一时刻按出现先后", () => {
  it("按出生的 seq 排序，而不是按日志里的追加顺序", () => {
    /*
      追加顺序和出生顺序在正常路径下是一致的。
      但只要有任何一个地方按「先拿到先追加」写日志，两者就会分叉 ——
      而画面上卡片的左右位置会跟着跳。所以排序的依据必须是 seq。
    */
    let log: PlanningEvent[] = [];
    log = appendBorn(log, AGENT);
    log = appendBorn(log, UI); // seq 30 先追加
    log = appendBorn(log, ARCH); // seq 20 后追加
    expect(ids(projectAt(log, 100))).toEqual(["agent-1", "arch", "ui"]);
  });

  it("同一个 seq 出生的两个点：按日志里的出现顺序", () => {
    /*
      一次规划同时吐出两个执行点是完全可能的。
      兜底用出现顺序，是为了让同一份日志永远投影出同一个顺序 ——
      否则卡片位置每次刷新都可能换边。
    */
    const base = (): PlanningEvent[] => {
      let log: PlanningEvent[] = [];
      log = appendBorn(log, AGENT);
      log = appendBorn(log, SPEC);
      return log;
    };
    const a = point("a", "spec", 3, "ready", 12);
    const b = point("b", "spec", 3, "ready", 12);
    expect(ids(projectAt(appendBorn(appendBorn(base(), a), b), 100))).toEqual([
      "agent-1",
      "spec",
      "a",
      "b",
    ]);
    expect(ids(projectAt(appendBorn(appendBorn(base(), b), a), 100))).toEqual([
      "agent-1",
      "spec",
      "b",
      "a",
    ]);
  });

  it("手工造的坏日志里有重复出生：投影里只出现一次", () => {
    /*
      appendBorn 不会让重复出生进日志，但日志可能是别处拼出来的。
      投影选择「认第一次出现的那一份」——和 appendBorn 的幂等保持一致：
      第一个 born 就是这个点的事实。
    */
    const log: PlanningEvent[] = [
      ...threeStagesLog(),
      { kind: "born", seq: 20, point: point("arch", "agent-1", 2, "failed", 20) },
    ];
    const now = projectAt(log, 100);
    expect(now.filter((p) => p.id === "arch")).toHaveLength(1);
    expect(find(now, "arch").status).toBe("pending");
  });
});

/* ── ⑤ maxSeq ── */

describe("maxSeq：日志里的「现在」", () => {
  it("空日志返回 0", () => {
    expect(maxSeq([])).toBe(0);
  });

  it("只有出生事件时，等于最后一个点的 bornAtSeq", () => {
    expect(maxSeq(threeStagesLog())).toBe(30);
  });

  it("混合事件时，等于所有事件 seq 的最大值", () => {
    const log = appendStatus(threeStagesLog(), "spec", "done", 45);
    expect(maxSeq(log)).toBe(45);
  });

  it("maxSeq(log) 就是「现在」：用它投影出来的是一棵完整的树", () => {
    /*
      这条把两个函数绑在一起：maxSeq 不是给排序用的，
      它的用途是「拿它当截止时刻」。
      如果哪天有人把 maxSeq 改成只统计 born 事件，这条会立刻发现。
    */
    const log = appendStatus(richLog(), "ui-1", "running", 33);
    const now = projectAt(log, maxSeq(log));
    expect(ids(now)).toEqual([
      "agent-1",
      "spec",
      "spec-1",
      "spec-2",
      "arch",
      "arch-1",
      "ui",
      "ui-1",
    ]);
    expect(find(now, "ui-1").status).toBe("running");
  });
});
