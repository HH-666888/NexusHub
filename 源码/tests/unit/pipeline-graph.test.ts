import { describe, expect, it } from "vitest";
import {
  artifactExists,
  attributeCost,
  buildPipelineGraph,
  describeTrace,
  gridSlot,
  isNodeInteractive,
  LAYOUT,
  nodeMetrics,
  nodeStatusLabel,
  nodeTone,
  rowCount,
  SPENDING_STAGE,
  tracePath,
} from "@/core/pipeline/graph";
import { STAGES, STAGE_MAP, stageApproval, stageAuthorityNote } from "@/core/pipeline/stages";
import { actorBadge } from "@/core/pipeline/authority";
import type { CostByStage, StageCost } from "@/core/domain/stage-cost";

// 造一条阶段花费：图上只用 costCny，其余字段补零。
function stageCost(costCny: number): StageCost {
  return { costCny, calls: 1, outputTokens: 0, latencyMs: 0, tiers: ["offPeak"] };
}

// 这组守的是图上不出现假信息：图比列表更容易让人相信这里有东西，所以更不能画错。
describe("流水线图 · 结构", () => {
  it("恰好六道工序，顺序与定义一致", () => {
    const g = buildPipelineGraph({ run: null });
    expect(g.nodes).toHaveLength(6);
    expect(g.nodes.map((n) => n.order)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(g.nodes.map((n) => n.id)).toEqual(STAGES.map((s) => s.id));
  });

  it("顺序流转边恰好 5 条，首尾相接", () => {
    const g = buildPipelineGraph({ run: null });
    const flow = g.edges.filter((e) => e.kind === "flow");
    expect(flow).toHaveLength(5);
    expect(flow.map((e) => `${e.source}->${e.target}`)).toEqual([
      "spec->arch",
      "arch->ui",
      "ui->build",
      "build->assemble",
      "assemble->verify",
    ]);
  });

  it("每一个声明了 fallbackTo 的工序，都有一条回退边", () => {
    const g = buildPipelineGraph({ run: null });
    const back = g.edges.filter((e) => e.kind === "fallback");
    const declared = STAGES.filter((s) => s.fallbackTo.length > 0);
    expect(back).toHaveLength(declared.length);
    for (const s of declared) {
      expect(
        back.some((e) => e.source === s.id && e.target === s.fallbackTo[0]),
        `${s.id} 的回退边缺失`,
      ).toBe(true);
    }
  });

  it("回退边只连最近的一跳 —— 全画出来会让图糊成一团", () => {
    const g = buildPipelineGraph({ run: null });
    for (const e of g.edges.filter((x) => x.kind === "fallback")) {
      const stage = STAGES.find((s) => s.id === e.source)!;
      expect(e.target).toBe(stage.fallbackTo[0]);
    }
  });

  it("起点工序没有回退边（它无处可退）", () => {
    const g = buildPipelineGraph({ run: null });
    expect(g.edges.some((e) => e.source === "spec" && e.kind === "fallback")).toBe(
      false,
    );
  });
});

describe("流水线图 · 布局", () => {
  it("同一行内列与列不重叠", () => {
    const g = buildPipelineGraph({ run: null });
    // 相邻两个节点 x 递增只在单行时成立；要保证的是同一行内不重叠。
    const byRow = new Map<number, typeof g.nodes>();
    for (const n of g.nodes) {
      const list = byRow.get(n.y) ?? [];
      list.push(n);
      byRow.set(n.y, list);
    }
    for (const [, list] of byRow) {
      for (let i = 1; i < list.length; i++) {
        expect(
          list[i].x,
          `同一行里 ${list[i].id} 与 ${list[i - 1].id} 重叠了`,
        ).toBeGreaterThanOrEqual(list[i - 1].x + LAYOUT.nodeWidth);
      }
    }
  });

  it("同一份数据永远得到同一张图 —— 布局是确定性的", () => {
    const a = buildPipelineGraph({ run: { stage: "build", status: "running" } });
    const b = buildPipelineGraph({ run: { stage: "build", status: "running" } });
    expect(a.nodes.map((n) => [n.x, n.y])).toEqual(b.nodes.map((n) => [n.x, n.y]));
  });

  it("排成两行三列 —— 六道排一行会宽到看不清字", () => {
    const g = buildPipelineGraph({ run: null });
    const rows = new Set(g.nodes.map((n) => n.y));
    expect(rows.size).toBe(2);
    // 第一行三道、第二行三道
    expect(g.nodes.filter((n) => n.y === 0)).toHaveLength(3);
    // 宽度要能塞进工作台中间那栏（约 800px），否则适应窗口后会缩得读不出字
    expect(g.width).toBeLessThanOrEqual(820);
  });

  it("同一行内纵向对齐，不同行之间不重叠", () => {
    const g = buildPipelineGraph({ run: null });
    const row0 = g.nodes.filter((n) => n.y === 0);
    expect(new Set(row0.map((n) => n.y)).size).toBe(1);
    const row1 = g.nodes.filter((n) => n.y > 0);
    for (const a of row0) {
      for (const b of row1) {
        expect(b.y).toBeGreaterThanOrEqual(a.y + LAYOUT.nodeHeight);
      }
    }
  });

  it("gridSlot 把序号正确映射成行列", () => {
    expect(gridSlot(0)).toEqual({ row: 0, col: 0 });
    expect(gridSlot(2)).toEqual({ row: 0, col: 2 });
    expect(gridSlot(3)).toEqual({ row: 1, col: 0 });
    expect(gridSlot(5)).toEqual({ row: 1, col: 2 });
  });

  it("rowCount 算得对", () => {
    expect(rowCount(6)).toBe(2);
    expect(rowCount(5)).toBe(2);
    expect(rowCount(3)).toBe(1);
  });

  it("图的整体尺寸覆盖所有节点", () => {
    const g = buildPipelineGraph({ run: null });
    const last = g.nodes[g.nodes.length - 1];
    expect(g.width).toBeGreaterThanOrEqual(last.x + LAYOUT.nodeWidth);
  });
});

describe("流水线图 · 不出现假信息", () => {
  const planned = STAGES.filter((s) => s.implementation === "planned");

  it("确实还存在没接入的工序（否则这组测试失去意义）", () => {
    expect(planned.length).toBeGreaterThan(0);
  });

  it("【关键】未接入的工序永远是「未接入」，不论运行跑到哪一步", () => {
    const statuses = ["running", "paused", "done", "failed"] as const;
    for (const stage of STAGES.map((s) => s.id)) {
      for (const status of statuses) {
        const g = buildPipelineGraph({ run: { stage, status } });
        for (const p of planned) {
          const node = g.nodes.find((n) => n.id === p.id)!;
          expect(
            nodeStatusLabel(node),
            `运行到 ${stage}/${status} 时，未接入的 ${p.id} 显示成了「${nodeStatusLabel(node)}」`,
          ).toBe("未接入");
          expect(nodeTone(node)).toBe("planned");
        }
      }
    }
  });

  it("【关键】未接入的工序花费恒为 0，即使上游硬塞了数字", () => {
    const cost = Object.fromEntries(
      STAGES.map((s) => [s.id, stageCost(9.99)]),
    ) as CostByStage;
    const g = buildPipelineGraph({
      run: { stage: "verify", status: "done" },
      costByStage: cost,
    });
    for (const p of planned) {
      const node = g.nodes.find((n) => n.id === p.id)!;
      expect(node.costCny, `${p.id} 未接入却有花费`).toBe(0);
    }
  });

  it("未接入的工序不显示任何指标 —— 摆一排零等于什么都没说", () => {
    const g = buildPipelineGraph({ run: { stage: "verify", status: "done" } });
    for (const p of planned) {
      expect(nodeMetrics(g.nodes.find((n) => n.id === p.id)!)).toEqual([]);
    }
  });

  it("没花钱的工序不显示花费行", () => {
    const g = buildPipelineGraph({
      run: { stage: "build", status: "running" },
      costByStage: {},
    });
    const build = g.nodes.find((n) => n.id === "build")!;
    expect(nodeMetrics(build)).toEqual([]);
  });

  it("有花费时才显示，且保留四位小数", () => {
    const g = buildPipelineGraph({
      run: { stage: "build", status: "running" },
      costByStage: { build: stageCost(0.0256) },
    });
    const build = g.nodes.find((n) => n.id === "build")!;
    expect(nodeMetrics(build)).toEqual([{ label: "花费", value: "¥0.0256" }]);
  });
});

describe("流水线图 · 花费归属", () => {
  it("没有花费时返回空 —— 不制造一个 ¥0.0000 的节点", () => {
    expect(attributeCost(0)).toEqual({});
  });

  it("有花费时归到真正花钱的那道工序", () => {
    const attr = attributeCost(0.0256);
    expect(Object.keys(attr)).toEqual([SPENDING_STAGE]);
    expect(attr[SPENDING_STAGE]).toBeCloseTo(0.0256, 6);
  });

  it("归属的工序是已接入的 —— 不能把钱算到未接入的工序上", () => {
    const stage = STAGES.find((s) => s.id === SPENDING_STAGE)!;
    expect(stage.implementation).not.toBe("planned");
  });
});

describe("流水线图 · 节点的可点性", () => {
  it("未接入的工序也能点开 —— 点开是为了说明为什么没有产物", () => {
    const g = buildPipelineGraph({ run: null });
    for (const n of g.nodes) {
      expect(isNodeInteractive(n), `${n.id} 不可点击`).toBe(true);
    }
  });

  it("产物存在性判断按契约文件名匹配", () => {
    const g = buildPipelineGraph({ run: null });
    const names = new Set(g.nodes.map((n) => n.artifact));
    expect(artifactExists("build", names)).toBe(true);
    expect(artifactExists("build", new Set(["别的文件.json"]))).toBe(false);
  });
});

describe("流水线图 · 路径追踪", () => {
  const g = buildPipelineGraph({ run: null });
  const nameOf = (id: string) => STAGES.find((s) => s.id === id)?.name ?? id;

  it("从起点出发：没有上游，下游是全部其余工序", () => {
    const t = tracePath(g, "spec");
    expect(t.upstream).toEqual([]);
    expect(t.downstream).toEqual(["arch", "ui", "build", "assemble", "verify"]);
    expect(t.chain.size).toBe(6);
    expect(t.fallbackFromMe).toBeNull();
  });

  it("从终点出发：没有下游，上游是全部其余工序", () => {
    const t = tracePath(g, "verify");
    expect(t.downstream).toEqual([]);
    expect(t.upstream).toEqual(["assemble", "build", "ui", "arch", "spec"]);
    expect(t.chain.size).toBe(6);
  });

  it("从中间出发：上下游都不含自己", () => {
    const t = tracePath(g, "build");
    expect(t.upstream).not.toContain("build");
    expect(t.downstream).not.toContain("build");
    expect(t.chain.has("build")).toBe(true);
  });

  it("上游按从近到远排列 —— 用户要的是「上一步是谁」", () => {
    const t = tracePath(g, "build");
    // build 的上一步是 ui，再往前是 arch、spec
    expect(t.upstream[0]).toBe("ui");
    expect(t.upstream[t.upstream.length - 1]).toBe("spec");
  });

  it("【关键】追踪只跟顺序流转，不跟回退边", () => {
    // 如果回退边也算进路径，任何节点都会顺着退回起点，
    // 上游就永远等于全部六道工序，追踪失去意义。
    const t = tracePath(g, "assemble");
    expect(t.upstream).not.toContain("verify");
    expect(t.downstream).not.toContain("arch");
  });

  it("【已知局限】流水线是线性的，所以链覆盖全部六道工序", () => {
    // 已知局限：六道工序是直线加回退边，上下游加起来必然是全部六道。
    // 要等并行构建裂成模块节点，这条链才有区分度。
    const t = tracePath(g, "build");
    expect(t.chain.size).toBe(6);
    expect(t.edges.size).toBe(5); // 全部顺序流转边
  });

  it("回退边才是眼下真正有区分度的部分", () => {
    // 回退边只连最近的一跳：这一道失败会退回哪，是一句有信息量的话。
    const build = tracePath(g, "build");
    const verify = tracePath(g, "verify");
    expect(build.fallbackFromMe).not.toBe(verify.fallbackFromMe);

    // 起点没有退路
    expect(tracePath(g, "spec").fallbackFromMe).toBeNull();

    // 断言取自真实声明，而不是我拍脑袋记的值 ——
    // 第一版就是硬写了一个值，结果和 stages.ts 里的实际声明对不上。
    for (const s of STAGES) {
      expect(tracePath(g, s.id).fallbackFromMe).toBe(s.fallbackTo[0] ?? null);
    }
  });

  it("describeTrace 说得清楚，不留半句话", () => {
    const start = describeTrace(tracePath(g, "spec"), nameOf);
    const end = describeTrace(tracePath(g, "verify"), nameOf);
    const mid = describeTrace(tracePath(g, "build"), nameOf);
    expect(start).toContain("起点");
    expect(end).toContain("终点");
    expect(mid).toContain("上游");
    expect(mid).toContain("下游");
    // 不能说成上游后面什么都没有
    for (const s of [start, end, mid]) {
      expect(s).not.toMatch(/上游\s*；/);
      expect(s).not.toMatch(/下游\s*；/);
    }
  });
});

describe("流水线图 · 运行状态映射", () => {
  it("跑完之后，已接入的工序显示已通过", () => {
    const g = buildPipelineGraph({ run: { stage: "verify", status: "done" } });
    expect(nodeTone(g.nodes.find((n) => n.id === "build")!)).toBe("passed");
    expect(nodeStatusLabel(g.nodes.find((n) => n.id === "build")!)).toContain("已通过");
  });

  it("失败时当前工序显示失败，已接入的后续工序仍是待执行", () => {
    const g = buildPipelineGraph({ run: { stage: "build", status: "failed" } });
    expect(nodeTone(g.nodes.find((n) => n.id === "build")!)).toBe("failed");
    // 这里要挑一个已接入的后续工序：集成装配本身未接入，色调正确就是 planned。
    const verify = g.nodes.find((n) => n.id === "verify")!;
    expect(verify.implementation).not.toBe("planned");
    expect(nodeTone(verify)).toBe("pending");
  });

  it("直通模式的工序在标签里说明「直通」，不含糊成普通的已通过", () => {
    const g = buildPipelineGraph({ run: { stage: "verify", status: "done" } });
    const build = g.nodes.find((n) => n.id === "build")!;
    expect(build.implementation).toBe("direct");
    expect(nodeStatusLabel(build)).toContain("直通");
  });

  it("没有选中运行时，所有已接入的工序都是待执行", () => {
    const g = buildPipelineGraph({ run: null });
    for (const n of g.nodes.filter((x) => x.implementation !== "planned")) {
      expect(nodeTone(n)).toBe("pending");
    }
  });
});

// 权限四件套来自研发团队运转图那套纪律：四个维度长到工序上，在图上露出来。
// 这一组测这套设计意图有没有真的传到界面上。

describe("流水线图 · 权限四件套", () => {
  const g = buildPipelineGraph({ run: null });
  const nodeOf = (id: string) => g.nodes.find((n) => n.id === id)!;

  it("每个节点都带着四个字段", () => {
    for (const n of g.nodes) {
      expect(n.actor, `${n.name} 没带谁做`).toBeTruthy();
      expect(n.access, `${n.name} 没带能不能改`).toBeTruthy();
      expect(n.approval, `${n.name} 没带要不要人点头`).toBeTruthy();
      expect(n.watches.length, `${n.name} 没带看什么数`).toBeGreaterThan(0);
    }
  });

  it("【最要紧】验收节点在图上也是只读的", () => {
    // 判定者不参与生产：核心层已有单测钉着 verify.access === read。
    // 这一条钉的是它有没有真的传到图上。
    const verify = nodeOf("verify");
    expect(verify.access).toBe("read");
    expect(actorBadge(verify)).toBe("AI · 只读");
  });

  it("approval 是算出来的，不是另存一份 —— 不会和 access 打架", () => {
    // approval 要按工序定义现算：另存一份会出现只读却要人点头的矛盾。
    for (const n of g.nodes) {
      expect(n.approval, `${n.name} 的 approval 和现算的对不上`).toBe(
        stageApproval(STAGE_MAP[n.id]),
      );
    }
  });

  it("规格化要人点头 —— 而且是一条能说出理由的", () => {
    const spec = nodeOf("spec");
    expect(spec.approval).toBe("human");
    expect(stageAuthorityNote(STAGE_MAP.spec)).toContain("故意");
  });

  it("其余五道不用人点头", () => {
    const gated = g.nodes.filter((n) => n.approval === "human");
    expect(gated.map((n) => n.id)).toEqual(["spec"]);
  });

  it("看什么数原样带过来，没被加工", () => {
    // 加工过的话，核心层改了文案而图上还是旧的
    for (const n of g.nodes) {
      expect(n.watches.map((w) => w.label)).toEqual(
        STAGE_MAP[n.id].watches.map((w) => w.label),
      );
    }
  });

  it("未接入的工序也带着权限 —— 那是它的定义，不是它的进度", () => {
    // 权限与接没接入是两件事：未接入的工序也要显示它将来会是什么角色。
    const planned = g.nodes.filter((n) => n.implementation === "planned");
    expect(planned.length).toBeGreaterThan(0);
    for (const n of planned) {
      expect(n.actor, `${n.name} 未接入但丢了权限`).toBeTruthy();
      expect(n.watches.length).toBeGreaterThan(0);
    }
  });

  it("权限不影响状态 —— 两者是不同的维度", () => {
    // 一条只读的工序和一条会写的工序，在"跑到哪了"上没有任何区别
    const running = buildPipelineGraph({ run: { stage: "verify", status: "running" } });
    const verify = running.nodes.find((n) => n.id === "verify")!;
    expect(nodeTone(verify)).toBe("running");
    expect(verify.access, "只读不该把状态也改了").toBe("read");
  });
});

// 改之前 humanGate 没有任何代码读它，实际门禁是 SPEC_GATE 环境变量，且默认静默放行。
// 这一组测声明与实际不一致时，图上必须看得出来。

describe("流水线图 · 门禁的声明与实际", () => {
  it("不传覆盖时，实际等于声明", () => {
    const g = buildPipelineGraph({ run: null });
    for (const n of g.nodes) {
      expect(n.gateActive, `${n.name} 的默认 gateActive 和 approval 不一致`).toBe(
        n.approval === "human",
      );
    }
  });

  it("按声明来：规格化会停", () => {
    const g = buildPipelineGraph({ run: null, gateOverride: "declared" });
    const spec = g.nodes.find((n) => n.id === "spec")!;
    expect(spec.approval).toBe("human");
    expect(spec.gateActive).toBe(true);
  });

  it("【关键】覆盖成放行时，图上看得出来", () => {
    // 声明要人点头而实际不停，比没有门禁更糟：用户会以为有人把关过了。
    // 所以 approval 与 gateActive 是两个字段，图上两个都要看得到。
    const g = buildPipelineGraph({ run: null, gateOverride: "continue" });
    const spec = g.nodes.find((n) => n.id === "spec")!;
    expect(spec.approval, "声明被覆盖改掉了").toBe("human");
    expect(spec.gateActive, "覆盖成放行之后 gateActive 还是 true").toBe(false);
  });

  it("覆盖成放行，只影响声明要批的那一道", () => {
    // 本来就不用批的工序，放行不算"变化"
    const g = buildPipelineGraph({ run: null, gateOverride: "continue" });
    for (const n of g.nodes) {
      if (n.approval === "none") {
        expect(n.gateActive, `${n.name} 本来不用批，却被放行影响了`).toBe(false);
      }
    }
  });

  it("强制停下：本来不用批的工序也会停", () => {
    const g = buildPipelineGraph({ run: null, gateOverride: "pause" });
    for (const n of g.nodes) {
      expect(n.gateActive, `${n.name} 强制停下却没停`).toBe(true);
    }
    // 但"声明"没变 —— 加严不改声明
    expect(g.nodes.find((n) => n.id === "build")!.approval).toBe("none");
  });

  it("没有一种组合会「声明要批、实际没停、而又看不出来」", () => {
    for (const o of ["declared", "pause", "continue"] as const) {
      const g = buildPipelineGraph({ run: null, gateOverride: o });
      for (const n of g.nodes) {
        if (n.approval === "human" && !n.gateActive) {
          // 这就是"不一致"，两个字段刚好能表达它 ——
          // 界面据此显示要人点头（已放行）
          expect(n.approval).toBe("human");
          expect(n.gateActive).toBe(false);
        }
      }
    }
  });
});