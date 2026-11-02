import { describe, expect, it } from "vitest";
import { summarizeChecks, type CheckResult } from "@/core/domain/check";
import { fallbackSpec, reviewSpec } from "@/core/domain/spec";
import type { ArchSpec } from "@/core/domain/arch";
import type { UiSpec } from "@/core/domain/ui-spec";
import { inspectArch } from "@/core/generate/arch-check";
import { inspectUi } from "@/core/generate/ui-check";
import { inspectArtifact } from "@/core/generate/prompt";
import {
  ZERO_USAGE,
  summarizeBatch,
  type BuildBatch,
  type ModuleBuild,
} from "@/core/domain/module-build";
import { STAGES } from "@/core/pipeline/stages";
import {
  PLANNING_ROOT_ID,
  planningFromRun,
  type PlanningSource,
} from "@/core/planning/from-run";
import { toOutline } from "@/core/planning/outline";
import { maxSeq, projectAt, type PlanningEvent } from "@/core/planning/planning-log";
import { childrenOf, hasOrphans, type TaskPoint } from "@/core/planning/task-point";

/**
 * 保护 from-run 投影：骨架、诚实底线、到点生成、检查项派生、子树生成、失败传播。
 * 工序名、检查项名、规格条目与模块/页面划分都从产品代码取，不在此手抄。
 */

// 工序名单与顺序都取自 STAGES，不另排。
const STAGE_INPUT = STAGES.map((s) => ({ id: s.id, name: s.name }));

// 未接入的工序由 STAGES.implementation 现算，不写死名单。
const PLANNED_IDS = STAGES.filter((s) => s.implementation === "planned").map(
  (s) => s.id,
);

// 七项检查名取自 inspectArtifact；任务点 id 沿用 forest.ts 的 verify:<name> 约定。
const REAL_CHECK_NAMES = inspectArtifact("").map((r) => r.name);

// 规格产物用 fallbackSpec 现造，条目 id 为 ac-N。
const SPEC = fallbackSpec({
  prompt: "做一个任务看板",
  model: "fallback",
  generatedAt: 0,
});

// 运行事件的 kind 在外层，payload 结构随 kind 变化。
interface RawEvent {
  seq: number;
  kind: string;
  payload: unknown;
}

function src(
  events: readonly RawEvent[],
  runStatus?: PlanningSource["runStatus"],
): PlanningSource {
  return { stages: STAGE_INPUT, events, runStatus };
}

// phase 取值为 GeneratePhase 的枚举值。
function phaseEvent(seq: number, phase: string, label = "进行中"): RawEvent {
  return { seq, kind: "phase", payload: { kind: "phase", phase, label } };
}

function specEvent(seq: number): RawEvent {
  return {
    seq,
    kind: "spec",
    payload: { kind: "spec", spec: SPEC, gate: reviewSpec(SPEC), fallback: true },
  };
}

// check 事件默认全过，可传断言指定未过的项。
function checkEvent(
  seq: number,
  pass: (name: string) => boolean = () => true,
): RawEvent {
  const results: CheckResult[] = REAL_CHECK_NAMES.map((name) => ({
    name,
    pass: pass(name),
    detail: pass(name) ? "通过了" : "没通过",
  }));
  return {
    seq,
    kind: "check",
    payload: { kind: "check", results, summary: summarizeChecks(results) },
  };
}

function bornPoints(log: readonly PlanningEvent[]): TaskPoint[] {
  return log.flatMap((e) => (e.kind === "born" ? [e.point] : []));
}

const ids = (points: readonly TaskPoint[]): string[] => points.map((p) => p.id);

function find(points: readonly TaskPoint[], id: string): TaskPoint {
  const hit = points.find((p) => p.id === id);
  if (!hit) {
    throw new Error(`投影里没有 ${id}（现有：${ids(points).join(", ") || "空"}）`);
  }
  return hit;
}

// 此刻的全部检查项任务点。
function checkPointsAt(log: readonly PlanningEvent[], seq: number): TaskPoint[] {
  return projectAt(log, seq).filter((p) => p.id.startsWith("verify:"));
}

// 某 id 的状态事件，用来证明我们没碰过它。
function statusEventsFor(log: readonly PlanningEvent[], id: string): PlanningEvent[] {
  return log.filter((e) => e.kind === "status" && e.id === id);
}

describe("骨架：一级 Agent 与六道工序一次全生成", () => {
  it("空事件数组 → 恰好 7 个出生事件（1 根 + 6 工序），全部在第 0 刻出生", () => {
    // 六道工序是计划的一部分，一开始就全在；执行点才到点生成。
    const log = planningFromRun(src([]));

    const borns = bornPoints(log);
    expect(borns).toHaveLength(1 + STAGE_INPUT.length);
    expect(borns).toHaveLength(7);

    for (const point of borns) {
      expect(point.bornAtSeq, `${point.id} 不是在第 0 刻出生的`).toBe(0);
    }
  });

  it("第 0 刻就能投影出整棵树，且一个孤儿都没有", () => {
    // 孤儿不抛错只错位，所以第 0 刻就必须是完整的树。
    const log = planningFromRun(src([]));
    const atZero = projectAt(log, 0);

    expect(ids(atZero)).toEqual([PLANNING_ROOT_ID, ...STAGE_INPUT.map((s) => s.id)]);
    expect(hasOrphans(atZero)).toBe(false);
  });

  it("根节点是 depth 0 的控制层，六道工序是挂在它下面的 depth 1", () => {
    const atZero = projectAt(planningFromRun(src([])), 0);

    const root = find(atZero, PLANNING_ROOT_ID);
    expect(root).toMatchObject({
      parentId: null,
      depth: 0,
      kind: "control",
      title: "一级 Agent",
      bornAtSeq: 0,
    });

    for (const stage of STAGE_INPUT) {
      const point = find(atZero, stage.id);
      expect(point).toMatchObject({
        parentId: PLANNING_ROOT_ID,
        depth: 1,
        kind: "control",
        title: stage.name,
        bornAtSeq: 0,
      });
    }
  });

  it("什么事件都没有时，六道工序全停在 pending —— 一道都不许有进展", () => {
    const atZero = projectAt(planningFromRun(src([])), 0);

    for (const stage of STAGE_INPUT) {
      expect(find(atZero, stage.id).status, `${stage.name} 没有事件却有进展`).toBe(
        "pending",
      );
    }
  });

  it("根节点的状态就是这次运行的状态（它不替任何工序表态）", () => {
    // 根节点状态等于运行状态；六道工序的状态另算。
    const cases: Array<[PlanningSource["runStatus"], string]> = [
      [undefined, "running"],
      ["running", "running"],
      ["done", "done"],
      ["failed", "failed"],
    ];
    for (const [runStatus, expected] of cases) {
      const log = planningFromRun(src([], runStatus));
      expect(
        find(projectAt(log, maxSeq(log)), PLANNING_ROOT_ID).status,
        `runStatus=${String(runStatus)} 时根节点状态不对`,
      ).toBe(expected);
    }
  });
});

describe("诚实底线：没有真实事件的工序必须停在 pending", () => {
  it("只有 spec 和 check 事件时，还没接入的工序仍是 pending，且一个子节点都没有", () => {
    // 没有真实事件的工序必须停在 pending，且名下没有执行点。
    // 状态可能被误算改掉，没有子点才是没接入的硬证据。
    const log = planningFromRun(src([specEvent(10), checkEvent(20)]));
    const now = projectAt(log, maxSeq(log));

    // 前提：这份夹具确实让别的工序动起来了。
    expect(find(now, "spec").status).not.toBe("pending");
    expect(find(now, "verify").status).not.toBe("pending");
    expect(checkPointsAt(log, maxSeq(log))).toHaveLength(7);

    for (const id of PLANNED_IDS) {
      expect(find(now, id).status, `${id} 被凭空标出了进展`).toBe("pending");
      expect(childrenOf(now, id), `${id} 名下不该有任何执行点`).toHaveLength(0);
      expect(statusEventsFor(log, id), `${id} 被写过状态事件`).toHaveLength(0);
    }

    // 未接入名单按 implementation 动态取，接上一道就自动移出。
    expect(PLANNED_IDS).toEqual(["assemble"]);
  });

  it("runStatus 为 done 时，还没接入的工序仍然 pending —— 有产出的才配 done", () => {
    // run 成功不代表每道工序都跑过，工序状态只看自己的事件。
    const log = planningFromRun(src([specEvent(10), checkEvent(20)], "done"));
    const now = projectAt(log, maxSeq(log));

    // 有真实产出的两道是 done。
    expect(find(now, "spec").status).toBe("done");
    expect(find(now, "verify").status).toBe("done");

    for (const id of PLANNED_IDS) {
      expect(find(now, id).status, `${id} 因为 run 成功被标成了 done`).toBe("pending");
      expect(childrenOf(now, id)).toHaveLength(0);
    }

    // 规则看证据不看位置：没有事件的工序一律 pending。
    expect(find(now, "build").status).toBe("pending");
  });

  it("runStatus 为 failed 时，还没接入的工序仍然是 pending（失败也不许波及无关工序）", () => {
    const log = planningFromRun(
      src(
        [
          phaseEvent(10, "spec"),
          phaseEvent(20, "generating"),
          phaseEvent(30, "failed"),
        ],
        "failed",
      ),
    );
    const now = projectAt(log, maxSeq(log));

    for (const id of PLANNED_IDS) {
      expect(find(now, id).status, `${id} 被失败波及了`).toBe("pending");
    }
  });
});

describe("到点生成：第 N 步的树里没有第 N+1 步才出生的东西", () => {
  it("check 在 seq 30：第 20 刻一个检查项都没有，第 30 刻七项全在", () => {
    const log = planningFromRun(src([specEvent(10), checkEvent(30)]));

    expect(ids(checkPointsAt(log, 20))).toEqual([]);
    expect(checkPointsAt(log, 29)).toHaveLength(0);

    const atThirty = checkPointsAt(log, 30);
    expect(atThirty).toHaveLength(REAL_CHECK_NAMES.length);
    expect(atThirty).toHaveLength(7);
    expect(atThirty.map((p) => p.bornAtSeq)).toEqual(new Array(7).fill(30));
  });

  it("检查项的出生时刻就是那条 check 事件的 seq —— 一个事实只有一个来源", () => {
    // 出生序号用事件自己的 seq，不用 maxSeq+1：乱序追加会早于出生时刻。
    const log = planningFromRun(src([checkEvent(77)]));
    for (const point of checkPointsAt(log, 100)) {
      expect(point.bornAtSeq).toBe(77);
    }
    expect(checkPointsAt(log, 76)).toHaveLength(0);
  });

  it("规格条目同样到点生成：spec 在 seq 10，第 9 刻它们还不存在", () => {
    const log = planningFromRun(src([specEvent(10)]));

    expect(ids(projectAt(log, 9)).filter((id) => id.startsWith("spec:"))).toEqual([]);
    const specKids = childrenOf(projectAt(log, 10), "spec");
    expect(specKids).toHaveLength(SPEC.acceptance.length);
    for (const kid of specKids) expect(kid.bornAtSeq).toBe(10);
  });

  it("整条时间轴上：没有任何点早于自己的 bornAtSeq 出现，也不出现孤儿", () => {
    // 整条时间轴上验到点与树完整，不逐个 seq 写死。
    const log = planningFromRun(
      src([
        phaseEvent(5, "spec"),
        specEvent(10),
        phaseEvent(20, "generating"),
        phaseEvent(30, "checking"),
        checkEvent(31),
        phaseEvent(40, "saving"),
        phaseEvent(50, "done"),
      ]),
    );

    for (let seq = 0; seq <= maxSeq(log) + 5; seq++) {
      const now = projectAt(log, seq);
      for (const point of now) {
        expect(
          point.bornAtSeq,
          `seq=${seq} 时投影出了 ${point.id}（它的 bornAtSeq=${point.bornAtSeq}）`,
        ).toBeLessThanOrEqual(seq);
      }
      expect(hasOrphans(now), `seq=${seq} 时出现了孤儿`).toBe(false);
    }
  });
});

describe("七项检查 → 七个执行任务点", () => {
  it("七个点，parentId 都是 verify，depth 2、kind exec，标题就是检查项名字", () => {
    const log = planningFromRun(src([checkEvent(30)]));
    const now = projectAt(log, 30);
    const kids = checkPointsAt(log, 30);

    expect(kids).toHaveLength(7);
    for (const kid of kids) {
      expect(kid.parentId).toBe("verify");
      expect(kid.depth).toBe(2);
      expect(kid.kind).toBe("exec");
      expect(REAL_CHECK_NAMES).toContain(kid.title);
    }
    // id 沿用 forest.ts 的约定：verify:<检查项名>。
    expect(ids(kids).sort()).toEqual(REAL_CHECK_NAMES.map((n) => `verify:${n}`).sort());
    expect(hasOrphans(now)).toBe(false);
  });

  it("没过的那项是 failed，其余六项是 done —— 状态在出生那一刻就定了", () => {
    // 检查项状态出生时就定了，没有先出生再跑完的过程。
    const failing = REAL_CHECK_NAMES[3];
    const log = planningFromRun(src([checkEvent(30, (name) => name !== failing)]));
    const kids = checkPointsAt(log, 30);

    expect(kids).toHaveLength(7);
    expect(find(kids, `verify:${failing}`).status).toBe("failed");
    for (const kid of kids) {
      if (kid.title === failing) continue;
      expect(kid.status, `${kid.title} 应该是 done`).toBe("done");
    }
  });

  it("多项没过时，每一项各自是 failed（不会因为有一项过了就整体变绿）", () => {
    const bad = [REAL_CHECK_NAMES[1], REAL_CHECK_NAMES[5]];
    const log = planningFromRun(src([checkEvent(30, (name) => !bad.includes(name))]));
    const kids = checkPointsAt(log, 30);

    const failed = kids.filter((k) => k.status === "failed").map((k) => k.title);
    expect(failed.sort()).toEqual([...bad].sort());
  });

  it("两次 check 事件：同名的检查项只出现一次（appendBorn 幂等）", () => {
    // 同名检查项 id 相同，appendBorn 幂等，只出生一次。
    const log = planningFromRun(src([checkEvent(30), checkEvent(45)]));
    const kids = checkPointsAt(log, 100);

    expect(kids).toHaveLength(7);
    expect(kids.map((k) => k.bornAtSeq)).toEqual(new Array(7).fill(30));
  });

  it("payload 残缺时不硬造任务点：没有 results 就一个点都不生成", () => {
    // payload 残缺时明确不生成点，不做尽力而为的猜测。
    const cases: unknown[] = [null, {}, { results: null }, { results: "七项" }, 42];

    for (const payload of cases) {
      const log = planningFromRun(src([{ seq: 30, kind: "check", payload }]));
      expect(
        checkPointsAt(log, 100),
        `payload=${JSON.stringify(payload)} 时凭空造了点`,
      ).toEqual([]);
    }
  });
});

describe("产物是结果，不是任务点", () => {
  it("artifact 事件不生成任何任务点，但会让所属工序继续动", () => {
    // 产物没有过程，不建任务点；它只说明所属工序在动。
    const artifact = {
      id: "a1",
      runId: "r1",
      kind: "html",
      path: "r1/index.html",
      bytes: 1024,
      at: 0,
    };
    const log = planningFromRun(
      src([
        phaseEvent(10, "generating"),
        { seq: 20, kind: "artifact", payload: { kind: "artifact", artifact } },
      ]),
    );

    const now = projectAt(log, maxSeq(log));
    expect(now.some((p) => p.id.includes("artifact"))).toBe(false);
    expect(now).toHaveLength(7); // 根 + 六道工序，一个执行点都没有
    expect(find(now, "build").status).toBe("running");
  });

  it("text / reasoning / usage 这些流式事件一律不进计划", () => {
    // 流式事件是过程记录，不进规划日志。
    const log = planningFromRun(
      src([
        { seq: 1, kind: "reasoning", payload: { kind: "reasoning", delta: "嗯……" } },
        { seq: 2, kind: "text", payload: { kind: "text", delta: "<html>" } },
        { seq: 3, kind: "usage", payload: { kind: "usage", costCny: 0.01 } },
      ]),
    );

    expect(bornPoints(log)).toHaveLength(7);
    // 除了根节点那一条终局状态，不该有别的状态事件
    expect(log.filter((e) => e.kind === "status")).toHaveLength(1);
  });
});

describe("串起现成函数：projectAt → toOutline", () => {
  it("六道工序是 level 1，检查项是 level 2，还没接入的工序出现 placeholder 的待规划行", () => {
    // 画布与清单是同一棵树的两种视图，从事件一路走到清单行，不手造任务点。
    const log = planningFromRun(src([specEvent(10), checkEvent(20)]));
    const rows = toOutline(projectAt(log, maxSeq(log)));

    // 六道工序是一级行，顺序同 STAGES。
    const level1 = rows.filter((r) => r.level === 1);
    expect(level1.map((r) => r.id)).toEqual(STAGE_INPUT.map((s) => s.id));
    expect(level1.map((r) => r.title)).toEqual(STAGE_INPUT.map((s) => s.name));
    for (const row of level1) expect(row.placeholder).toBe(false);

    const checkRows = rows.filter((r) => r.id.startsWith("verify:"));
    expect(checkRows).toHaveLength(7);
    for (const row of checkRows) expect(row.level).toBe(2);

    const specRows = rows.filter((r) => r.id.startsWith("spec:"));
    expect(specRows).toHaveLength(SPEC.acceptance.length);
    for (const row of specRows) expect(row.level).toBe(2);

    // 有真实产出的两道不出现占位行。
    for (const id of ["spec", "verify"]) {
      expect(rows.filter((r) => r.placeholder && r.id.startsWith(id))).toEqual([]);
    }

    // 未接入的工序只有浅色虚线的待规划占位行。
    for (const id of PLANNED_IDS) {
      const placeholders = rows.filter((r) => r.placeholder && r.id.startsWith(id));
      expect(placeholders, `${id} 没有待规划占位行`).toHaveLength(1);
      expect(placeholders[0].level).toBe(2);
      expect(placeholders[0].title).toBe("待规划");
    }
  });

  it("一级行的状态就是工序自己的状态 —— 还没接入的工序在清单上如实显示 pending", () => {
    const log = planningFromRun(src([specEvent(10), checkEvent(20)], "done"));
    const rows = toOutline(projectAt(log, maxSeq(log)));

    const rowOf = (id: string) => rows.find((r) => r.id === id && r.level === 1);
    expect(rowOf("spec")?.status).toBe("done");
    expect(rowOf("verify")?.status).toBe("done");
    for (const id of PLANNED_IDS) {
      expect(rowOf(id)?.status, `${id} 在清单上被标出了进展`).toBe("pending");
    }
  });
});

describe("工序状态：按 phase 归属，失败要浮上来", () => {
  it("有 phase 的工序是 running（run 还在跑）", () => {
    const log = planningFromRun(
      src([
        phaseEvent(5, "spec"),
        phaseEvent(20, "generating"),
        phaseEvent(30, "checking"),
      ]),
    );
    const now = projectAt(log, maxSeq(log));

    expect(find(now, "spec").status).toBe("running");
    expect(find(now, "build").status).toBe("running");
    expect(find(now, "verify").status).toBe("running");
    for (const id of PLANNED_IDS) expect(find(now, id).status).toBe("pending");
  });

  it("phase 为 failed 时，失败落在**当前工序**上（这里是 build）", () => {
    // failed 是运行终局标记，落在刚才在跑的那道工序上。
    const log = planningFromRun(
      src([
        phaseEvent(5, "spec"),
        phaseEvent(20, "generating"),
        phaseEvent(30, "failed"),
      ]),
    );
    const now = projectAt(log, maxSeq(log));

    expect(find(now, "build").status).toBe("failed");
    expect(find(now, "spec").status).toBe("done");
    for (const id of PLANNED_IDS) expect(find(now, id).status).toBe("pending");
  });

  it("失败落在当前工序：紧跟 spec 的 failed 算在 spec 头上", () => {
    const log = planningFromRun(src([phaseEvent(5, "spec"), phaseEvent(9, "failed")]));
    const now = projectAt(log, maxSeq(log));

    expect(find(now, "spec").status).toBe("failed");
    expect(find(now, "build").status).toBe("pending");
  });

  it("phase 为 done 时，动过的工序收成 done（运行结束不再停在 running）", () => {
    // 历史事件可能停在终局那一条，投影要自己认出运行已结束。
    const log = planningFromRun(
      src([
        phaseEvent(5, "spec"),
        phaseEvent(20, "generating"),
        phaseEvent(50, "done"),
      ]),
    );
    const now = projectAt(log, maxSeq(log));

    expect(find(now, "spec").status).toBe("done");
    expect(find(now, "build").status).toBe("done");
    for (const id of PLANNED_IDS) expect(find(now, id).status).toBe("pending");
  });

  it("runStatus 为 failed 时，当前工序置 failed", () => {
    const log = planningFromRun(
      src([phaseEvent(5, "spec"), phaseEvent(20, "checking")], "failed"),
    );
    const now = projectAt(log, maxSeq(log));

    expect(find(now, "verify").status).toBe("failed");
  });

  it("降级路径上的 error 不把工序留成失败：之后又交了产物，就说明它没停在失败上", () => {
    // 库里 error 多用于可降级场景，见到 error 就判失败会把降级后跑通显示成失败。
    const log = planningFromRun(
      src([
        phaseEvent(5, "spec"),
        {
          seq: 8,
          kind: "error",
          payload: { kind: "error", message: "模型给出的规格没法解析" },
        },
        specEvent(10),
        phaseEvent(50, "done"),
      ]),
    );
    const now = projectAt(log, maxSeq(log));

    expect(find(now, "spec").status).toBe("done");
    expect(childrenOf(now, "spec")).toHaveLength(SPEC.acceptance.length);
  });

  it("error 之后再没有恢复的痕迹时，失败留在那道工序上", () => {
    const log = planningFromRun(
      src([
        phaseEvent(5, "generating"),
        { seq: 9, kind: "error", payload: { kind: "error", message: "产物写入失败" } },
      ]),
    );
    const now = projectAt(log, maxSeq(log));

    expect(find(now, "build").status).toBe("failed");
  });
});

describe("纯函数：不改输入，可重复", () => {
  it("同一份输入投影两次，结果完全一样", () => {
    const source = src([phaseEvent(5, "spec"), specEvent(10), checkEvent(20)], "done");
    expect(planningFromRun(source)).toEqual(planningFromRun(source));
  });

  it("不修改输入对象（stages / events 都没被就地改过）", () => {
    // 投影是某一刻的快照，不能就地改输入。
    const source = src([phaseEvent(5, "spec"), specEvent(10), checkEvent(20)], "done");
    const before = structuredClone(source);

    planningFromRun(source);

    expect(source).toEqual(before);
  });

  it("返回的是新数组，不会被误当成日志本身继续追加", () => {
    const source = src([specEvent(10)]);
    const first = planningFromRun(source);
    const second = planningFromRun(source);

    expect(first).not.toBe(second);
    expect(first).toEqual(second);
  });
});

// 架构模块由 arch 事件投影成 depth 2 子节点，复用 outline 的占位行规则。

// 一份能通过三条检查的架构，条目 id 取自 SPEC；check 由 inspectArch 现算。
const ARCH: ArchSpec = {
  modules: [
    {
      id: "task-store",
      name: "任务存储",
      responsibility: "任务的增删改与本地持久化",
      dependsOn: [],
      coversFeatures: [SPEC.acceptance[0].id],
    },
    {
      id: "board-ui",
      name: "看板界面",
      responsibility: "三栏看板与拖拽交互",
      dependsOn: ["task-store"],
      coversFeatures: SPEC.acceptance.slice(1).map((a) => a.id),
    },
  ],
  packages: [{ name: "dayjs", why: "格式化时间" }],
};

// 三条检查由 inspectArch 现算。
const ARCH_CHECK = inspectArch(ARCH, SPEC);

// arch 事件载荷照 arch-stage.ts 实际发出的结构。
function archEvent(seq: number, check: unknown = ARCH_CHECK): RawEvent {
  return {
    seq,
    kind: "arch",
    payload: { kind: "arch", arch: ARCH, check, fallback: false },
  };
}

function archPointsAt(log: readonly PlanningEvent[], seq: number): TaskPoint[] {
  return projectAt(log, seq).filter((p) => p.id.startsWith("arch:"));
}

describe("架构定型 → 模块任务点", () => {
  it("每个模块长出一个 depth 2 的点，挂在 arch 下面，标题就是模块名", () => {
    const log = planningFromRun(src([archEvent(30)]));
    const kids = archPointsAt(log, 30);

    expect(kids).toHaveLength(ARCH.modules.length);
    expect(ids(kids)).toEqual(ARCH.modules.map((m) => `arch:${m.id}`));

    for (const kid of kids) {
      expect(kid.parentId).toBe("arch");
      expect(kid.depth).toBe(2);
      expect(kid.kind).toBe("exec");
      expect(kid.bornAtSeq).toBe(30);
    }
    // 标题用模块名而不是 id。
    expect(kids.map((k) => k.title)).toEqual(ARCH.modules.map((m) => m.name));
    expect(hasOrphans(projectAt(log, 30))).toBe(false);
  });

  it("到点生成：第 29 刻一个模块点都没有，第 30 刻全在 —— 出生时刻就是那条 arch 事件的 seq", () => {
    // 出生时刻用事件的 seq。
    const log = planningFromRun(src([archEvent(30)]));

    expect(ids(archPointsAt(log, 29))).toEqual([]);
    expect(archPointsAt(log, 30).map((p) => p.bornAtSeq)).toEqual(
      new Array(ARCH.modules.length).fill(30),
    );

    const other = planningFromRun(src([archEvent(77)]));
    for (const p of archPointsAt(other, 100)) expect(p.bornAtSeq).toBe(77);
  });

  it("三条检查全过 → done；有不过的 → failed（模块没有“执行”过，绝不给 running）", () => {
    // 模块是将来才做的活，此刻无人执行，所以不给 running。
    // 检查全过记 done，有不过的记 failed，保守方向不能反。
    const passing = planningFromRun(src([archEvent(30)]));
    for (const kid of archPointsAt(passing, 30)) {
      expect(kid.status, `${kid.id} 三条检查全过却没显示成 done`).toBe("done");
    }

    // 造一份过不了检查的架构，结果用真检查器现算。
    const broken: ArchSpec = {
      modules: [{ ...ARCH.modules[0], dependsOn: ["ghost"] }, ARCH.modules[1]],
      packages: [],
    };
    const brokenCheck = inspectArch(broken, SPEC);
    expect(brokenCheck.passed).toBeLessThan(brokenCheck.total); // 前提：这份夹具确实没过

    const log = planningFromRun(
      src([
        {
          seq: 30,
          kind: "arch",
          payload: { kind: "arch", arch: broken, check: brokenCheck },
        },
      ]),
    );
    const kids = archPointsAt(log, 30);
    expect(kids).toHaveLength(broken.modules.length);
    for (const kid of kids) {
      expect(kid.status, `${kid.id} 检查没过却显示成 ${kid.status}`).toBe("failed");
      // 哪一档都不许是 running。
      expect(kid.status).not.toBe("running");
    }
  });

  it("读不到检查结果时不硬说它过了：按 failed（保守方向不能反）", () => {
    // 读不到检查结果时不能判过，按 failed 处理。
    // 这里逐个手写 payload：助手会补一份全过的 check，缺字段的情况造不出来。
    const payloads: Array<{ label: string; payload: unknown }> = [
      { label: "完全没有 check 字段", payload: { kind: "arch", arch: ARCH } },
      { label: "check 是 null", payload: { kind: "arch", arch: ARCH, check: null } },
      { label: "check 是空对象", payload: { kind: "arch", arch: ARCH, check: {} } },
      {
        label: "results 是 null",
        payload: { kind: "arch", arch: ARCH, check: { results: null } },
      },
      {
        label: "results 是空数组",
        payload: { kind: "arch", arch: ARCH, check: { results: [] } },
      },
      { label: "check 是一个数字", payload: { kind: "arch", arch: ARCH, check: 42 } },
    ];

    for (const { label, payload } of payloads) {
      const log = planningFromRun(src([{ seq: 30, kind: "arch", payload }]));
      const kids = archPointsAt(log, 30);
      expect(kids, `${label} 时模块点没长出来`).toHaveLength(ARCH.modules.length);
      for (const kid of kids) {
        expect(kid.status, `${label} 时被当成通过了`).toBe("failed");
      }
    }
  });

  it("arch 事件让那一道工序真的动起来：运行结束时它是 done，而不是停在 pending", () => {
    const running = planningFromRun(src([archEvent(30)]));
    expect(find(projectAt(running, 30), "arch").status).toBe("running");

    const doneLog = planningFromRun(src([archEvent(30), phaseEvent(50, "done")]));
    const now = projectAt(doneLog, maxSeq(doneLog));
    expect(find(now, "arch").status).toBe("done");
    expect(childrenOf(now, "arch")).toHaveLength(ARCH.modules.length);
  });

  it("同一条 arch 事件到来两次：模块点只出生一次（appendBorn 幂等）", () => {
    const log = planningFromRun(src([archEvent(30), archEvent(45)]));
    const kids = archPointsAt(log, 100);

    expect(kids).toHaveLength(ARCH.modules.length);
    expect(kids.map((k) => k.bornAtSeq)).toEqual(
      new Array(ARCH.modules.length).fill(30),
    );
  });

  it("payload 残缺时不硬造任务点：没有 modules 就一个点都不生成", () => {
    const cases: unknown[] = [
      null,
      {},
      { arch: null },
      { arch: { modules: null } },
      { arch: { modules: "两个模块" } },
      42,
    ];

    for (const payload of cases) {
      const log = planningFromRun(src([{ seq: 30, kind: "arch", payload }]));
      expect(
        archPointsAt(log, 100),
        `payload=${JSON.stringify(payload)} 时凭空造了点`,
      ).toEqual([]);
    }
  });
});

describe("串一遍 projectAt → toOutline：清单里 arch 那道自己长出了子树", () => {
  it("有 arch 事件时：不再有“待规划”占位行，而是逐个列出模块", () => {
    // 三件事一起断言：占位行消失、模块逐条列出、状态 done。
    // 与下面没有 arch 事件、占位行还在那条对照一起看。
    const log = planningFromRun(src([specEvent(10), archEvent(20)]));
    const rows = toOutline(projectAt(log, maxSeq(log)));

    const archPlaceholders = rows.filter(
      (r) => r.placeholder && r.id.startsWith("arch"),
    );
    expect(archPlaceholders, "arch 那道还有待规划占位行 —— 子树没长出来").toEqual([]);

    const archRows = rows.filter((r) => r.id.startsWith("arch:"));
    expect(archRows.map((r) => r.id)).toEqual(ARCH.modules.map((m) => `arch:${m.id}`));
    expect(archRows.map((r) => r.title)).toEqual(ARCH.modules.map((m) => m.name));
    for (const row of archRows) {
      expect(row.level).toBe(2);
      expect(row.placeholder).toBe(false);
      expect(row.status).toBe("done");
      // 二级实体行可点，canvasNodeId 就是它自己的 id。
      expect(row.canvasNodeId).toBe(row.id);
    }

    // 一级行照旧在场，六道工序顺序不变。
    const level1 = rows.filter((r) => r.level === 1);
    expect(level1.map((r) => r.id)).toEqual(STAGE_INPUT.map((s) => s.id));
  });

  it("对照：没有 arch 事件的运行，arch 那道**仍然是**“待规划”占位行", () => {
    // 对照组：防止 outline 改成一级行一律不补占位行之后，上一条恒真。
    const log = planningFromRun(src([specEvent(10), checkEvent(20)]));
    const rows = toOutline(projectAt(log, maxSeq(log)));

    const archPlaceholders = rows.filter(
      (r) => r.placeholder && r.id.startsWith("arch"),
    );
    expect(archPlaceholders).toHaveLength(1);
    expect(archPlaceholders[0].title).toBe("待规划");
    expect(archPlaceholders[0].level).toBe(2);
    expect(rows.filter((r) => r.id.startsWith("arch:"))).toEqual([]);
  });

  it("诚实底线也适用于已接入的 arch：这一次没跑过就仍然是 pending、名下无子点", () => {
    // 已接入描述的是有没有实现，不是这一次跑没跑过。
    const log = planningFromRun(src([specEvent(10), checkEvent(20)], "done"));
    const now = projectAt(log, maxSeq(log));

    expect(find(now, "arch").status).toBe("pending");
    expect(childrenOf(now, "arch")).toHaveLength(0);
    expect(statusEventsFor(log, "arch")).toHaveLength(0);
  });
});

// 页面点同样来自 ui 事件，规则与架构模块点一致。

// 一份能通过三条检查的界面设计，条目 id 取自 SPEC，模块取自 ARCH。
const UI_SPEC: UiSpec = {
  tokens: [
    { name: "--color-surface", value: "#0f172a" },
    { name: "--space-1", value: "8px" },
  ],
  pages: [
    {
      id: "board",
      name: "看板页",
      route: "/",
      coversFeatures: SPEC.acceptance.slice(0, 2).map((a) => a.id),
      // 按模块 id 匹配。
      dataNeeds: [ARCH.modules[0].id],
    },
    {
      id: "archive",
      name: "归档页",
      route: "/archive",
      coversFeatures: SPEC.acceptance.slice(2).map((a) => a.id),
      // 按模块名称匹配也算对上。
      dataNeeds: [ARCH.modules[1].name],
    },
  ],
  components: [
    {
      id: "task-card",
      name: "任务卡",
      usedOn: ["board"],
      usesTokens: ["--color-surface"],
    },
  ],
};

// 三条检查由 inspectUi 现算。
const UI_CHECK = inspectUi(UI_SPEC, SPEC, ARCH);

// ui 事件载荷照 ui-stage.ts 实际发出的结构。
function uiEvent(seq: number, check: unknown = UI_CHECK): RawEvent {
  return {
    seq,
    kind: "ui",
    payload: { kind: "ui", ui: UI_SPEC, check, fallback: false },
  };
}

function uiPointsAt(log: readonly PlanningEvent[], seq: number): TaskPoint[] {
  return projectAt(log, seq).filter((p) => p.id.startsWith("ui:"));
}

describe("界面设计 → 页面任务点", () => {
  it("夹具自身成立：三条本地检查全过（由真的 inspectUi 现算）", () => {
    // 夹具必须先过了检查，下面那条才有意义。
    expect(UI_CHECK.total).toBe(3);
    expect(UI_CHECK.passed).toBe(3);
  });

  it("每个页面长出一个 depth 2 的点，挂在 ui 下面，标题就是页面名", () => {
    const log = planningFromRun(src([uiEvent(30)]));
    const kids = uiPointsAt(log, 30);

    expect(kids).toHaveLength(UI_SPEC.pages.length);
    expect(ids(kids)).toEqual(UI_SPEC.pages.map((p) => `ui:${p.id}`));

    for (const kid of kids) {
      expect(kid.parentId).toBe("ui");
      expect(kid.depth).toBe(2);
      expect(kid.kind).toBe("exec");
      expect(kid.bornAtSeq).toBe(30);
    }
    // 标题用页面名而不是 id。
    expect(kids.map((k) => k.title)).toEqual(UI_SPEC.pages.map((p) => p.name));
    expect(hasOrphans(projectAt(log, 30))).toBe(false);
  });

  it("到点生成：第 29 刻一个页面点都没有，第 30 刻全在 —— 出生时刻就是那条 ui 事件的 seq", () => {
    // 出生时刻用事件的 seq。
    const log = planningFromRun(src([uiEvent(30)]));

    expect(ids(uiPointsAt(log, 29))).toEqual([]);
    expect(uiPointsAt(log, 30).map((p) => p.bornAtSeq)).toEqual(
      new Array(UI_SPEC.pages.length).fill(30),
    );

    const other = planningFromRun(src([uiEvent(77)]));
    for (const p of uiPointsAt(other, 100)) expect(p.bornAtSeq).toBe(77);
  });

  it("三条检查全过 → done；有不过的 → failed（页面没有“执行”过，绝不给 running）", () => {
    // 页面同样无人执行，不给 running。
    // 检查全过记 done，有不过的记 failed，与架构模块点同口径。
    const passing = planningFromRun(src([uiEvent(30)]));
    for (const kid of uiPointsAt(passing, 30)) {
      expect(kid.status, `${kid.id} 三条检查全过却没显示成 done`).toBe("done");
    }

    // 造一份过不了检查的界面设计，结果用真检查器现算。
    const broken: UiSpec = {
      ...UI_SPEC,
      pages: [
        {
          ...UI_SPEC.pages[0],
          coversFeatures: [SPEC.acceptance[0].id],
        },
      ],
    };
    const brokenCheck = inspectUi(broken, SPEC, ARCH);
    expect(brokenCheck.passed).toBeLessThan(brokenCheck.total); // 前提：这份夹具确实没过

    const log = planningFromRun(
      src([
        {
          seq: 30,
          kind: "ui",
          payload: { kind: "ui", ui: broken, check: brokenCheck },
        },
      ]),
    );
    const kids = uiPointsAt(log, 30);
    expect(kids).toHaveLength(broken.pages.length);
    for (const kid of kids) {
      expect(kid.status, `${kid.id} 检查没过却显示成 ${kid.status}`).toBe("failed");
      // 哪一档都不许是 running。
      expect(kid.status).not.toBe("running");
    }
  });

  it("读不到检查结果时不硬说它过了：按 failed（保守方向不能反）", () => {
    // 读不到检查结果时不能判过，按 failed 处理。
    // 这里手写 payload：助手会补一份全过的 check。
    const payloads: Array<{ label: string; payload: unknown }> = [
      { label: "完全没有 check 字段", payload: { kind: "ui", ui: UI_SPEC } },
      { label: "check 是 null", payload: { kind: "ui", ui: UI_SPEC, check: null } },
      { label: "check 是空对象", payload: { kind: "ui", ui: UI_SPEC, check: {} } },
      {
        label: "results 是 null",
        payload: { kind: "ui", ui: UI_SPEC, check: { results: null } },
      },
      {
        label: "results 是空数组",
        payload: { kind: "ui", ui: UI_SPEC, check: { results: [] } },
      },
      { label: "check 是一个数字", payload: { kind: "ui", ui: UI_SPEC, check: 42 } },
    ];

    for (const { label, payload } of payloads) {
      const log = planningFromRun(src([{ seq: 30, kind: "ui", payload }]));
      const kids = uiPointsAt(log, 30);
      expect(kids, `${label} 时页面点没长出来`).toHaveLength(UI_SPEC.pages.length);
      for (const kid of kids) {
        expect(kid.status, `${label} 时被当成通过了`).toBe("failed");
      }
    }
  });

  it("ui 事件让那一道工序真的动起来：运行结束时它是 done，而不是停在 pending", () => {
    const running = planningFromRun(src([uiEvent(30)]));
    expect(find(projectAt(running, 30), "ui").status).toBe("running");

    const doneLog = planningFromRun(src([uiEvent(30), phaseEvent(50, "done")]));
    const now = projectAt(doneLog, maxSeq(doneLog));
    expect(find(now, "ui").status).toBe("done");
    expect(childrenOf(now, "ui")).toHaveLength(UI_SPEC.pages.length);
  });

  it("phase:ui 也归 ui 那道工序（不是只在产出事件时才认它）", () => {
    const log = planningFromRun(src([phaseEvent(12, "ui")]));
    const now = projectAt(log, 12);

    expect(find(now, "ui").status).toBe("running");
    // 只报阶段、还没有产出时，一个页面点都不该有。
    expect(uiPointsAt(log, 12)).toEqual([]);
  });

  it("同一条 ui 事件到来两次：页面点只出生一次（appendBorn 幂等）", () => {
    const log = planningFromRun(src([uiEvent(30), uiEvent(45)]));
    const kids = uiPointsAt(log, 100);

    expect(kids).toHaveLength(UI_SPEC.pages.length);
    expect(kids.map((k) => k.bornAtSeq)).toEqual(
      new Array(UI_SPEC.pages.length).fill(30),
    );
  });

  it("payload 残缺时不硬造任务点：没有 pages 就一个点都不生成", () => {
    const cases: unknown[] = [
      null,
      {},
      { ui: null },
      { ui: { pages: null } },
      { ui: { pages: "两个页面" } },
      42,
    ];

    for (const payload of cases) {
      const log = planningFromRun(src([{ seq: 30, kind: "ui", payload }]));
      expect(
        uiPointsAt(log, 100),
        `payload=${JSON.stringify(payload)} 时凭空造了点`,
      ).toEqual([]);
    }
  });

  it("没有 id 的页面不生成点 —— 宁可少一行，也不要拿下标凑一个会漂的 id", () => {
    const log = planningFromRun(
      src([
        {
          seq: 30,
          kind: "ui",
          payload: {
            kind: "ui",
            ui: { ...UI_SPEC, pages: [{ name: "没写 id 的页面" }, UI_SPEC.pages[0]] },
            check: UI_CHECK,
          },
        },
      ]),
    );
    const kids = uiPointsAt(log, 30);

    expect(ids(kids)).toEqual([`ui:${UI_SPEC.pages[0].id}`]);
  });
});

describe("串一遍 projectAt → toOutline：清单里 ui 那道也自己长出了子树", () => {
  it("有 ui 事件时：不再有“待规划”占位行，而是逐个列出页面", () => {
    // 三件事一起断言：占位行消失、页面逐条列出、状态 done。
    // 与下面没有 ui 事件、占位行还在那条对照一起看。
    const log = planningFromRun(src([specEvent(10), archEvent(20), uiEvent(30)]));
    const rows = toOutline(projectAt(log, maxSeq(log)));

    const uiPlaceholders = rows.filter((r) => r.placeholder && r.id.startsWith("ui"));
    expect(uiPlaceholders, "ui 那道还有待规划占位行 —— 子树没长出来").toEqual([]);

    const uiRows = rows.filter((r) => r.id.startsWith("ui:"));
    expect(uiRows.map((r) => r.id)).toEqual(UI_SPEC.pages.map((p) => `ui:${p.id}`));
    expect(uiRows.map((r) => r.title)).toEqual(UI_SPEC.pages.map((p) => p.name));
    for (const row of uiRows) {
      expect(row.level).toBe(2);
      expect(row.placeholder).toBe(false);
      expect(row.status).toBe("done");
      // 二级实体行可点，canvasNodeId 就是它自己的 id。
      expect(row.canvasNodeId).toBe(row.id);
    }

    // ui 一级行照旧在场，顺序不变。
    const level1 = rows.filter((r) => r.level === 1);
    expect(level1.map((r) => r.id)).toEqual(STAGE_INPUT.map((s) => s.id));

    // 两棵子树同时在，架构的模块行没被挤掉。
    expect(rows.filter((r) => r.id.startsWith("arch:")).length).toBe(
      ARCH.modules.length,
    );
  });

  it("对照：没有 ui 事件的运行，ui 那道**仍然是**“待规划”占位行", () => {
    // 对照组：防止 outline 改成一级行一律不补占位行之后，上一条恒真。
    const log = planningFromRun(src([specEvent(10), checkEvent(20)]));
    const rows = toOutline(projectAt(log, maxSeq(log)));

    const uiPlaceholders = rows.filter((r) => r.placeholder && r.id.startsWith("ui"));
    expect(uiPlaceholders).toHaveLength(1);
    expect(uiPlaceholders[0].title).toBe("待规划");
    expect(uiPlaceholders[0].level).toBe(2);
    expect(rows.filter((r) => r.id.startsWith("ui:"))).toEqual([]);
  });

  it("诚实底线也适用于已接入的 ui：这一次没跑过就仍然是 pending、名下无子点", () => {
    // 已接入描述的是有没有实现，不是这一次跑没跑过。
    const log = planningFromRun(
      src([specEvent(10), archEvent(20), checkEvent(25)], "done"),
    );
    const now = projectAt(log, maxSeq(log));

    expect(find(now, "ui").status).toBe("pending");
    expect(childrenOf(now, "ui")).toHaveLength(0);
    expect(statusEventsFor(log, "ui")).toHaveLength(0);
  });
});

// 并行构建的模块结果投影成 depth 2 子节点，多一档失败状态。

// 字段齐全的 ModuleBuild，summarizeBatch 能原样带出名字与花费。
function moduleBuildFixture(moduleId: string, costCny = 0.01): ModuleBuild {
  return {
    moduleId,
    summary: `${moduleId} 这一段做完了`,
    html: `<section data-module="${moduleId}"></section>`,
    css: `.${moduleId}-box{color:red}`,
    js: `function ${moduleId.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())}Init(){}`,
    costCny,
    usage: ZERO_USAGE,
    model: "fake-model",
    priceTier: "offPeak",
    latencyMs: 20,
    truncated: false,
    reasoning: "",
  };
}

// 成功与失败各一个：全是成功就验不到失败模块的显示。
const BUILD_BATCH: BuildBatch = {
  modules: [moduleBuildFixture("task-store")],
  failed: [
    {
      moduleId: "board-ui",
      message: "调用模型失败：连接超时",
      costCny: 0.012,
      usage: ZERO_USAGE,
      model: "fake-model",
      priceTier: "offPeak",
      latencyMs: 30,
      reasoning: "",
    },
  ],
  concurrency: 2,
  retriedModules: [],
  totalCostCny: 0.022,
  totalUsage: ZERO_USAGE,
  wallClockMs: 45,
  peakInFlight: 2,
};

// modules 事件载荷由 summarizeBatch 现算，不手抄摘要。
function modulesEvent(seq: number, batch: BuildBatch = BUILD_BATCH): RawEvent {
  return {
    seq,
    kind: "modules",
    payload: { kind: "modules", batch: summarizeBatch(batch, ARCH) },
  };
}

function buildPointsAt(log: readonly PlanningEvent[], seq: number): TaskPoint[] {
  return projectAt(log, seq).filter((p) => p.id.startsWith("build:"));
}

describe("并行构建 → 模块构建任务点（含失败那一栏）", () => {
  it("每个模块长出一个 depth 2 的点，挂在 build 下面，id 形如 build:<模块id>", () => {
    const log = planningFromRun(src([archEvent(20), modulesEvent(30)]));
    const kids = buildPointsAt(log, 30);

    // 成功与失败各一个点，少一个就是粉饰。
    expect(ids(kids)).toEqual(["build:task-store", "build:board-ui"]);

    for (const kid of kids) {
      expect(kid.parentId).toBe("build");
      expect(kid.depth).toBe(2);
      expect(kid.kind).toBe("exec");
      expect(kid.bornAtSeq).toBe(30);
    }
    // 标题从 arch 查，不用事件里那份副本。
    expect(kids.map((k) => k.title)).toEqual(ARCH.modules.map((m) => m.name));
    expect(hasOrphans(projectAt(log, 30))).toBe(false);
  });

  it("失败模块 → failed，成功模块 → done；绝不给 running（构建已经结束了）", () => {
    // 成功模块记 done，失败模块记 failed；抹掉失败会让产物和账目都对不上。
    // 构建在事件到达时已结束，不给 running。
    const log = planningFromRun(src([archEvent(20), modulesEvent(30)]));
    const kids = buildPointsAt(log, 30);
    const byId = new Map(kids.map((k) => [k.id, k.status]));

    expect(byId.get("build:task-store")).toBe("done");
    expect(byId.get("build:board-ui")).toBe("failed");
    for (const kid of kids) expect(kid.status).not.toBe("running");
  });

  it("失败的模块也带着原因进了摘要，而不是只剩一个红点", () => {
    // 载荷带 message，界面才能说明为什么红。
    const payload = modulesEvent(30).payload as {
      batch: { failed: { moduleId: string; message: string; name: string }[] };
    };
    expect(payload.batch.failed).toHaveLength(1);
    expect(payload.batch.failed[0].moduleId).toBe("board-ui");
    expect(payload.batch.failed[0].message).toContain("连接超时");
    expect(payload.batch.failed[0].name).toBe(ARCH.modules[1].name);
  });

  it("到点生成：第 29 刻一个模块构建点都没有，第 30 刻全在", () => {
    const log = planningFromRun(src([archEvent(20), modulesEvent(30)]));

    expect(ids(buildPointsAt(log, 29))).toEqual([]);
    expect(buildPointsAt(log, 30).map((p) => p.bornAtSeq)).toEqual([30, 30]);
  });

  it("顺序按 **arch** 排，而不是按事件里“成功在前、失败在后”的顺序", () => {
    // 顺序按 arch 排，不按事件里成功在前的顺序，两处模块才对得上。
    const flipped: BuildBatch = {
      ...BUILD_BATCH,
      modules: [moduleBuildFixture("board-ui")],
      failed: [
        {
          moduleId: "task-store",
          message: "调用模型失败：超时",
          costCny: 0,
          usage: ZERO_USAGE,
          model: null,
          priceTier: null,
          latencyMs: 5,
          reasoning: "",
        },
      ],
    };
    const log = planningFromRun(src([archEvent(20), modulesEvent(30, flipped)]));

    expect(ids(buildPointsAt(log, 30))).toEqual(["build:task-store", "build:board-ui"]);
    const now = buildPointsAt(log, 30);
    // 顺序按 arch，状态按各自事实。
    expect(now[0].status).toBe("failed");
    expect(now[1].status).toBe("done");
  });

  it("modules 事件让第四道真的动起来：运行结束时它是 done，而不是停在 pending", () => {
    const running = planningFromRun(src([archEvent(20), modulesEvent(30)]));
    expect(find(projectAt(running, 30), "build").status).toBe("running");

    const doneLog = planningFromRun(
      src([archEvent(20), modulesEvent(30), phaseEvent(60, "done")]),
    );
    const now = projectAt(doneLog, maxSeq(doneLog));
    expect(find(now, "build").status).toBe("done");
    expect(childrenOf(now, "build")).toHaveLength(2);
  });

  it("phase:building 也归第四道（不是只在产出事件时才认它）", () => {
    const log = planningFromRun(src([archEvent(20), phaseEvent(25, "building")]));
    const now = projectAt(log, 25);

    expect(find(now, "build").status).toBe("running");
    // 只是开工还没有产物，一个 build:* 点都不该有。
    expect(childrenOf(now, "build")).toHaveLength(0);
  });

  it("没有 arch 事件时标题退到事件里的那份名字，最后才退到模块 id", () => {
    // 缺 arch 事件时标题退到载荷里的名字，不留空标题。
    const log = planningFromRun(src([modulesEvent(30)]));
    const kids = buildPointsAt(log, 30);
    expect(kids.map((k) => k.title)).toEqual(ARCH.modules.map((m) => m.name));
  });

  it("同一条 modules 事件到来两次：点只出生一次（appendBorn 幂等）", () => {
    const log = planningFromRun(
      src([archEvent(20), modulesEvent(30), modulesEvent(45)]),
    );
    const kids = buildPointsAt(log, 100);

    expect(kids).toHaveLength(2);
    expect(kids.map((k) => k.bornAtSeq)).toEqual([30, 30]);
  });

  it("payload 残缺时不硬造任务点：没有 batch / modules / failed 就一个点都不生成", () => {
    const cases: unknown[] = [
      null,
      {},
      { batch: null },
      { batch: {} },
      { batch: { modules: null } },
      { batch: { modules: "两个模块" } },
      42,
    ];

    for (const payload of cases) {
      const log = planningFromRun(src([{ seq: 30, kind: "modules", payload }]));
      expect(
        buildPointsAt(log, 100),
        `payload=${JSON.stringify(payload)} 时凭空造了点`,
      ).toEqual([]);
    }
  });

  it("成功列表为空、失败列表非空时，照样为失败的模块建点（不许因为没成功就整批消失）", () => {
    const allFailed: BuildBatch = {
      ...BUILD_BATCH,
      modules: [],
      failed: [
        {
          moduleId: "task-store",
          message: "调用模型失败：超时",
          costCny: 0,
          usage: ZERO_USAGE,
          model: null,
          priceTier: null,
          latencyMs: 3,
          reasoning: "",
        },
        {
          moduleId: "board-ui",
          message: "产出无法使用：JSON 解析失败",
          costCny: 0.03,
          usage: ZERO_USAGE,
          model: "fake-model",
          priceTier: "offPeak",
          latencyMs: 9,
          reasoning: "想了不少，但输出被截断了",
        },
      ],
    };
    const log = planningFromRun(src([archEvent(20), modulesEvent(30, allFailed)]));
    const kids = buildPointsAt(log, 30);

    expect(ids(kids)).toEqual(["build:task-store", "build:board-ui"]);
    for (const kid of kids) expect(kid.status).toBe("failed");
  });
});

describe("串一遍 projectAt → toOutline：清单里 build 那道自己长出了子树", () => {
  it("有 modules 事件时：不再有“待规划”占位行，而是逐个列出模块构建结果", () => {
    // 第三次长出子树，这一次多一档失败状态。
    const log = planningFromRun(src([specEvent(10), archEvent(20), modulesEvent(30)]));
    const rows = toOutline(projectAt(log, maxSeq(log)));

    const buildPlaceholders = rows.filter(
      (r) => r.placeholder && r.id.startsWith("build"),
    );
    expect(buildPlaceholders, "build 那道还有待规划占位行 —— 子树没长出来").toEqual([]);

    // 列出来的模块 id、标题、层级都对得上。
    const buildRows = rows.filter((r) => r.id.startsWith("build:"));
    expect(buildRows.map((r) => r.id)).toEqual(["build:task-store", "build:board-ui"]);
    expect(buildRows.map((r) => r.title)).toEqual(ARCH.modules.map((m) => m.name));
    for (const row of buildRows) {
      expect(row.level).toBe(2);
      expect(row.placeholder).toBe(false);
      expect(row.canvasNodeId).toBe(row.id);
    }

    // 失败模块在清单上是 failed。
    const statusOf = new Map(buildRows.map((r) => [r.id, r.status]));
    expect(statusOf.get("build:task-store")).toBe("done");
    expect(statusOf.get("build:board-ui")).toBe("failed");

    // build 一级行在场，六道工序顺序不变。
    const level1 = rows.filter((r) => r.level === 1);
    expect(level1.map((r) => r.id)).toEqual(STAGE_INPUT.map((s) => s.id));

    // 三棵子树同时在，前面两道的行没被挤掉。
    expect(rows.filter((r) => r.id.startsWith("arch:")).length).toBe(
      ARCH.modules.length,
    );
  });

  it("对照：没有 modules 事件的运行，build 那道**仍然是**“待规划”占位行", () => {
    // 对照组：防止占位行规则被改后上一条恒真。
    const log = planningFromRun(src([specEvent(10), archEvent(20), checkEvent(25)]));
    const rows = toOutline(projectAt(log, maxSeq(log)));

    const buildPlaceholders = rows.filter(
      (r) => r.placeholder && r.id.startsWith("build"),
    );
    expect(buildPlaceholders).toHaveLength(1);
    expect(buildPlaceholders[0].title).toBe("待规划");
    expect(buildPlaceholders[0].level).toBe(2);
    expect(rows.filter((r) => r.id.startsWith("build:"))).toEqual([]);
  });

  it("诚实底线也适用于第四道：这一次没跑过就仍然是 pending、名下无子点", () => {
    const log = planningFromRun(
      src([specEvent(10), archEvent(20), checkEvent(25)], "done"),
    );
    const now = projectAt(log, maxSeq(log));

    expect(find(now, "build").status).toBe("pending");
    expect(childrenOf(now, "build")).toHaveLength(0);
    expect(statusEventsFor(log, "build")).toHaveLength(0);
  });
});
describe("三方向任务点（全栈模式）", () => {
  const toolEvents = [
    {
      seq: 10,
      at: 10,
      kind: "tool",
      payload: {
        kind: "tool",
        name: "db.schema",
        ok: true,
        result: "1 张表：todos",
        latencyMs: 3,
      },
    },
    {
      seq: 11,
      at: 11,
      kind: "tool",
      payload: {
        kind: "tool",
        name: "api.routes",
        ok: true,
        result: "GET /health",
        latencyMs: 4,
      },
    },
    {
      seq: 12,
      at: 12,
      kind: "tool",
      payload: {
        kind: "tool",
        name: "web.page",
        ok: true,
        result: "2 KB",
        latencyMs: 0,
      },
    },
  ];

  it("三条 tool 事件在构建工序下生成三个子任务点", () => {
    const log = planningFromRun(src(toolEvents as never));
    const points = projectAt(log, 12);

    const directions = points.filter((p) => p.id.startsWith("build:direction:"));
    expect(directions.map((p) => p.title)).toEqual(["数据库", "后端", "前端"]);
    for (const point of directions) {
      expect(point.parentId).toBe("build");
      expect(point.depth).toBe(2);
      expect(point.status).toBe("done");
    }
  });

  it("不认识的工具名不造点（别把普通工具混进三方向）", () => {
    const log = planningFromRun(
      src([
        {
          seq: 5,
          at: 5,
          kind: "tool",
          payload: {
            kind: "tool",
            name: "fs.read",
            ok: true,
            result: "",
            latencyMs: 1,
          },
        },
      ] as never),
    );

    expect(projectAt(log, 5).some((p) => p.id.startsWith("build:direction:"))).toBe(
      false,
    );
  });
});
