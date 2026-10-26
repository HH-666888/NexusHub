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
 *   ③ ★ 叶子的状态用它自己的（本次修 bug 新增）——
 *      没有下级的二级行以前会被 rollUpStatus([]) 一律算成 pending，
 *      于是「做完了」在清单上显示成「还没做」：界面在说谎。
 *      最后一组用例（含一条端到端的）就是钉住这一条的。
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
      // ★ 占位行没有对应节点 —— 界面据此不给它加链接（见下面那一组用例）
      canvasNodeId: null,
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

  it("还没动静的叶子二级点显示 pending —— 读的是它自己的状态，不再是汇总空子树", () => {
    /*
      ⚠️ 这条的名字和注释是**跟着修 bug 一起改的**，不是悄悄改期望值：
      期望值 pending × 3 在修复前后完全相同（spec / arch / ui 三个叶子
      自己的状态本来就是 pending），但**理由变了** ——
      以前写的是「对空子树汇总得到 pending」，而那正是本次要修的 bug：
      同一段代码会把一个 done 的叶子也算成 pending。
      现在读的是叶子自身的状态；done / failed 的叶子由下一组用例专门钉住，
      这里先把它「真的是叶子」这个前提也验一遍。
    */
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

/* ============================================================
   ★ 修 bug：叶子的状态用它自己的，不许被 rollUpStatus([]) 抹成 pending
   ------------------------------------------------------------
   修之前，这一段里的第一条和最后一条都会红。
   它们要钉住的是一句话：**清单不许把事情说反**。
   一个已经 done 的叶子在清单上显示 pending，
   等于界面在说「这件事还没做」——而事实是做完了。
   ============================================================ */

/** 六道工序直接取产品里的 STAGES，不在这里手抄一份（理由同 planning-from-run.test.ts） */
const STAGE_INPUT = STAGES.map((s) => ({ id: s.id, name: s.name }));

/** 七项检查的真实名字：用 inspectArtifact 拿，任务点 id 才是真的那七个 */
const REAL_CHECK_NAMES = inspectArtifact("").map((r) => r.name);

/** 规格产物：用项目自己的兜底规格，验收条目 id 是 ac-1…（名字带 _ARTIFACT：SPEC 已被上面那个任务点占用） */
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

describe("★ 修 bug：叶子二级行显示自己的状态", () => {
  it("叶子（没有下级）用自身状态：done / failed / running 各造一个", () => {
    /*
      这就是本次 bug 的原样：三个任务点自己的状态各不相同，
      但它们都没有下级子节点。旧实现一律 rollUpStatus([]) → pending，
      于是清单上三行全是白的，和画布上「一项做完、一项失败、一项在跑」对不上。
    */
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
    /*
      证明汇总那条路径没被修坏：这个二级点自己没有状态可报（pending），
      清单行上的 done 只可能来自它下面两个 done 的子节点。
    */
    const rolled = point("rolled", "agent-1", 2, "pending", 10);
    const rolledChild1 = point("rolled-1", "rolled", 3, "done", 12);
    const rolledChild2 = point("rolled-2", "rolled", 3, "done", 14);
    const points = [AGENT, rolled, rolledChild1, rolledChild2];

    expect(rolled.status).toBe("pending"); // 自己确实不是 done
    expect(childrenOf(points, rolled.id)).toHaveLength(2); // 有下级，走汇总

    expect(findRow(toOutline(points), "rolled").status).toBe("done");
  });

  it("混合：同一份数据里叶子和有下级的各走各的路径", () => {
    /*
      一份数据同时包含两种二级行，三条清单行的结果各不相同，
      因此不可能「碰巧」都对上：
        leaf-a   叶子，自身 failed            → failed（汇总路径会给出 pending）
        leaf-b   叶子，自身 done              → done  （汇总路径会给出 pending）
        rolled   有下级，自身 pending，
                 子节点 done + running       → running（自身状态路径会给出 pending）
    */
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

  it("★ 端到端：只有 spec + check 事件的日志，七个检查项在清单上不再是 pending", () => {
    /*
      ★ 这是本次修复的最终验收证据 ★

      整条链路一次走通，中间不手搓任何一个任务点：
        planningFromRun（真实运行事件）→ projectAt（某一刻的树）→ toOutline（清单行）

      取材也全来自产品代码：六道工序取 STAGES，七项检查名取 inspectArtifact("")。
      check 事件里 pass:false 的那一项，出生时状态就是 failed
      （from-run.ts 的 checkPoints：出生即定生死），所以它在清单上必须是 failed ——
      修复之前，这七项会因为「都没有子节点」而被一律显示成 pending，
      也就是清单在说「一项检查都还没做」，而事件日志里七项结果早就躺在那儿了。
    */
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

    // 核心断言：一个 pending 都不许有
    const stillPending = checkRows
      .filter((r) => r.status === "pending")
      .map((r) => r.id);
    expect(
      stillPending,
      `这些检查项在清单上被显示成还没做：${stillPending.join(", ")}`,
    ).toEqual([]);

    // 而且每一项显示的必须是它自己的检查结果，不是别的什么
    for (const name of REAL_CHECK_NAMES) {
      expect(
        findRow(rows, `verify:${name}`).status,
        `${name} 在清单上的状态和它的检查结果对不上`,
      ).toBe(name === failing ? "failed" : "done");
    }
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

/* ============================================================
   ★ canvasNodeId：清单里的一行对应画布上的哪个节点（点击跳转的地基）
   ------------------------------------------------------------
   左侧清单这一期变成可点的：点一行 → 画布聚焦到那个任务点。
   跳转靠 URL（?focus=<id>），而那个 id 就是这个字段。

   这一组守的不是"有没有这个字段"，是**三件会安静地错掉的事**：
     ① 实体行给不出 id → 行不可点（功能整个没了，而画面看不出来）
     ② 占位行给了一个 id → 一行虚线被做得可点，点下去跳到父工序上，
        等于说"待规划的就是那道工序"（"点了没反应"和"点了骗人"两种坏）
     ③ 两边 id 规则漂开 → 清单点一下跳到别的节点上（最坏的一种：
        有反应、但是错的，而它看起来完全正常）
   ============================================================ */

describe("★ canvasNodeId：实体行给自己的 id，占位行给 null", () => {
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
    /*
      ⚠️ 特意**不给**它父节点的 id。
      顺手指到父节点是这一行最容易写出的样子：点下去也确实有反应
      （跳到那道工序上），于是没人会发现它在说另一件事 ——
      「待规划的就是这道工序」，而事实是「那道工序下面还没有东西」。
    */
    expect(placeholder?.canvasNodeId).not.toBe(AGENT.id);
  });

  it("全量扫描：canvasNodeId 为 null 的行，必须恰好是占位行", () => {
    /*
      这条守的是"两种坏"里更安静的那个方向：
      占位行拿到 id（假装可点）。逐行对账，而不是抽查一行 ——
      将来多出一种"没有节点的行"时，它会当场变红，逼着那次改动明确地
      决定"这种行能不能点"，而不是悄悄继承一个 id。
    */
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

  it("★ 与画布对账：七个检查项在清单里的 canvasNodeId，就是画布上那七个方块的 id", () => {
    /*
      ★ 这一条是"点击跳转"能成立的地基 ★

      清单和画布是同一棵树的两种视图 —— 两边的 id 必须逐字对得上。
      而它们**来自两条不同的代码路径**：
        · 清单：from-run.ts 的 checkPoints 造任务点 → toOutline 出行
        · 画布：forest.ts 的 checksToChildren 造子卡片 → 布局按 id 摆
      两边各自都写了一遍 `verify:${name}` 这个约定（from-run.ts 的注释里
      正是这么说的）。这个用例把那条约定**真的对一次账** ——
      哪天有人只改了一边，这里会红；不红的话，症状是
      "点了清单里的检查项，画布跳到别的地方或者没反应"，而那种错很难查。

      用法也是产品代码里真实的那一步：checksToChildren(check 事件的 results)。
    */
    const results: CheckResult[] = REAL_CHECK_NAMES.map((name) => ({
      name,
      pass: true,
      detail: "通过了",
    }));
    const log = planningFromRun({
      stages: STAGE_INPUT,
      events: [
        { seq: 20, kind: "check", payload: { kind: "check", results, summary: summarizeChecks(results) } },
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
