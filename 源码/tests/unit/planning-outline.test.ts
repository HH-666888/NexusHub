import { describe, expect, it } from "vitest";
import { summarizeChecks, type CheckResult } from "@/core/domain/check";
import { fallbackSpec, reviewSpec } from "@/core/domain/spec";
import { inspectArtifact } from "@/core/generate/prompt";
import { checksToChildren } from "@/core/pipeline/forest";
import { STAGES } from "@/core/pipeline/stages";
import { planningFromRun } from "@/core/planning/from-run";
import {
  appendBorn,
  maxSeq,
  projectAt,
  type PlanningEvent,
} from "@/core/planning/planning-log";
import { toOutline, type OutlineRow } from "@/core/planning/outline";
import {
  childrenOf,
  hasOrphans,
  type TaskPoint,
  type TaskPointStatus,
} from "@/core/planning/task-point";

/**
 * 保护清单视图：一级实体行、占位行规则、depth>=3 过滤、二级行汇总与叶子状态、canvasNodeId。
 * 输入一律来自 projectAt 的投影，不手搓与画布不一致的树。
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
// 父节点不在场的手工坏数据，用来验证清单的取舍。
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

describe("一级行：永远实体，永远在最上面", () => {
  it("哪怕下面还没有任何一个二级子节点，一级行也是实体行", () => {
    // 一级 Agent 是真实存在、正在规划的节点，做成占位行会让用户以为整件事还没开始。
    const rows = toOutline([AGENT]);
    expect(rows[0]).toMatchObject({
      id: "agent-1",
      level: 1,
      title: "任务点 agent-1",
      placeholder: false,
    });
  });

  it("一级行的状态用它自己的，不做汇总", () => {
    // 一级 Agent 有自己的状态，对它汇总空子树只会得到 pending。
    // 那会把正在规划的信息抹成还没动静。
    const rows = toOutline(projectAt(richLog(), 100)); // 子树里已经有 running 的执行点
    expect(findRow(rows, "agent-1").status).toBe(AGENT.status);
    expect(findRow(rows, "agent-1").status).toBe("planning");
  });

  it("空输入 → 空清单", () => {
    expect(toOutline([])).toEqual([]);
  });
});

describe("占位行：让用户看出“这里将来会有东西”", () => {
  it("一级下面还没有二级子节点时，必须补一行 placeholder", () => {
    const rows = toOutline([AGENT]);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual({
      id: "agent-1__pending",
      level: 2,
      title: "待规划",
      status: "pending",
      placeholder: true,
      // 占位行没有对应节点，界面据此不给它加链接。
      canvasNodeId: null,
    });
  });

  it("已经有二级子节点时，一行 placeholder 都不许出现", () => {
    // 该没有占位行时出现占位行更常见：判断条件若写成一级节点是否存在就会这样。
    // 用户会以为还有东西没规划，而清单其实已经满了。
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

  it("到点语义在清单上的样子：seq 5 是“一级 + 占位”，seq 15 变成“一级 + 规格化”", () => {
    // 画布与清单同步：卡片没冒出来时清单是虚线行，出生后替换成真行。
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

describe("depth >= 3 不进清单", () => {
  it("第 3 层的执行点不出现在清单里", () => {
    // 一个并行构建下面可能有几十个执行点，全塞进清单会让清单失去可读性
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
    // 全量扫描守的是清单只能画两级的整体性质，不是抽查两个 id。
    // 将来把执行点放进清单时，这条会当场变红。
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

describe("二级行：缩进、挂在自己的父节点下面、有下级才汇总", () => {
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
    // 六道工序自己没有状态，必须由执行点汇总，否则会出现工序已完成而底下还在跑。
    // 三种汇总各验一个：done + running 得 running、ready 得 ready、pending 得 pending。
    const rows = toOutline(projectAt(richLog(), 100));
    expect(findRow(rows, "spec").status).toBe("running");
    expect(findRow(rows, "arch").status).toBe("ready");
    expect(findRow(rows, "ui").status).toBe("pending");
  });

  it("还没动静的叶子二级点显示 pending —— 读的是它自己的状态，不再是汇总空子树", () => {
    // 这条读的是叶子自身的状态；期望值修复前后相同，变的只是理由。
    // 旧实现会把 done 的叶子也算成 pending，下一组用例专钉这一点。
    const points = projectAt(stageLog(), 100);
    for (const id of ["spec", "arch", "ui"]) {
      expect(childrenOf(points, id), `${id} 已经不是叶子了`).toEqual([]);
    }

    const rows = toOutline(points);
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

// 修 bug：叶子的状态用它自己的，不许被 rollUpStatus([]) 抹成 pending。
// 修之前，这一段的第一条和最后一条都会红。
// 一句话：清单不许把事情说反。
// 六道工序直接取 STAGES，不在此手抄。
const STAGE_INPUT = STAGES.map((s) => ({ id: s.id, name: s.name }));

/** 七项检查的真实名字：用 inspectArtifact 拿，任务点 id 才是真的那七个 */
const REAL_CHECK_NAMES = inspectArtifact("").map((r) => r.name);

// 兜底规格产物，验收条目 id 为 ac-N；SPEC 这名字已被上面的任务点占用。
const SPEC_ARTIFACT = fallbackSpec({
  prompt: "做一个任务看板",
  model: "fallback",
  generatedAt: 0,
});

/** 一条真实运行事件（kind 在外层，payload 结构由 kind 决定，见 run-event.ts） */
interface RawEvent {
  seq: number;
  kind: string;
  payload: unknown;
}

/** spec 事件：规格落地，验收条目在这一刻出生 */
function specEvent(seq: number): RawEvent {
  return {
    seq,
    kind: "spec",
    payload: {
      kind: "spec",
      spec: SPEC_ARTIFACT,
      gate: reviewSpec(SPEC_ARTIFACT),
      fallback: true,
    },
  };
}

/** check 事件：七项检查结果。failNames 里的那几项没过，其余全过 */
function checkEvent(seq: number, failNames: readonly string[] = []): RawEvent {
  const results: CheckResult[] = REAL_CHECK_NAMES.map((name) => ({
    name,
    pass: !failNames.includes(name),
    detail: failNames.includes(name) ? "没通过" : "通过了",
  }));
  return {
    seq,
    kind: "check",
    payload: { kind: "check", results, summary: summarizeChecks(results) },
  };
}

describe("修 bug：叶子二级行显示自己的状态", () => {
  it("叶子（没有下级）用自身状态：done / failed / running 各造一个", () => {
    // 这就是 bug 原样：三个点自身状态各不相同、都没有下级，旧实现一律汇总成 pending。
    const leafDone = point("leaf-done", "agent-1", 2, "done", 10);
    const leafFailed = point("leaf-failed", "agent-1", 2, "failed", 20);
    const leafRunning = point("leaf-running", "agent-1", 2, "running", 30);
    const points = [AGENT, leafDone, leafFailed, leafRunning];

    // 前提先钉住：它们真的是叶子。少了这一句，将来给谁添了子节点，
    // 这条测试会静静地变成在测另一件事。
    for (const leaf of [leafDone, leafFailed, leafRunning]) {
      expect(childrenOf(points, leaf.id), `${leaf.id} 不是叶子了`).toEqual([]);
    }

    const rows = toOutline(points);
    expect(findRow(rows, "leaf-done").status).toBe("done");
    expect(findRow(rows, "leaf-failed").status).toBe("failed");
    expect(findRow(rows, "leaf-running").status).toBe("running");
  });

  it("有下级的二级行仍然汇总：自己 pending，两个 done 的子节点让它显示 done", () => {
    // 证明汇总路径没被修坏：本点自身 pending，行上的 done 只能来自两个 done 的子节点。
    const rolled = point("rolled", "agent-1", 2, "pending", 10);
    const rolledChild1 = point("rolled-1", "rolled", 3, "done", 12);
    const rolledChild2 = point("rolled-2", "rolled", 3, "done", 14);
    const points = [AGENT, rolled, rolledChild1, rolledChild2];

    expect(rolled.status).toBe("pending"); // 自己确实不是 done
    expect(childrenOf(points, rolled.id)).toHaveLength(2); // 有下级，走汇总

    expect(findRow(toOutline(points), "rolled").status).toBe("done");
  });

  it("混合：同一份数据里叶子和有下级的各走各的路径", () => {
    // 一份数据同时含两种二级行，各自结果不同，不可能碰巧都对上。
    // leaf-a 自身 failed、leaf-b 自身 done、rolled 自身 pending 而子节点 done + running。
    const leafA = point("mix-leaf-a", "agent-1", 2, "failed", 10);
    const leafB = point("mix-leaf-b", "agent-1", 2, "done", 20);
    const rolled = point("mix-rolled", "agent-1", 2, "pending", 30);
    const rolledOk = point("mix-rolled-ok", "mix-rolled", 3, "done", 32);
    const rolledRunning = point("mix-rolled-running", "mix-rolled", 3, "running", 34);
    const points = [AGENT, leafA, leafB, rolled, rolledOk, rolledRunning];

    expect(childrenOf(points, leafA.id)).toEqual([]);
    expect(childrenOf(points, leafB.id)).toEqual([]);
    expect(childrenOf(points, rolled.id)).toHaveLength(2);

    const rows = toOutline(points);
    expect(findRow(rows, "mix-leaf-a").status).toBe("failed");
    expect(findRow(rows, "mix-leaf-b").status).toBe("done");
    expect(findRow(rows, "mix-rolled").status).toBe("running");
  });

  it("端到端：只有 spec + check 事件的日志，七个检查项在清单上不再是 pending", () => {
    // 端到端一次走通，中间不手搓任务点：planningFromRun → projectAt → toOutline。
    // check 里 pass:false 的那项出生即 failed；修复前七项会被一律显示成 pending。
    const failing = REAL_CHECK_NAMES[2];
    const log = planningFromRun({
      stages: STAGE_INPUT,
      events: [specEvent(10), checkEvent(20, [failing])],
    });
    const rows = toOutline(projectAt(log, maxSeq(log)));

    const checkRows = rows.filter((r) => r.id.startsWith("verify:"));
    expect(checkRows).toHaveLength(REAL_CHECK_NAMES.length);
    expect(checkRows).toHaveLength(7);
    for (const row of checkRows) expect(row.level).toBe(2); // 检查项是二级行

    // 核心断言：一个 pending 都不许有。
    const stillPending = checkRows
      .filter((r) => r.status === "pending")
      .map((r) => r.id);
    expect(
      stillPending,
      `这些检查项在清单上被显示成还没做：${stillPending.join(", ")}`,
    ).toEqual([]);

    // 每一项显示的必须是它自己的检查结果。
    for (const name of REAL_CHECK_NAMES) {
      expect(
        findRow(rows, `verify:${name}`).status,
        `${name} 在清单上的状态和它的检查结果对不上`,
      ).toBe(name === failing ? "failed" : "done");
    }
  });
});

describe("孤儿：承认的取舍", () => {
  it("父节点不在列表里的二级点进不了清单", () => {
    // 清单以一级行为骨架，接不上骨架的点没有位置可放。
    // 与其编一个假父节点，不如让它消失；hasOrphans 保证这不是静默丢失。
    const rows = toOutline([AGENT, ORPHAN]);
    expect(ids(rows)).toEqual(["agent-1", "agent-1__pending"]);
  });

  it("同一份数据上 hasOrphans 会把这件事喊出来 —— 所以它不是静默丢失", () => {
    // 让它消失只有在能被发现的前提下才是可接受的取舍。
    expect(hasOrphans([AGENT, ORPHAN])).toBe(true);
  });
});

describe("纯函数", () => {
  it("不修改输入", () => {
    const points = projectAt(richLog(), 100);
    const before = structuredClone(points);
    toOutline(points);
    expect(points).toEqual(before);
  });
});

// canvasNodeId 是清单行对应画布节点的 id，点击跳转靠它。
// 三件会安静错掉的事：实体行缺 id、占位行给了 id、两边 id 规则漂开。
// 第三种最坏：有反应，但跳到错的节点上。

describe("canvasNodeId：实体行给自己的 id，占位行给 null", () => {
  it("一级行 / 二级实体行的 canvasNodeId 就是它自己的 id", () => {
    const rows = toOutline(projectAt(richLog(), 100));
    for (const row of rows) {
      expect(row.canvasNodeId, `${row.id} 的 canvasNodeId 不对`).toBe(row.id);
    }
  });

  it("占位行的 canvasNodeId 必须是 null（它没有对应节点）", () => {
    const rows = toOutline([AGENT]);
    const placeholder = rows.find((r) => r.placeholder);
    expect(placeholder).toBeDefined();
    expect(placeholder?.canvasNodeId).toBeNull();
    // 特意不给父节点的 id：指向父节点时点下去有反应，说的却是另一件事。
    expect(placeholder?.canvasNodeId).not.toBe(AGENT.id);
  });

  it("全量扫描：canvasNodeId 为 null 的行，必须恰好是占位行", () => {
    // 逐行对账；将来多出没有节点的行时会当场变红，逼着明确决定它能不能点。
    const log = planningFromRun({
      stages: STAGE_INPUT,
      events: [specEvent(10), checkEvent(20)],
    });
    const rows = toOutline(projectAt(log, maxSeq(log)));
    expect(rows.length).toBeGreaterThan(10); // 前提：这份数据里既有实体行也有占位行

    for (const row of rows) {
      if (row.placeholder) {
        expect(row.canvasNodeId, `占位行 ${row.id} 居然有 canvasNodeId`).toBeNull();
      } else {
        expect(row.canvasNodeId, `实体行 ${row.id} 没有 canvasNodeId`).not.toBeNull();
        expect(row.canvasNodeId).toBe(row.id);
      }
    }
    // 两个方向都非空，否则上面那个循环可能一行都没验到
    expect(rows.filter((r) => r.placeholder).length).toBeGreaterThan(0);
    expect(rows.filter((r) => !r.placeholder).length).toBeGreaterThan(0);
  });

  it("与画布对账：七个检查项在清单里的 canvasNodeId，就是画布上那七个方块的 id", () => {
    // 清单与画布的 id 来自两条代码路径，这里逐字对账，防止只改一边。
    // 用法也是产品代码那一步：checksToChildren(check 事件的 results)。
    const results: CheckResult[] = REAL_CHECK_NAMES.map((name) => ({
      name,
      pass: true,
      detail: "通过了",
    }));
    const log = planningFromRun({
      stages: STAGE_INPUT,
      events: [
        {
          seq: 20,
          kind: "check",
          payload: { kind: "check", results, summary: summarizeChecks(results) },
        },
      ],
    });

    const canvasIds = checksToChildren(results).map((c) => c.id);
    const rowIds = toOutline(projectAt(log, maxSeq(log)))
      .filter((r) => r.id.startsWith("verify:"))
      .map((r) => r.canvasNodeId);

    expect(rowIds).toEqual(canvasIds);
    expect(canvasIds).toHaveLength(REAL_CHECK_NAMES.length);
  });
});
