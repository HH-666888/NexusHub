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
 * 保护规划日志：到点语义、只增不改、状态投影、顺序与 maxSeq。
 * 到点语义排第一：投影多算未来的点不会崩，只会让画布先冒出没到点的卡片。
 */

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

/** 再往里长出第 3 层的执行点，它们才是干活的最小单元 */
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
    // 把 <= 写成 < 会让卡片晚一帧出现，流式渲染里看起来像卡了一下。
    expect(ids(projectAt(threeStagesLog(), 9))).toEqual(["agent-1"]);
    expect(ids(projectAt(threeStagesLog(), 10))).toEqual(["agent-1", "spec"]);
  });

  it("seq 0：什么都还没发生，树是空的", () => {
    // 空树是合法状态，不是异常。第 1 个事件（agent 出生在 seq 1）还没来
    expect(projectAt(threeStagesLog(), 0)).toEqual([]);
  });

  it("任何 seq 下都不含 bornAtSeq > seq 的点", () => {
    // 到点语义的机器化表述：遍历整条时间轴，任何投影里都不许出现还没出生的点。
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
    // 树完整性靠追加顺序（父节点总是先出生），这里在整条时间轴上验一遍。
    const log = richLog();
    for (let seq = 0; seq <= maxSeq(log) + 5; seq++) {
      expect(hasOrphans(projectAt(log, seq)), `seq=${seq} 时出现了孤儿`).toBe(false);
    }
  });

  it("未来的点不是“存在但隐藏”—— 它根本不在数组里", () => {
    // 断言的是数组本身：未来的点不在数组里，而不是存在但隐藏。
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

describe("只增不改：历史不许被改写", () => {
  it("appendBorn 遇到已存在的 id：整个日志逐项不变", () => {
    // 实现里很容易写成已存在就更新状态，那是改写历史；这里比对的是整个数组。
    const log = threeStagesLog();
    const before = structuredClone(log);
    const after = appendBorn(log, SPEC);
    expect(after).toEqual(before);
  });

  it("appendBorn 遇到已存在的 id 时，连新数组都不分配（同一个引用）", () => {
    // 没变化时返回同一个引用，否则每次重放都会触发一轮无谓的重渲染。
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
    // 老日志本身没有被就地改，不是因为共享引用才看起来没变
    expect(log).toHaveLength(4);
  });

  it("appendBorn 用 point.bornAtSeq 作为事件的 seq —— 一个事实只有一个来源", () => {
    // 用 point.bornAtSeq 而不是 maxSeq+1：一个事实只能有一个来源。
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
    // 在追加层查重要先扫一遍日志，把 O(1) 变成 O(n)；重复对投影无害。
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
    // 投影返回的是快照，否则调用方一改就等于绕过日志改了历史。
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
    // 点不会提前出现，状态也不会提前生效：回放第 12 步看不到第 13 步的 done。
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
    // 乱序追加时按日志顺序取最后一条，会让旧状态盖住新状态，所以取 seq 最大。
    let log = threeStagesLog();
    log = appendStatus(log, "spec", "done", 40);
    log = appendStatus(log, "spec", "running", 25);
    expect(find(projectAt(log, 100), "spec").status).toBe("done");
  });

  it("给还没出生的点写状态：不报错、不影响此刻的投影", () => {
    // 为暂时不在场的点写状态不算错误，在 appendStatus 里拦它反而要先扫日志。
    let log = threeStagesLog();
    log = appendStatus(log, "build", "running", 5);
    expect(ids(projectAt(log, 5))).toEqual(["agent-1"]);
  });

  it("那条早写的状态事件，等点真的出生后会立刻生效", () => {
    // 已写下的历史不会被投影扔掉；真要禁止出生前的状态，该拦的地方是 appendStatus。
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

describe("顺序：按出生先后，同一时刻按出现先后", () => {
  it("按出生的 seq 排序，而不是按日志里的追加顺序", () => {
    // 只要有地方按先拿到先追加写日志，追加顺序与出生顺序就分叉；排序依据必须是 seq。
    let log: PlanningEvent[] = [];
    log = appendBorn(log, AGENT);
    log = appendBorn(log, UI); // seq 30 先追加
    log = appendBorn(log, ARCH); // seq 20 后追加
    expect(ids(projectAt(log, 100))).toEqual(["agent-1", "arch", "ui"]);
  });

  it("同一个 seq 出生的两个点：按日志里的出现顺序", () => {
    // 同一 seq 出生的两个点按出现顺序排，同一份日志永远投影出同一个顺序。
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
    // 日志可能是别处拼出来的：投影认第一次出现的那一份，与 appendBorn 幂等一致。
    const log: PlanningEvent[] = [
      ...threeStagesLog(),
      { kind: "born", seq: 20, point: point("arch", "agent-1", 2, "failed", 20) },
    ];
    const now = projectAt(log, 100);
    expect(now.filter((p) => p.id === "arch")).toHaveLength(1);
    expect(find(now, "arch").status).toBe("pending");
  });
});

describe("maxSeq：日志里的“现在”", () => {
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

  it("maxSeq(log) 就是“现在”：用它投影出来的是一棵完整的树", () => {
    // maxSeq 的用途是拿它当截止时刻，不是排序；改成只统计 born 会让这条红。
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
