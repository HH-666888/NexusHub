import { describe, expect, it } from "vitest";
import { summarizeChecks, type CheckResult } from "@/core/domain/check";
import { fallbackSpec, reviewSpec } from "@/core/domain/spec";
import { inspectArtifact } from "@/core/generate/prompt";
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
 * 从真实运行事件投影出规划日志：单测
 * ============================================================
 * 排列顺序就是重要性顺序：
 *
 * ① 骨架：根 + 六道工序一次全生成在 seq 0，且不成孤儿。
 * ② ★ 诚实底线（**这组是整个文件存在的理由**）——
 *    没有真实事件的工序必须停在 pending，无论 run 是什么状态。
 *    这条不变量一旦破掉，界面上会出现「写着已完成、却拿不出产物」的工序，
 *    而那正是这个产品最不能犯的错（stages.ts 里 StageImplementation 那段写着理由）。
 * ③ 到点生成：第 N 步的树里没有第 N+1 步才出生的东西。
 * ④ 检查项 → 任务点的派生规则。
 * ⑤ 和现成函数串起来：projectAt → toOutline 仍然是一棵对得上的树。
 * ⑥ 失败传播。
 *
 * ── 一条贯穿全篇的取材原则 ──
 *   六个工序的名字、未接入的是哪几道、七项检查叫什么、规格产物的条目长什么样，
 *   全部**从项目自己的代码里取**（STAGES / inspectArtifact / fallbackSpec），
 *   不在这里手抄一份。手抄一份的话，将来产品改了而那三个字没改，
 *   测试会继续绿着，说的却已经是另一件事了。
 */

/* ============================================================
   取材：一切来自产品代码
   ============================================================ */

/** 六道工序，直接用项目现成的 STAGES —— 顺序也用它，不另排 */
const STAGE_INPUT = STAGES.map((s) => ({ id: s.id, name: s.name }));

/**
 * 未接入的三道工序。
 * 从 STAGES 自己的 implementation 字段算出来（progress.ts 用的是同一个判断），
 * 而不是在这里写死 "arch"/"ui"/"assemble" —— 写死的话，
 * 哪天某道工序接上了，这条测试会继续拿旧名单去断言，越测越错。
 */
const PLANNED_IDS = STAGES.filter((s) => s.implementation === "planned").map((s) => s.id);

/**
 * 七项检查的真实名字。
 *
 * 用 inspectArtifact 拿，而不是自己编七个中文名：这样任务点的 id
 * （`verify:${name}`，与 forest.ts:138 同一个约定）就是**真的**那七个，
 * 万一哪天检查项改了名，这里会跟着动，而不是继续对着空气断言。
 */
const REAL_CHECK_NAMES = inspectArtifact("").map((r) => r.name);

/** 规格产物：用项目自己的兜底规格生成器，条目 id 是 ac-1…，条目标题是它的 statement */
const SPEC = fallbackSpec({ prompt: "做一个任务看板", model: "fallback", generatedAt: 0 });

/* ============================================================
   造事件
   ============================================================ */

/** 一条真实运行事件。kind 在外层，payload 里的结构由 kind 决定（见 run-event.ts） */
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

/** phase 事件。真实取值见 GeneratePhase（spec / awaiting / generating / checking / saving / done / failed） */
function phaseEvent(seq: number, phase: string, label = "进行中"): RawEvent {
  return { seq, kind: "phase", payload: { kind: "phase", phase, label } };
}

/** spec 事件：规格产物落地 */
function specEvent(seq: number): RawEvent {
  return {
    seq,
    kind: "spec",
    payload: { kind: "spec", spec: SPEC, gate: reviewSpec(SPEC), fallback: true },
  };
}

/**
 * check 事件：七项检查的结果。
 * 默认全过；传一个断言可以指定哪几项没过。
 */
function checkEvent(seq: number, pass: (name: string) => boolean = () => true): RawEvent {
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

/* ============================================================
   读结果
   ============================================================ */

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

/** 此刻的全部检查项任务点 */
function checkPointsAt(log: readonly PlanningEvent[], seq: number): TaskPoint[] {
  return projectAt(log, seq).filter((p) => p.id.startsWith("verify:"));
}

/** 日志里针对某个 id 写的状态事件（用来证明「我们**没有**碰过它」） */
function statusEventsFor(log: readonly PlanningEvent[], id: string): PlanningEvent[] {
  return log.filter((e) => e.kind === "status" && e.id === id);
}

/* ============================================================
   ① 骨架：根 + 六道工序
   ============================================================ */

describe("骨架：一级 Agent 与六道工序一次全生成", () => {
  it("空事件数组 → 恰好 7 个出生事件（1 根 + 6 工序），全部在第 0 刻出生", () => {
    /*
      骨架是「计划」，不是「产出」：不管这次运行跑到哪，
      六道工序和它们的顺序都是确定的，所以它们不像执行点那样到点生成。
      用户在还没开始跑的时候就该看见整条流水线 —— 这是「计划」该有的样子。
    */
    const log = planningFromRun(src([]));

    const borns = bornPoints(log);
    expect(borns).toHaveLength(1 + STAGE_INPUT.length);
    expect(borns).toHaveLength(7);

    for (const point of borns) {
      expect(point.bornAtSeq, `${point.id} 不是在第 0 刻出生的`).toBe(0);
    }
  });

  it("第 0 刻就能投影出整棵树，且一个孤儿都没有", () => {
    /*
      hasOrphans 是布局的前提：找不到父节点的点会被摆到原点或者干脆丢掉，
      两种表现都不抛错。所以「一开始就是一棵完整的树」要在第 0 刻就成立。
    */
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
      expect(find(atZero, stage.id).status, `${stage.name} 没有事件却有进展`).toBe("pending");
    }
  });

  it("根节点的状态就是这次运行的状态（它不替任何工序表态）", () => {
    /*
      一级 Agent 代表整条运行本身：运行在跑它就是 running，
      运行完了它就是 done，运行失败它就是 failed。
      六道工序的状态另算 —— 见下面那组诚实底线的用例。
    */
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

/* ============================================================
   ② ★ 诚实底线
   ============================================================ */

describe("★ 诚实底线：没有真实事件的工序必须停在 pending", () => {
  it("只有 spec 和 check 事件时，arch / ui / assemble 仍是 pending，且一个子节点都没有", () => {
    /*
      这是整个文件最要紧的一条断言。

      界面上写着「已通过」却拿不出产物，比直接写「未接入」严重得多 ——
      评委问一句「架构定型的产物给我看看」就会当场穿帮。
      所以这里断的是两件事：
        · 状态还是 pending（没有进展，也没有完成）；
        · 名下一个执行点都没有（不是「有计划但还没跑」，是**压根没接入**）。
      第二件比第一件更狠：状态可以被一次误算改掉，而「一个点都没长出来」
      说明这次运行里确实没有任何东西能支撑起这三道工序。
    */
    const log = planningFromRun(src([specEvent(10), checkEvent(20)]));
    const now = projectAt(log, maxSeq(log));

    // 前提检查：这道 fixture 确实让别的工序动起来了，不是因为事件为空才「看起来对」
    expect(find(now, "spec").status).not.toBe("pending");
    expect(find(now, "verify").status).not.toBe("pending");
    expect(checkPointsAt(log, maxSeq(log))).toHaveLength(7);

    for (const id of PLANNED_IDS) {
      expect(find(now, id).status, `${id} 被凭空标出了进展`).toBe("pending");
      expect(childrenOf(now, id), `${id} 名下不该有任何执行点`).toHaveLength(0);
      // 更硬的一条：日志里根本没有针对它的状态事件 —— 我们从未碰过它
      expect(statusEventsFor(log, id), `${id} 被写过状态事件`).toHaveLength(0);
    }

    // 这三道未接入的工序，正是 STAGES 自己声明为 planned 的那三道
    expect(PLANNED_IDS).toEqual(["arch", "ui", "assemble"]);
  });

  it("runStatus 为 done 时，未接入的三道仍然 pending —— 有产出的才配 done", () => {
    /*
      单独一条用例，因为这是最容易写错的地方：
      「run 都成功了，那六道肯定都跑完了吧」—— 这个推断看起来无害，
      实际上会让三道从没跑过的工序显示成已完成。
      这条规则和 core/pipeline/progress.ts 里那行
      `if (s.implementation === "planned") return [s.id, "pending"];` 是同一条。
    */
    const log = planningFromRun(src([specEvent(10), checkEvent(20)], "done"));
    const now = projectAt(log, maxSeq(log));

    // 有真实产出的两道（有 depth-2 子节点）→ done
    expect(find(now, "spec").status).toBe("done");
    expect(find(now, "verify").status).toBe("done");

    // 没有产出的 → 一律 pending，run 成功也一样
    for (const id of PLANNED_IDS) {
      expect(find(now, id).status, `${id} 因为 run 成功被标成了 done`).toBe("pending");
      expect(childrenOf(now, id)).toHaveLength(0);
    }

    /*
      build 也停在 pending —— 这条值得说一句：
      这次事件流里没有任何属于 build 的事件，所以它对这次运行是「没动过」。
      规则是**看证据**而不是看位置（不搞「第 4 道之前都算完成」那一套），
      所以它和 arch/ui/assemble 一样停在 pending。
    */
    expect(find(now, "build").status).toBe("pending");
  });

  it("runStatus 为 failed 时，未接入的三道仍然是 pending（失败也不许波及无关工序）", () => {
    const log = planningFromRun(
      src([phaseEvent(10, "spec"), phaseEvent(20, "generating"), phaseEvent(30, "failed")], "failed"),
    );
    const now = projectAt(log, maxSeq(log));

    for (const id of PLANNED_IDS) {
      expect(find(now, id).status, `${id} 被失败波及了`).toBe("pending");
    }
  });
});

/* ============================================================
   ③ 到点生成
   ============================================================ */

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
    /*
      不另算一个序号（比如 maxSeq+1）：那种算法在乱序追加时会给出
      「早于自己声明的出生时刻」的点，而 projectAt 的到点语义是按 bornAtSeq 判的。
    */
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
    /*
      把「到点」和「树完整」两条不变量在整条时间轴上验一遍，
      而不是逐个 seq 写死。将来事件变多、层级变深，这条照样管用。
    */
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

/* ============================================================
   ④ 检查项 → 任务点
   ============================================================ */

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
    // id 用的是项目现成的约定：forest.ts 里也是 `verify:${名字}`
    expect(ids(kids).sort()).toEqual(REAL_CHECK_NAMES.map((n) => `verify:${n}`).sort());
    expect(hasOrphans(now)).toBe(false);
  });

  it("没过的那项是 failed，其余六项是 done —— 状态在出生那一刻就定了", () => {
    /*
      检查结果是被 check 事件一起带进来的，一项检查没有「先出生、再慢慢跑完」的过程，
      所以它的状态不是后来写上去的，而是出生时就带着的。
    */
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
    /*
      「重新检查一次」在真实运行里完全可能。同名检查项 id 相同，
      appendBorn 会让第二个出生事件进不了日志（见 planning-log.ts），
      所以画布上不会出现两张同名的卡。
    */
    const log = planningFromRun(src([checkEvent(30), checkEvent(45)]));
    const kids = checkPointsAt(log, 100);

    expect(kids).toHaveLength(7);
    expect(kids.map((k) => k.bornAtSeq)).toEqual(new Array(7).fill(30));
  });

  it("payload 残缺时不硬造任务点：没有 results 就一个点都不生成", () => {
    /*
      事件是从数据库那行 JSON 还原出来的，残缺是可能的。
      这里的原则和 domain/spec.ts 的解析一样：剥不出来就明确失败，不做「尽力而为」的猜测。
      猜出来的点会一路错到画布上，而且不会有任何东西变红。
    */
    const cases: unknown[] = [null, {}, { results: null }, { results: "七项" }, 42];

    for (const payload of cases) {
      const log = planningFromRun(src([{ seq: 30, kind: "check", payload }]));
      expect(checkPointsAt(log, 100), `payload=${JSON.stringify(payload)} 时凭空造了点`).toEqual(
        [],
      );
    }
  });
});

/* ============================================================
   ⑤ 产物与流式事件：不作为任务点
   ============================================================ */

describe("产物是结果，不是任务点", () => {
  it("artifact 事件不生成任何任务点，但会让所属工序继续动", () => {
    /*
      产物没有「还没做 / 正在做 / 做完了」这个过程 —— 它出现的那一刻就已经在那儿了。
      给它建任务点，清单里会多出一串「index.html」这种不是活儿的东西。
      但它的意义不能丢：落盘成功说明 build 这道工序确实在动。
    */
    const artifact = {
      id: "a1",
      runId: "r1",
      kind: "html",
      path: "r1/index.html",
      bytes: 1024,
      at: 0,
    };
    const log = planningFromRun(
      src([phaseEvent(10, "generating"), { seq: 20, kind: "artifact", payload: { kind: "artifact", artifact } }]),
    );

    const now = projectAt(log, maxSeq(log));
    expect(now.some((p) => p.id.includes("artifact"))).toBe(false);
    expect(now).toHaveLength(7); // 根 + 六道工序，一个执行点都没有
    expect(find(now, "build").status).toBe("running");
  });

  it("text / reasoning / usage 这些流式事件一律不进计划", () => {
    /*
      它们是**过程**：一次运行几万条，回答的是「机器刚才做了什么」。
      规划日志回答的是「计划走到哪一步了」。混进来会让清单变成一片噪声。
    */
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

/* ============================================================
   ⑥ 串起现成函数：projectAt → toOutline
   ============================================================ */

describe("串起现成函数：projectAt → toOutline", () => {
  it("六道工序是 level 1，检查项是 level 2，没接的三道出现 placeholder 的待规划行", () => {
    /*
      这条测的不是某一个函数，而是**两层能不能对上**：
      画布和左侧清单是同一棵树的两种视图，清单里有的画布上一定找得到。
      所以这里从事件一路走到清单行，中间不手工造任何任务点。
    */
    const log = planningFromRun(src([specEvent(10), checkEvent(20)]));
    const rows = toOutline(projectAt(log, maxSeq(log)));

    // 六道工序 = 一级任务点，顺序就是 STAGES 的顺序
    const level1 = rows.filter((r) => r.level === 1);
    expect(level1.map((r) => r.id)).toEqual(STAGE_INPUT.map((s) => s.id));
    expect(level1.map((r) => r.title)).toEqual(STAGE_INPUT.map((s) => s.name));
    for (const row of level1) expect(row.placeholder).toBe(false);

    // 七个检查项 = 二级任务点，挂在 verify 下面
    const checkRows = rows.filter((r) => r.id.startsWith("verify:"));
    expect(checkRows).toHaveLength(7);
    for (const row of checkRows) expect(row.level).toBe(2);

    // 规格条目也是二级任务点，挂在 spec 下面
    const specRows = rows.filter((r) => r.id.startsWith("spec:"));
    expect(specRows).toHaveLength(SPEC.acceptance.length);
    for (const row of specRows) expect(row.level).toBe(2);

    // 有真实产出的两道，不该出现占位行
    for (const id of ["spec", "verify"]) {
      expect(rows.filter((r) => r.placeholder && r.id.startsWith(id))).toEqual([]);
    }

    // 没接入的三道：一行「待规划」的占位行，界面画成浅色虚线
    for (const id of PLANNED_IDS) {
      const placeholders = rows.filter((r) => r.placeholder && r.id.startsWith(id));
      expect(placeholders, `${id} 没有待规划占位行`).toHaveLength(1);
      expect(placeholders[0].level).toBe(2);
      expect(placeholders[0].title).toBe("待规划");
    }
  });

  it("一级行的状态就是工序自己的状态 —— 没接入的三道在清单上如实显示 pending", () => {
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

/* ============================================================
   ⑦ 状态：phase 归属与失败传播
   ============================================================ */

describe("工序状态：按 phase 归属，失败要浮上来", () => {
  it("有 phase 的工序是 running（run 还在跑）", () => {
    const log = planningFromRun(
      src([phaseEvent(5, "spec"), phaseEvent(20, "generating"), phaseEvent(30, "checking")]),
    );
    const now = projectAt(log, maxSeq(log));

    expect(find(now, "spec").status).toBe("running");
    expect(find(now, "build").status).toBe("running");
    expect(find(now, "verify").status).toBe("running");
    // 没出现过 phase 的那三道，仍然是 pending
    for (const id of PLANNED_IDS) expect(find(now, id).status).toBe("pending");
  });

  it("phase 为 failed 时，失败落在**当前工序**上（这里是 build）", () => {
    /*
      failed 不是一道工序的名字，它是整条运行的终局标记 ——
      所以它必须落在「刚才在跑的那道工序」头上，而不是随便挑一道。
      这里的顺序取自真实路径：spec → generating → failed。
    */
    const log = planningFromRun(
      src([phaseEvent(5, "spec"), phaseEvent(20, "generating"), phaseEvent(30, "failed")]),
    );
    const now = projectAt(log, maxSeq(log));

    expect(find(now, "build").status).toBe("failed");
    // failed 之前的工序已经跑完了，如实记 done
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
    /*
      从库里读出来的历史事件往往就停在这一条上，而那时候调用方不一定还知道
      runStatus —— 所以投影必须自己认得「这次运行已经结束了」。
    */
    const log = planningFromRun(
      src([phaseEvent(5, "spec"), phaseEvent(20, "generating"), phaseEvent(50, "done")]),
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
    /*
      这是本条最容易被写错的地方，也是「不许撒谎」的另一面。

      这个代码库里 kind:"error" 大量用于**可降级**的场合：
        · spec-stage.ts:227  规格解析失败 → 降级成兜底规格，然后照样产出 spec；
        · spec-stage.ts:232  输出被截断 → 只提醒，继续往下走；
        · spec-stage.ts:250  规格写盘失败 → 注释里写明「写盘失败不降级」。
      见到 error 就一锤定音判失败，会把「降级后照样跑通」显示成失败 ——
      那是另一种撒谎（把做成了的说成没做成），而这个文件的存在就是为了不撒谎。
    */
    const log = planningFromRun(
      src([
        phaseEvent(5, "spec"),
        { seq: 8, kind: "error", payload: { kind: "error", message: "模型给出的规格没法解析" } },
        specEvent(10),
        phaseEvent(50, "done"),
      ]),
    );
    const now = projectAt(log, maxSeq(log));

    expect(find(now, "spec").status).toBe("done");
    // 规格条目还是照常长出来了
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

/* ============================================================
   ⑧ 纯函数
   ============================================================ */

describe("纯函数：不改输入，可重复", () => {
  it("同一份输入投影两次，结果完全一样", () => {
    const source = src([phaseEvent(5, "spec"), specEvent(10), checkEvent(20)], "done");
    expect(planningFromRun(source)).toEqual(planningFromRun(source));
  });

  it("不修改输入对象（stages / events 都没被就地改过）", () => {
    /*
      投影是「某一刻的快照」。调用方若就地改输入，就等于绕过日志改了历史 ——
      只增不改那条不变量当场破产。
    */
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