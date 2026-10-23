import { describe, expect, it } from "vitest";
import {
  artifactExists,
  attributeCost,
  buildPipelineGraph,
  gridSlot,
  isNodeInteractive,
  LAYOUT,
  nodeMetrics,
  nodeStatusLabel,
  nodeTone,
  rowCount,
  SPENDING_STAGE,
} from "@/core/pipeline/graph";
import { STAGES, type StageId } from "@/core/pipeline/stages";

/**
 * 这些测试守的是「图上不出现假信息」这条底线。
 * 图比列表更容易让人相信「这里真的有东西」，
 * 所以它比列表更不能画错。
 */
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
    // 原来的写法是「相邻两个节点 x 必须递增」——那只在单行时成立。
    // 改成两行之后，第四道工序回到第一列，x 反而变小了，
    // 于是这条断言失败。要保证的其实是「同一行内不重叠」。
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

/* ============================================================
   这一组是整份文件里最重要的
   ============================================================ */
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
      STAGES.map((s) => [s.id, 9.99]),
    ) as Partial<Record<StageId, number>>;
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
      costByStage: { build: 0.0256 },
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

describe("流水线图 · 运行状态映射", () => {
  it("跑完之后，已接入的工序显示已通过", () => {
    const g = buildPipelineGraph({ run: { stage: "verify", status: "done" } });
    expect(nodeTone(g.nodes.find((n) => n.id === "build")!)).toBe("passed");
    expect(nodeStatusLabel(g.nodes.find((n) => n.id === "build")!)).toContain("已通过");
  });

  it("失败时当前工序显示失败，已接入的后续工序仍是待执行", () => {
    const g = buildPipelineGraph({ run: { stage: "build", status: "failed" } });
    expect(nodeTone(g.nodes.find((n) => n.id === "build")!)).toBe("failed");
    // 这里要挑一个**已接入**的后续工序。
    // 最初我写的是 assemble，结果断言失败 —— 因为集成装配本身就是
    // 未接入的工序，它的色调正确就是 planned。
    // 是测试写错了，不是实现错了。
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