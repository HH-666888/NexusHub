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
 * 还没接入的工序。
 * 从 STAGES 自己的 implementation 字段算出来（progress.ts 用的是同一个判断），
 * 而不是在这里写死 "assemble" —— 写死的话，
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
  it("只有 spec 和 check 事件时，还没接入的工序仍是 pending，且一个子节点都没有", () => {
    /*
      这是整个文件最要紧的一条断言。

      界面上写着「已通过」却拿不出产物，比直接写「未接入」严重得多 ——
      评委问一句「架构定型的产物给我看看」就会当场穿帮。
      所以这里断的是两件事：
        · 状态还是 pending（没有进展，也没有完成）；
        · 名下一个执行点都没有（不是「有计划但还没跑」，是**压根没接入**）。
      第二件比第一件更狠：状态可以被一次误算改掉，而「一个点都没长出来」
      说明这次运行里确实没有任何东西能支撑起这些工序。
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

    // 还没接入的工序，正是 STAGES 自己声明为 planned 的那些
    /*
      ⚠️ 这一条是**必须改**的（本期改动的现有断言之一，另一条在
         pipeline-stages.test.ts 的「运行完成时…」里）。

      原来期望 ["ui", "assemble"]。这一期「界面设计」接上了
      （stages.ts 里 implementation 从 planned 改成 wired），
      所以按 implementation 动态取出来的未接入名单里不再有 ui。

      这不是放松：**动态取名单**这个写法本身没变 ——
      哪天 assemble 也接上了，这里会自动变成空数组，而不是继续拿旧名单断言。
      而 ui 那条底线一点没丢：下面新增的那组用例单独守着
      「已接入、但这一次没有留下任何痕迹的工序」同样必须停在 pending
      （见文件末尾「★ 诚实底线也适用于已接入的 ui」那一条）。
    */
    expect(PLANNED_IDS).toEqual(["assemble"]);
  });

  it("runStatus 为 done 时，还没接入的工序仍然 pending —— 有产出的才配 done", () => {
    /*
      单独一条用例，因为这是最容易写错的地方：
      「run 都成功了，那六道肯定都跑完了吧」—— 这个推断看起来无害，
      实际上会让从没跑过的工序显示成已完成。
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
      所以它和还没接入的 assemble 一样停在 pending。
    */
    expect(find(now, "build").status).toBe("pending");
  });

  it("runStatus 为 failed 时，还没接入的工序仍然是 pending（失败也不许波及无关工序）", () => {
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
  it("六道工序是 level 1，检查项是 level 2，还没接入的工序出现 placeholder 的待规划行", () => {
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

    // 还没接入的工序：一行「待规划」的占位行，界面画成浅色虚线
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
    // 没出现过 phase 的工序，仍然是 pending
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

/* ============================================================
   ⑨ 架构定型 → 模块子树（「清单自己长出子树」就在这里）
   ============================================================
   这一组是本期的核心证据：**一行 UI 都不用改**，左侧清单里
   「架构定型」那一道下面长出了它的模块。

   它成立的全部原因是数据侧做了两件事：
     一、from-run.ts 把 arch 事件投影成 `arch:<模块id>` 的任务点
         （parentId="arch"、depth=2 —— 正是 toOutline 认的二级行）；
     二、outline.ts 本来就有的规则：一级行**有二级子节点时不再补占位行**。
   也就是说，"长出子树"不是新写的界面逻辑，而是同一条老规则
   在数据变多之后自然得到的结果。

   ── 取材 ──
     模块划分是真的能被检查器接受的那种（依赖指向存在的模块、无环、
     覆盖规格里每一条功能），而 check 用**真的 inspectArch 现算**，
     不手抄一份结果 —— 手抄的 check 迟早和检查器漂开，
     那时候这些断言验的就是另一件事了。
   ============================================================ */

/** 一份能被三条检查全过的架构。条目 id 从 SPEC 里取，不手写 */
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

/** 现算的三条检查（全过） */
const ARCH_CHECK = inspectArch(ARCH, SPEC);

/** arch 事件：架构产物落地。结构照 arch-stage.ts 真正发出的那条写 */
function archEvent(seq: number, check: unknown = ARCH_CHECK): RawEvent {
  return {
    seq,
    kind: "arch",
    payload: { kind: "arch", arch: ARCH, check, fallback: false },
  };
}

/** 此刻 arch 名下的模块点 */
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
    // 标题是人可读的模块名，而不是 id
    expect(kids.map((k) => k.title)).toEqual(ARCH.modules.map((m) => m.name));
    expect(hasOrphans(projectAt(log, 30))).toBe(false);
  });

  it("到点生成：第 29 刻一个模块点都没有，第 30 刻全在 —— 出生时刻就是那条 arch 事件的 seq", () => {
    /*
      不另算一个序号（比如 maxSeq+1）：那种算法在乱序追加时会给出
      「早于自己声明的出生时刻」的点，而 projectAt 的到点语义按 bornAtSeq 判。
    */
    const log = planningFromRun(src([archEvent(30)]));

    expect(ids(archPointsAt(log, 29))).toEqual([]);
    expect(archPointsAt(log, 30).map((p) => p.bornAtSeq)).toEqual(
      new Array(ARCH.modules.length).fill(30),
    );

    const other = planningFromRun(src([archEvent(77)]));
    for (const p of archPointsAt(other, 100)) expect(p.bornAtSeq).toBe(77);
  });

  it("三条检查全过 → done；有不过的 → failed（★ 模块没有「执行」过，绝不给 running）", () => {
    /*
      ── 状态口径与理由（这一期自定的一处口径，写在这里免得下一个人猜）──
        模块是**将来**第四道要并行去做的事，此刻没有任何人在做它，
        所以 running 是错的（用户会坐着等一件没人开始的事）。
        而三条本地检查是**真的判过**的：
          · 全过 → done：这个模块划分被架构定型接受了；
          · 有不过的 → failed：保守方向不能反 —— 显示成没过，用户最多多看一眼。
    */
    const passing = planningFromRun(src([archEvent(30)]));
    for (const kid of archPointsAt(passing, 30)) {
      expect(kid.status, `${kid.id} 三条检查全过却没显示成 done`).toBe("done");
    }

    // 造一份**真的过不了**检查的架构（引用了不存在的模块），检查结果用真检查器现算
    const broken: ArchSpec = {
      modules: [{ ...ARCH.modules[0], dependsOn: ["ghost"] }, ARCH.modules[1]],
      packages: [],
    };
    const brokenCheck = inspectArch(broken, SPEC);
    expect(brokenCheck.passed).toBeLessThan(brokenCheck.total); // 前提：这份夹具确实没过

    const log = planningFromRun(
      src([{ seq: 30, kind: "arch", payload: { kind: "arch", arch: broken, check: brokenCheck } }]),
    );
    const kids = archPointsAt(log, 30);
    expect(kids).toHaveLength(broken.modules.length);
    for (const kid of kids) {
      expect(kid.status, `${kid.id} 检查没过却显示成 ${kid.status}`).toBe("failed");
      // 无论哪一档，都不许是 running —— 这一条是本节的口径本身
      expect(kid.status).not.toBe("running");
    }
  });

  it("读不到检查结果时不硬说它过了：按 failed（保守方向不能反）", () => {
    /*
      事件是从数据库那行 JSON 还原出来的，payload 残缺是可能的。
      读不出"三条都过了"就说"过了"，等于替一个来路不明的产物背书。

      ⚠️ 这里逐个手写 payload，**不用上面那个 archEvent 助手** ——
         它给 check 了一个默认值（全过的那份），走它的话
         "完全没有 check 字段"这种情况根本造不出来，这条测试就永远绿着。
    */
    const payloads: Array<{ label: string; payload: unknown }> = [
      { label: "完全没有 check 字段", payload: { kind: "arch", arch: ARCH } },
      { label: "check 是 null", payload: { kind: "arch", arch: ARCH, check: null } },
      { label: "check 是空对象", payload: { kind: "arch", arch: ARCH, check: {} } },
      { label: "results 是 null", payload: { kind: "arch", arch: ARCH, check: { results: null } } },
      { label: "results 是空数组", payload: { kind: "arch", arch: ARCH, check: { results: [] } } },
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
    expect(kids.map((k) => k.bornAtSeq)).toEqual(new Array(ARCH.modules.length).fill(30));
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
      expect(archPointsAt(log, 100), `payload=${JSON.stringify(payload)} 时凭空造了点`).toEqual(
        [],
      );
    }
  });
});

describe("★ 串一遍 projectAt → toOutline：清单里 arch 那道自己长出了子树", () => {
  it("有 arch 事件时：不再有「待规划」占位行，而是逐个列出模块", () => {
    /*
      ★★★ 这就是「清单自己长出子树」的硬证据 ★★★

      三件事一起断言，缺一条这个证据就不成立：
        ① 清单里 arch 那一道**一个占位行都没有**了；
        ② 它下面**真的列出了每个模块**（id / 标题 / 层级都对得上）；
        ③ 二级行的状态是 done（三条检查全过）—— 不是随手的绿点。

      注意①必须和下面那条"没有 arch 事件时占位行还在"的对照一起看：
      否则"没有占位行"也可能是因为规则被改掉了，而不是因为长出了子树。
    */
    const log = planningFromRun(src([specEvent(10), archEvent(20)]));
    const rows = toOutline(projectAt(log, maxSeq(log)));

    // ① 占位行没了
    const archPlaceholders = rows.filter((r) => r.placeholder && r.id.startsWith("arch"));
    expect(archPlaceholders, "arch 那道还有待规划占位行 —— 子树没长出来").toEqual([]);

    // ② 列出来的就是那几个模块
    const archRows = rows.filter((r) => r.id.startsWith("arch:"));
    expect(archRows.map((r) => r.id)).toEqual(ARCH.modules.map((m) => `arch:${m.id}`));
    expect(archRows.map((r) => r.title)).toEqual(ARCH.modules.map((m) => m.name));
    for (const row of archRows) {
      expect(row.level).toBe(2);
      expect(row.placeholder).toBe(false);
      expect(row.status).toBe("done");
      // 二级实体行是可点的：canvasNodeId 就是它自己的 id
      expect(row.canvasNodeId).toBe(row.id);
    }

    // arch 那一级行本身照旧在场，顺序不变（六道工序的位置不该被新子树动到）
    const level1 = rows.filter((r) => r.level === 1);
    expect(level1.map((r) => r.id)).toEqual(STAGE_INPUT.map((s) => s.id));
  });

  it("对照：没有 arch 事件的运行，arch 那道**仍然是**「待规划」占位行", () => {
    /*
      这一条是上一条的对照组，防的是"断言永远为真"：
      如果 outline.ts 哪天被改成"一级行一律不补占位行"，
      上面那条会照样绿，而它想守的"子树长出来了"其实什么都没验到。
    */
    const log = planningFromRun(src([specEvent(10), checkEvent(20)]));
    const rows = toOutline(projectAt(log, maxSeq(log)));

    const archPlaceholders = rows.filter((r) => r.placeholder && r.id.startsWith("arch"));
    expect(archPlaceholders).toHaveLength(1);
    expect(archPlaceholders[0].title).toBe("待规划");
    expect(archPlaceholders[0].level).toBe(2);
    // 而且一个模块点都没有 —— 没有事件就是没有，不是"有计划但没跑"
    expect(rows.filter((r) => r.id.startsWith("arch:"))).toEqual([]);
  });

  it("★ 诚实底线也适用于已接入的 arch：这一次没跑过就仍然是 pending、名下无子点", () => {
    /*
      arch 这一期从 planned 改成 wired 了（stages.ts）。
      「已接入」描述的是**这道工序有没有实现**，不是"这一次跑没跑过"。
      所以拿一条只有 spec + check 事件的运行去问它，答案必须是 pending ——
      这正是 progress.ts 里那条规则在投影层的同一条（见文件头那段）。

      这一条单独写，是因为它是"接线之后最容易顺手破坏"的一处：
      「都接上了，那把六道工序都标成跑过了吧」这种推断看起来无害。
    */
    const log = planningFromRun(src([specEvent(10), checkEvent(20)], "done"));
    const now = projectAt(log, maxSeq(log));

    expect(find(now, "arch").status).toBe("pending");
    expect(childrenOf(now, "arch")).toHaveLength(0);
    // 而且日志里根本没有针对它的状态事件 —— 我们从未碰过它
    expect(statusEventsFor(log, "arch")).toHaveLength(0);
  });
});

/* ============================================================
   ⑩ 界面设计 → 页面子树（「清单**继续**自己长」就在这里）
   ============================================================
   这一组与上面那组（架构 → 模块子树）是同一件事的第二次发生：
   数据侧多投影了一种事件，清单上就多长出一层子树 ——
   一行界面代码都不用改。

   它成立的全部原因还是那两条：
     一、from-run.ts 把 ui 事件投影成 `ui:<页面id>` 的任务点
         （parentId="ui"、depth=2 —— 正是 toOutline 认的二级行）；
     二、outline.ts 本来就有的规则：一级行**有二级子节点时不再补占位行**。

   ── 取材 ──
     界面设计是真的能被检查器接受的那种（页面覆盖规格里每一条功能、
     组件只引用定义过的变量、dataNeeds 写的是架构里真实的模块 id），
     而 check 用**真的 inspectUi 现算**，不手抄一份结果 ——
     手抄的 check 迟早和检查器漂开，那时候这些断言验的就是另一件事了。
   ============================================================ */

/** 一份能被三条检查全过的界面设计。条目 id 从 SPEC 里取，模块从 ARCH 里取 */
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
      // 按模块 **id** 匹配
      dataNeeds: [ARCH.modules[0].id],
    },
    {
      id: "archive",
      name: "归档页",
      route: "/archive",
      coversFeatures: SPEC.acceptance.slice(2).map((a) => a.id),
      // 按模块 **名称** 匹配 —— 两种写法都要算对上
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

/** 现算的三条检查（全过） */
const UI_CHECK = inspectUi(UI_SPEC, SPEC, ARCH);

/** ui 事件：界面设计产物落地。结构照 ui-stage.ts 真正发出的那条写 */
function uiEvent(seq: number, check: unknown = UI_CHECK): RawEvent {
  return {
    seq,
    kind: "ui",
    payload: { kind: "ui", ui: UI_SPEC, check, fallback: false },
  };
}

/** 此刻 ui 名下的页面点 */
function uiPointsAt(log: readonly PlanningEvent[], seq: number): TaskPoint[] {
  return projectAt(log, seq).filter((p) => p.id.startsWith("ui:"));
}

describe("界面设计 → 页面任务点", () => {
  it("夹具自身成立：三条本地检查全过（由真的 inspectUi 现算）", () => {
    // 夹具要是过不了检查，下面"状态是 done"那条验到的就是另一档
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
    // 标题是人可读的页面名，而不是 id
    expect(kids.map((k) => k.title)).toEqual(UI_SPEC.pages.map((p) => p.name));
    expect(hasOrphans(projectAt(log, 30))).toBe(false);
  });

  it("到点生成：第 29 刻一个页面点都没有，第 30 刻全在 —— 出生时刻就是那条 ui 事件的 seq", () => {
    /*
      不另算一个序号（比如 maxSeq+1）：那种算法在乱序追加时会给出
      「早于自己声明的出生时刻」的点，而 projectAt 的到点语义按 bornAtSeq 判。
    */
    const log = planningFromRun(src([uiEvent(30)]));

    expect(ids(uiPointsAt(log, 29))).toEqual([]);
    expect(uiPointsAt(log, 30).map((p) => p.bornAtSeq)).toEqual(
      new Array(UI_SPEC.pages.length).fill(30),
    );

    const other = planningFromRun(src([uiEvent(77)]));
    for (const p of uiPointsAt(other, 100)) expect(p.bornAtSeq).toBe(77);
  });

  it("三条检查全过 → done；有不过的 → failed（★ 页面没有「执行」过，绝不给 running）", () => {
    /*
      ── 状态口径与理由（这一期自定的一处口径，写在这里免得下一个人猜）──
        页面是**将来**第四道要去做的事，此刻没有任何人在做它，
        所以 running 是错的（用户会坐着等一件没人开始的事）。
        而三条本地检查是**真的判过**的：
          · 全过 → done：这个页面划分被界面设计接受了；
          · 有不过的 → failed：保守方向不能反 —— 显示成没过，用户最多多看一眼。
        这和上面 arch 模块点的口径是同一档，理由也同一档：两者都是
        "第四道要干的活"，都在产出的那一刻就已经被判过了。
    */
    const passing = planningFromRun(src([uiEvent(30)]));
    for (const kid of uiPointsAt(passing, 30)) {
      expect(kid.status, `${kid.id} 三条检查全过却没显示成 done`).toBe("done");
    }

    // 造一份**真的过不了**检查的界面设计（页面漏掉了两条功能），检查结果用真检查器现算
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
      src([{ seq: 30, kind: "ui", payload: { kind: "ui", ui: broken, check: brokenCheck } }]),
    );
    const kids = uiPointsAt(log, 30);
    expect(kids).toHaveLength(broken.pages.length);
    for (const kid of kids) {
      expect(kid.status, `${kid.id} 检查没过却显示成 ${kid.status}`).toBe("failed");
      // 无论哪一档，都不许是 running —— 这一条是本节的口径本身
      expect(kid.status).not.toBe("running");
    }
  });

  it("读不到检查结果时不硬说它过了：按 failed（保守方向不能反）", () => {
    /*
      事件是从数据库那行 JSON 还原出来的，payload 残缺是可能的。
      读不出"三条都过了"就说"过了"，等于替一个来路不明的产物背书。

      ⚠️ 这里逐个手写 payload，**不用上面那个 uiEvent 助手** ——
         它给 check 了一个默认值（全过的那份），走它的话
         "完全没有 check 字段"这种情况根本造不出来，这条测试就永远绿着。
    */
    const payloads: Array<{ label: string; payload: unknown }> = [
      { label: "完全没有 check 字段", payload: { kind: "ui", ui: UI_SPEC } },
      { label: "check 是 null", payload: { kind: "ui", ui: UI_SPEC, check: null } },
      { label: "check 是空对象", payload: { kind: "ui", ui: UI_SPEC, check: {} } },
      { label: "results 是 null", payload: { kind: "ui", ui: UI_SPEC, check: { results: null } } },
      { label: "results 是空数组", payload: { kind: "ui", ui: UI_SPEC, check: { results: [] } } },
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
    // 只报阶段、还没有产出：此刻一个页面点都不该有
    expect(uiPointsAt(log, 12)).toEqual([]);
  });

  it("同一条 ui 事件到来两次：页面点只出生一次（appendBorn 幂等）", () => {
    const log = planningFromRun(src([uiEvent(30), uiEvent(45)]));
    const kids = uiPointsAt(log, 100);

    expect(kids).toHaveLength(UI_SPEC.pages.length);
    expect(kids.map((k) => k.bornAtSeq)).toEqual(new Array(UI_SPEC.pages.length).fill(30));
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
      expect(uiPointsAt(log, 100), `payload=${JSON.stringify(payload)} 时凭空造了点`).toEqual(
        [],
      );
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

describe("★ 串一遍 projectAt → toOutline：清单里 ui 那道也自己长出了子树", () => {
  it("有 ui 事件时：不再有「待规划」占位行，而是逐个列出页面", () => {
    /*
      ★★★ 这就是「清单继续自己长出子树」的硬证据 ★★★

      三件事一起断言，缺一条这个证据就不成立：
        ① 清单里 ui 那一道**一个占位行都没有**了；
        ② 它下面**真的列出了每个页面**（id / 标题 / 层级都对得上）；
        ③ 二级行的状态是 done（三条检查全过）—— 不是随手的绿点。

      注意①必须和下面那条"没有 ui 事件时占位行还在"的对照一起看：
      否则"没有占位行"也可能是因为规则被改掉了，而不是因为长出了子树。
    */
    const log = planningFromRun(src([specEvent(10), archEvent(20), uiEvent(30)]));
    const rows = toOutline(projectAt(log, maxSeq(log)));

    // ① 占位行没了
    const uiPlaceholders = rows.filter((r) => r.placeholder && r.id.startsWith("ui"));
    expect(uiPlaceholders, "ui 那道还有待规划占位行 —— 子树没长出来").toEqual([]);

    // ② 列出来的就是那几个页面
    const uiRows = rows.filter((r) => r.id.startsWith("ui:"));
    expect(uiRows.map((r) => r.id)).toEqual(UI_SPEC.pages.map((p) => `ui:${p.id}`));
    expect(uiRows.map((r) => r.title)).toEqual(UI_SPEC.pages.map((p) => p.name));
    for (const row of uiRows) {
      expect(row.level).toBe(2);
      expect(row.placeholder).toBe(false);
      expect(row.status).toBe("done");
      // 二级实体行是可点的：canvasNodeId 就是它自己的 id
      expect(row.canvasNodeId).toBe(row.id);
    }

    // ui 那一级行本身照旧在场，顺序不变（六道工序的位置不该被新子树动到）
    const level1 = rows.filter((r) => r.level === 1);
    expect(level1.map((r) => r.id)).toEqual(STAGE_INPUT.map((s) => s.id));

    // 两棵子树同时在：arch 的模块行也没被挤掉
    expect(rows.filter((r) => r.id.startsWith("arch:")).length).toBe(ARCH.modules.length);
  });

  it("对照：没有 ui 事件的运行，ui 那道**仍然是**「待规划」占位行", () => {
    /*
      这一条是上一条的对照组，防的是"断言永远为真"：
      如果 outline.ts 哪天被改成"一级行一律不补占位行"，
      上面那条会照样绿，而它想守的"子树长出来了"其实什么都没验到。
    */
    const log = planningFromRun(src([specEvent(10), checkEvent(20)]));
    const rows = toOutline(projectAt(log, maxSeq(log)));

    const uiPlaceholders = rows.filter((r) => r.placeholder && r.id.startsWith("ui"));
    expect(uiPlaceholders).toHaveLength(1);
    expect(uiPlaceholders[0].title).toBe("待规划");
    expect(uiPlaceholders[0].level).toBe(2);
    // 而且一个页面点都没有 —— 没有事件就是没有，不是"有计划但没跑"
    expect(rows.filter((r) => r.id.startsWith("ui:"))).toEqual([]);
  });

  it("★ 诚实底线也适用于已接入的 ui：这一次没跑过就仍然是 pending、名下无子点", () => {
    /*
      ui 这一期从 planned 改成 wired 了（stages.ts）。
      「已接入」描述的是**这道工序有没有实现**，不是"这一次跑没跑过"。
      所以拿一条只有 spec + arch + check 事件的运行去问它，答案必须是 pending ——
      这正是 progress.ts 里那条规则在投影层的同一条（见文件头那段）。

      这一条单独写，是因为它是"接线之后最容易顺手破坏"的一处：
      「都接上了，那把六道工序都标成跑过了吧」这种推断看起来无害。
    */
    const log = planningFromRun(src([specEvent(10), archEvent(20), checkEvent(25)], "done"));
    const now = projectAt(log, maxSeq(log));

    expect(find(now, "ui").status).toBe("pending");
    expect(childrenOf(now, "ui")).toHaveLength(0);
    // 而且日志里根本没有针对它的状态事件 —— 我们从未碰过它
    expect(statusEventsFor(log, "ui")).toHaveLength(0);
  });
});

/* ============================================================
   ⑪ 并行构建 → 模块构建子树（第四道**第一次**有了自己的子树）
   ============================================================
   前两组（arch → 模块、ui → 页面）长出的是"将来要做的活"；
   这一组长出的是"**刚刚做过的活**"，而且它带一栏前两组没有的东西：
   **失败**。

   这一组要守住两件事：
     一、`build` 那道下面真的长出 `build:<模块id>`，而不是一行「待规划」；
     二、`failed[]` 里的模块**显示成 failed** —— 部分失败如实呈现。

   取材：事件的载荷由产品自己的 summarizeBatch 现算
   （`{ kind: "modules", batch: summarizeBatch(batch, ARCH) }`），
   而不是在这里手抄一份摘要的形状 —— 抄一份的话，
   摘要字段改了而这里没改，夹具就会变成"现实里不可能出现"的东西。
   ============================================================ */

/** 一个成功的 ModuleBuild（字段齐全，好让 summarizeBatch 原样带出名字与花费） */
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

/**
 * 一批真实的构建结果：task-store 成功、board-ui 失败。
 *
 * ⚠️ 故意让**成功的和失败的各一个**：全是成功的话，
 *    "失败模块显示 failed"这条最要紧的口径根本验不到。
 */
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

/** modules 事件：载荷照 route.ts 真正发出的那条写（summarizeBatch 现算） */
function modulesEvent(seq: number, batch: BuildBatch = BUILD_BATCH): RawEvent {
  return { seq, kind: "modules", payload: { kind: "modules", batch: summarizeBatch(batch, ARCH) } };
}

/** 此刻 build 名下的模块构建点 */
function buildPointsAt(log: readonly PlanningEvent[], seq: number): TaskPoint[] {
  return projectAt(log, seq).filter((p) => p.id.startsWith("build:"));
}

describe("并行构建 → 模块构建任务点（含失败那一栏）", () => {
  it("每个模块长出一个 depth 2 的点，挂在 build 下面，id 形如 build:<模块id>", () => {
    const log = planningFromRun(src([archEvent(20), modulesEvent(30)]));
    const kids = buildPointsAt(log, 30);

    // 成功的和失败的各一个 —— 两个都要有点，少一个就是"粉饰"
    expect(ids(kids)).toEqual(["build:task-store", "build:board-ui"]);

    for (const kid of kids) {
      expect(kid.parentId).toBe("build");
      expect(kid.depth).toBe(2);
      expect(kid.kind).toBe("exec");
      expect(kid.bornAtSeq).toBe(30);
    }
    // 标题是人可读的模块名，**从 arch 查**（不是事件里那份副本）
    expect(kids.map((k) => k.title)).toEqual(ARCH.modules.map((m) => m.name));
    expect(hasOrphans(projectAt(log, 30))).toBe(false);
  });

  it("★ 失败模块 → failed，成功模块 → done；绝不给 running（构建已经结束了）", () => {
    /*
      ★★★ 这一条是"部分失败如实呈现"的硬证据 ★★★

      口径：batch.modules → done，batch.failed → failed。
      把失败抹成"没提过"是这一期最不能做的事：
      用户会以为模块都做完了，而产物里少了一整块功能，
      账上还少了那次调用的钱。

      顺带钉住"不许给 running"：构建在事件到达的这一刻已经结束了，
      这里没有任何东西还在跑 —— 给 running 会让用户坐着等一件没人开始的事。
    */
    const log = planningFromRun(src([archEvent(20), modulesEvent(30)]));
    const kids = buildPointsAt(log, 30);
    const byId = new Map(kids.map((k) => [k.id, k.status]));

    expect(byId.get("build:task-store")).toBe("done");
    expect(byId.get("build:board-ui")).toBe("failed");
    for (const kid of kids) expect(kid.status).not.toBe("running");
  });

  it("失败的模块也带着原因进了摘要，而不是只剩一个红点", () => {
    // 事件载荷里要有 message：不然界面上只有一个红点，说不出为什么红
    const payload = modulesEvent(30).payload as { batch: { failed: { moduleId: string; message: string; name: string }[] } };
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

  it("顺序按 **arch** 排，而不是按事件里「成功在前、失败在后」的顺序", () => {
    /*
      事件载荷天然是"成功的先列、失败的在后"（summarizeBatch 就是这么攒的）。
      照它排的话，清单里 build 那一组的顺序会和上面 arch 那一组对不上 ——
      同一个模块在两处位置不同，用户就没法对着看。
    */
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
    // 顺序按 arch，状态按各自的事实：改成失败的那个才是 failed
    expect(now[0].status).toBe("failed");
    expect(now[1].status).toBe("done");
  });

  it("modules 事件让第四道真的动起来：运行结束时它是 done，而不是停在 pending", () => {
    const running = planningFromRun(src([archEvent(20), modulesEvent(30)]));
    expect(find(projectAt(running, 30), "build").status).toBe("running");

    const doneLog = planningFromRun(src([archEvent(20), modulesEvent(30), phaseEvent(60, "done")]));
    const now = projectAt(doneLog, maxSeq(doneLog));
    expect(find(now, "build").status).toBe("done");
    expect(childrenOf(now, "build")).toHaveLength(2);
  });

  it("phase:building 也归第四道（不是只在产出事件时才认它）", () => {
    const log = planningFromRun(src([archEvent(20), phaseEvent(25, "building")]));
    const now = projectAt(log, 25);

    expect(find(now, "build").status).toBe("running");
    // 只是开工，还没有产物 —— 所以一个 build:* 的点都不该有
    expect(childrenOf(now, "build")).toHaveLength(0);
  });

  it("没有 arch 事件时标题退到事件里的那份名字，最后才退到模块 id", () => {
    // 只有 modules 事件（arch 事件丢了）：名字用载荷里那一份，绝不留空白标题
    const log = planningFromRun(src([modulesEvent(30)]));
    const kids = buildPointsAt(log, 30);
    expect(kids.map((k) => k.title)).toEqual(ARCH.modules.map((m) => m.name));
  });

  it("同一条 modules 事件到来两次：点只出生一次（appendBorn 幂等）", () => {
    const log = planningFromRun(src([archEvent(20), modulesEvent(30), modulesEvent(45)]));
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
      expect(buildPointsAt(log, 100), `payload=${JSON.stringify(payload)} 时凭空造了点`).toEqual(
        [],
      );
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

describe("★ 串一遍 projectAt → toOutline：清单里 build 那道自己长出了子树", () => {
  it("有 modules 事件时：不再有「待规划」占位行，而是逐个列出模块构建结果", () => {
    /*
      ★★★ 这一期的"清单长出子树"第三次发生 ★★★
      前两次是 arch → 模块、ui → 页面，这一次是 build → 模块构建结果。

      前两次那批点说的是"将来要做"，这一批说的是"刚刚做成没成"——
      所以它多了失败这一档，而这一档必须在清单上看得见。
    */
    const log = planningFromRun(src([specEvent(10), archEvent(20), modulesEvent(30)]));
    const rows = toOutline(projectAt(log, maxSeq(log)));

    // ① 占位行没了
    const buildPlaceholders = rows.filter((r) => r.placeholder && r.id.startsWith("build"));
    expect(buildPlaceholders, "build 那道还有待规划占位行 —— 子树没长出来").toEqual([]);

    // ② 列出来的就是那几个模块，id / 标题 / 层级都对得上
    const buildRows = rows.filter((r) => r.id.startsWith("build:"));
    expect(buildRows.map((r) => r.id)).toEqual(["build:task-store", "build:board-ui"]);
    expect(buildRows.map((r) => r.title)).toEqual(ARCH.modules.map((m) => m.name));
    for (const row of buildRows) {
      expect(row.level).toBe(2);
      expect(row.placeholder).toBe(false);
      expect(row.canvasNodeId).toBe(row.id);
    }

    // ③ ★ 失败模块在清单上是 failed —— 部分失败如实呈现 ★
    const statusOf = new Map(buildRows.map((r) => [r.id, r.status]));
    expect(statusOf.get("build:task-store")).toBe("done");
    expect(statusOf.get("build:board-ui")).toBe("failed");

    // ④ build 那一级行本身照旧在场，六道工序的顺序不变
    const level1 = rows.filter((r) => r.level === 1);
    expect(level1.map((r) => r.id)).toEqual(STAGE_INPUT.map((s) => s.id));

    // ⑤ 三棵子树同时在：前面两道的行也没被挤掉
    expect(rows.filter((r) => r.id.startsWith("arch:")).length).toBe(ARCH.modules.length);
  });

  it("对照：没有 modules 事件的运行，build 那道**仍然是**「待规划」占位行", () => {
    /*
      这一条是上一条的对照组，防的是"断言永远为真"：
      如果 outline.ts 哪天被改成"一级行一律不补占位行"，
      上面那条会照样绿，而它想守的"子树长出来了"其实什么都没验到。
    */
    const log = planningFromRun(src([specEvent(10), archEvent(20), checkEvent(25)]));
    const rows = toOutline(projectAt(log, maxSeq(log)));

    const buildPlaceholders = rows.filter((r) => r.placeholder && r.id.startsWith("build"));
    expect(buildPlaceholders).toHaveLength(1);
    expect(buildPlaceholders[0].title).toBe("待规划");
    expect(buildPlaceholders[0].level).toBe(2);
    // 而且一个模块构建点都没有 —— 没有事件就是没有，不是"有计划但没跑"
    expect(rows.filter((r) => r.id.startsWith("build:"))).toEqual([]);
  });

  it("★ 诚实底线也适用于第四道：这一次没跑过就仍然是 pending、名下无子点", () => {
    const log = planningFromRun(src([specEvent(10), archEvent(20), checkEvent(25)], "done"));
    const now = projectAt(log, maxSeq(log));

    expect(find(now, "build").status).toBe("pending");
    expect(childrenOf(now, "build")).toHaveLength(0);
    expect(statusEventsFor(log, "build")).toHaveLength(0);
  });
});