import { describe, expect, it } from "vitest";
import {
  appendBorn,
  projectAt,
  type PlanningEvent,
} from "@/core/planning/planning-log";
import { toOutline, type OutlineRow } from "@/core/planning/outline";
import {
  hasOrphans,
  type TaskPoint,
  type TaskPointStatus,
} from "@/core/planning/task-point";

/**
 * 左侧清单的单测
 * ============================================================
 * 清单是**树的另一种视图**，不是第二份数据（见 outline.ts 文件头）。
 * 所以这个文件里所有用例都遵守同一条规矩：
 * 输入一律来自 projectAt 的投影，绝不手搓一棵「和画布不一样」的树。
 *
 * 两组最要紧的：
 *   ① 占位行 —— 有二级子节点时一行都不许出现，没有时必须出现。
 *      这一行是「到点生成」在清单上的唯一表现：用户靠它知道
 *      「这儿将来会有东西，只是还没到点」。
 *   ② depth >= 3 不进清单 —— 执行点是画布上的卡片，不是清单里的行。
 *      漏了这条，一个「并行构建」就能往清单里灌几十行。
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
const OTHER = point("agent-2", null, 1, "pending", 50);
/** 父节点不在场 —— 手工造的坏数据，用来验证清单的取舍 */
const ORPHAN = point("orphan", "ghost", 2, "done", 5);

/** 一级 + 三个二级，二级分别在第 10 / 20 / 30 个 seq 诞生 */
function stageLog(): PlanningEvent[] {
  let log: PlanningEvent[] = [];
  log = appendBorn(log, AGENT);
  log = appendBorn(log, SPEC);
  log = appendBorn(log, ARCH);
  log = appendBorn(log, UI);
  return log;
}

/** 再往里长出第 3 层的执行点 */
function richLog(): PlanningEvent[] {
  let log = stageLog();
  log = appendBorn(log, point("spec-1", "spec", 3, "done", 12));
  log = appendBorn(log, point("spec-2", "spec", 3, "running", 14));
  log = appendBorn(log, point("arch-1", "arch", 3, "ready", 22));
  log = appendBorn(log, point("ui-1", "ui", 3, "pending", 32));
  return log;
}

const ids = (rows: readonly OutlineRow[]): string[] => rows.map((r) => r.id);

function findRow(rows: readonly OutlineRow[], id: string): OutlineRow {
  const hit = rows.find((r) => r.id === id);
  if (!hit)
    throw new Error(`清单里没有 ${id}（现有：${ids(rows).join(", ") || "空"}）`);
  return hit;
}

/* ── 一级行 ── */

describe("一级行：永远实体，永远在最上面", () => {
  it("哪怕下面还没有任何一个二级子节点，一级行也是实体行", () => {
    /*
      「永远实体」是要紧的：一级 Agent 是真实存在、正在规划的那个节点。
      把它也做成占位行，用户会以为整件事还没开始 ——
      而实际上它可能正在规划。
    */
    const rows = toOutline([AGENT]);
    expect(rows[0]).toMatchObject({
      id: "agent-1",
      level: 1,
      title: "任务点 agent-1",
      placeholder: false,
    });
  });

  it("一级行的状态用它自己的，不做汇总", () => {
    /*
      一级 Agent 是真的在执行「规划」这件事的节点，它有自己的状态。
      汇总会把「正在规划」变成「还没动静」—— 因为它的子节点都没跑，
      汇总结果必然是 pending。那正好把最该被看见的信息抹掉了。
    */
    const rows = toOutline(projectAt(richLog(), 100)); // 子树里已经有 running 的执行点
    expect(findRow(rows, "agent-1").status).toBe(AGENT.status);
    expect(findRow(rows, "agent-1").status).toBe("planning");
  });

  it("空输入 → 空清单", () => {
    expect(toOutline([])).toEqual([]);
  });
});

/* ── 占位行 ── */

describe("占位行：让用户看出「这里将来会有东西」", () => {
  it("一级下面还没有二级子节点时，必须补一行 placeholder", () => {
    const rows = toOutline([AGENT]);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual({
      id: "agent-1__pending",
      level: 2,
      title: "待规划",
      status: "pending",
      placeholder: true,
    });
  });

  it("已经有二级子节点时，一行 placeholder 都不许出现", () => {
    /*
      反过来错（该没有的时候出现了）比上一条更常见：
      判断条件写成「一级节点是否存在」而不是「它有没有二级子节点」，
      就会在每棵子树下面都挂一行「待规划」——
      用户会以为还有东西没规划，而实际上清单已经满了。
    */
    const rows = toOutline(projectAt(stageLog(), 100));
    expect(rows.some((r) => r.placeholder)).toBe(false);
    expect(ids(rows)).toEqual(["agent-1", "spec", "arch", "ui"]);
  });

  it("占位行的 id 用父节点 id 加后缀 —— 界面据此认出它不是真任务点", () => {
    // 用一眼能认出的后缀，而不是序号：界面可以靠它判断这行不可点、不参与选中
    const rows = toOutline([AGENT]);
    expect(rows[1].id).toBe(`${AGENT.id}__pending`);
    expect(rows[1].id).not.toBe(AGENT.id);
  });

  it("到点语义在清单上的样子：seq 5 是「一级 + 占位」，seq 15 变成「一级 + 规格化」", () => {
    /*
      这条把「到点生成」在两个视图上对齐：
      画布上第 1 道工序的卡片还没冒出来时，清单里那个位置是一行虚线；
      它一出生，虚线行就被真行替换掉。两者是同一件事的两种画法。
    */
    const log = stageLog();
    expect(ids(toOutline(projectAt(log, 5)))).toEqual(["agent-1", "agent-1__pending"]);
    expect(toOutline(projectAt(log, 5))[1].placeholder).toBe(true);

    expect(ids(toOutline(projectAt(log, 15)))).toEqual(["agent-1", "spec"]);
    expect(toOutline(projectAt(log, 15))[1].placeholder).toBe(false);
  });

  it("多个一级节点时各自独立判断要不要占位", () => {
    const rows = toOutline([AGENT, SPEC, OTHER]);
    expect(rows.map((r) => [r.id, r.placeholder])).toEqual([
      ["agent-1", false],
      ["spec", false],
      ["agent-2", false],
      ["agent-2__pending", true],
    ]);
  });
});

/* ── 层深过滤 ── */

describe("depth >= 3 不进清单", () => {
  it("第 3 层的执行点不出现在清单里", () => {
    // 一个「并行构建」下面可能有几十个执行点，全塞进清单会让清单失去可读性
    const rows = toOutline(projectAt(richLog(), 100));
    expect(rows.some((r) => r.id === "spec-1" || r.id === "spec-2")).toBe(false);
  });

  it("第 4 层也不出现（过滤不能只挡一层）", () => {
    const points = [
      AGENT,
      SPEC,
      point("spec-1", "spec", 3, "done", 12),
      point("deep", "spec-1", 4, "done", 15),
    ];
    expect(ids(toOutline(points))).toEqual(["agent-1", "spec"]);
  });

  it("清单里的每一行，要么是在场的第 1/2 层点，要么是占位行", () => {
    /*
      全量扫描，而不是抽查两个 id：
      这条守的是「清单只能画两级」这个整体性质。
      将来如果有人把执行点也放进来（比如为了做「展开执行点」），它会当场变红，
      逼着那次改动明确地改这条断言，而不是悄悄改掉。
    */
    const points = projectAt(richLog(), 100);
    const depthById = new Map(points.map((p) => [p.id, p.depth]));
    for (const row of toOutline(points)) {
      if (row.placeholder) {
        expect(row.id.endsWith("__pending")).toBe(true);
        continue;
      }
      const depth = depthById.get(row.id);
      expect(depth, `清单里出现了不在树里的行：${row.id}`).toBeDefined();
      expect(depth, `第 ${depth} 层的点混进了清单：${row.id}`).toBeLessThanOrEqual(2);
      expect(row.level).toBe(depth);
    }
  });

  it("二级行的数量恰好等于在场的二级点数", () => {
    const points = projectAt(richLog(), 100);
    const stageCount = points.filter((p) => p.depth === 2).length;
    const rows = toOutline(points);
    expect(rows.filter((r) => r.level === 2 && !r.placeholder)).toHaveLength(
      stageCount,
    );
  });
});

/* ── 二级行 ── */

describe("二级行：缩进、挂在自己的父节点下面、状态靠汇总", () => {
  it("二级行挂在其一级父节点之后，保持出生顺序", () => {
    const rows = toOutline(projectAt(stageLog(), 100));
    expect(rows.map((r) => [r.id, r.level])).toEqual([
      ["agent-1", 1],
      ["spec", 2],
      ["arch", 2],
      ["ui", 2],
    ]);
  });

  it("多棵一级子树时，各自的二级行紧随其父节点，不混在一起", () => {
    const otherStage = point("other-stage", "agent-2", 2, "pending", 60);
    const rows = toOutline([AGENT, SPEC, OTHER, otherStage]);
    expect(ids(rows)).toEqual(["agent-1", "spec", "agent-2", "other-stage"]);
  });

  it("二级行的状态 = 它下面执行点的汇总", () => {
    /*
      六道工序自己不产出任何东西，状态必须由执行点决定，
      否则会出现「工序写着已完成，底下的执行点还在跑」这种自相矛盾的画面。
      这里三种汇总结果各验一个：
        spec = done + running → running
        arch = ready         → ready
        ui   = pending       → pending
    */
    const rows = toOutline(projectAt(richLog(), 100));
    expect(findRow(rows, "spec").status).toBe("running");
    expect(findRow(rows, "arch").status).toBe("ready");
    expect(findRow(rows, "ui").status).toBe("pending");
  });

  it("二级点还没有执行子节点时汇总为 pending —— 和「还没到点」是同一句话", () => {
    const rows = toOutline(projectAt(stageLog(), 100));
    expect(rows.filter((r) => r.level === 2).map((r) => r.status)).toEqual([
      "pending",
      "pending",
      "pending",
    ]);
  });

  it("二级行是缩进层级（level === 2）", () => {
    const rows = toOutline(projectAt(stageLog(), 100));
    expect(findRow(rows, "arch").level).toBe(2);
  });
});

/* ── 孤儿 ── */

describe("孤儿：承认的取舍", () => {
  it("父节点不在列表里的二级点进不了清单", () => {
    /*
      清单以一级行为骨架，一个接不上骨架的点没有位置可放。
      与其给它编一个假父节点（那会让画布和清单分叉），不如让它消失。
      这条测试是把这个取舍写下来，不是宣称这样最好。
    */
    const rows = toOutline([AGENT, ORPHAN]);
    expect(ids(rows)).toEqual(["agent-1", "agent-1__pending"]);
  });

  it("同一份数据上 hasOrphans 会把这件事喊出来 —— 所以它不是静默丢失", () => {
    // 「让它消失」只有在能被发现的前提下才是可接受的取舍
    expect(hasOrphans([AGENT, ORPHAN])).toBe(true);
  });
});

/* ── 纯函数 ── */

describe("纯函数", () => {
  it("不修改输入", () => {
    const points = projectAt(richLog(), 100);
    const before = structuredClone(points);
    toOutline(points);
    expect(points).toEqual(before);
  });
});
