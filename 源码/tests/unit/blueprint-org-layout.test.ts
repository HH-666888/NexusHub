import { describe, expect, it } from "vitest";
import {
  DEFAULT_ORG_GEOMETRY,
  bottomOf,
  layoutOrg,
  orgEdgePath,
  topOf,
  type PlacedOrgNode,
} from "@/core/blueprint/org-layout";
import type { OrgNode, OrgTree } from "@/core/blueprint/org";

/** 造一棵树：root → hub → domains 个领域 → 每个领域 leaves 个资产 */
function treeOf(domains: number, leaves: number): OrgTree {
  const asset = (i: number, j: number): OrgNode => ({
    id: `d${i}-a${j}`,
    role: `资产 ${i}-${j}`,
    actions: [],
    watches: [{ label: "构建" }],
    actor: "program",
    children: [],
  });

  return {
    root: {
      id: "owner",
      role: "我",
      actions: ["定方向"],
      watches: [],
      actor: "human",
      children: [
        {
          id: "hub",
          role: "编排 Agent",
          actions: ["派活"],
          watches: [],
          actor: "ai",
          children: Array.from({ length: domains }, (_, i) => ({
            id: `d${i}`,
            role: `领域 ${i}`,
            actions: ["看一眼"],
            watches: [{ label: "指标" }],
            actor: "ai" as const,
            children: Array.from({ length: leaves }, (_, j) => asset(i, j)),
          })),
        },
      ],
    },
    links: [],
  };
}

const g = DEFAULT_ORG_GEOMETRY;

function find(nodes: PlacedOrgNode[], id: string): PlacedOrgNode {
  const hit = nodes.find((n) => n.node.id === id);
  if (!hit) throw new Error(`布局里没有 ${id}`);
  return hit;
}

describe("组织图布局 · 层级结构", () => {
  it("根在最上面，总管在它下面", () => {
    const l = layoutOrg(treeOf(4, 2));
    const root = find(l.nodes, "owner");
    const hub = find(l.nodes, "hub");
    expect(root.y).toBe(0);
    expect(hub.y).toBeGreaterThan(root.y + root.h - 1);
    expect(root.kind).toBe("root");
    expect(hub.kind).toBe("hub");
  });

  it("领域卡在同一行上 —— 它们是横向并列的分工", () => {
    const l = layoutOrg(treeOf(4, 2));
    const ys = [0, 1, 2, 3].map((i) => find(l.nodes, `d${i}`).y);
    expect(new Set(ys).size, "四个领域的 y 不一致，说明没排成一行").toBe(1);
  });

  it("领域卡横向依次排开，互不重叠", () => {
    const l = layoutOrg(treeOf(4, 2));
    for (let i = 0; i < 3; i++) {
      const a = find(l.nodes, `d${i}`);
      const b = find(l.nodes, `d${i + 1}`);
      expect(b.x, `第 ${i} 和第 ${i + 1} 列重叠了`).toBeGreaterThanOrEqual(a.x + a.w);
    }
  });

  it("同一列的资产竖着排，互不重叠", () => {
    const l = layoutOrg(treeOf(3, 4));
    for (let j = 0; j < 3; j++) {
      const a = find(l.nodes, `d1-a${j}`);
      const b = find(l.nodes, `d1-a${j + 1}`);
      expect(b.y).toBeGreaterThanOrEqual(a.y + a.h);
    }
  });

  it("不同列的资产互不重叠（横向）", () => {
    const l = layoutOrg(treeOf(3, 2));
    const a = find(l.nodes, "d0-a0");
    const b = find(l.nodes, "d1-a0");
    expect(b.x).toBeGreaterThanOrEqual(a.x + a.w);
  });

  it("资产卡在它所属领域的下方，且落在那一列的范围里", () => {
    const l = layoutOrg(treeOf(4, 3));
    for (let i = 0; i < 4; i++) {
      const agent = find(l.nodes, `d${i}`);
      const asset = find(l.nodes, `d${i}-a0`);
      expect(asset.y).toBeGreaterThanOrEqual(agent.y + agent.h);
      // 横向不越出所属那一列
      expect(asset.x).toBeGreaterThanOrEqual(agent.x);
      expect(asset.x + asset.w).toBeLessThanOrEqual(agent.x + agent.w + 1);
    }
  });
});

describe("组织图布局 · 居中与尺寸", () => {
  it("根和总管都横向居中", () => {
    const l = layoutOrg(treeOf(5, 2));
    const root = find(l.nodes, "owner");
    const hub = find(l.nodes, "hub");
    expect(root.x + root.w / 2).toBeCloseTo(l.width / 2, 6);
    expect(hub.x + hub.w / 2).toBeCloseTo(l.width / 2, 6);
  });

  it("宽度 = 列数 × 卡宽 + 缝隙", () => {
    const l = layoutOrg(treeOf(4, 2));
    expect(l.width).toBe(4 * g.nodeW + 3 * g.colGap);
  });

  it("列数跟着领域数走 —— 这是和闭环图最大的差别", () => {
    // 闭环图是固定九宫格；组织图的列数由生成决定
    expect(layoutOrg(treeOf(3, 1)).columns).toBe(3);
    expect(layoutOrg(treeOf(6, 1)).columns).toBe(6);
    expect(layoutOrg(treeOf(6, 1)).width).toBeGreaterThan(layoutOrg(treeOf(3, 1)).width);
  });

  it("高度装得下所有节点", () => {
    const l = layoutOrg(treeOf(4, 5));
    for (const n of l.nodes) {
      expect(n.y + n.h).toBeLessThanOrEqual(l.height);
      expect(n.x + n.w).toBeLessThanOrEqual(l.width + 1);
    }
  });

  it("高的那一列决定整张图多高", () => {
    const t = treeOf(2, 1);
    // 给第二列多加几张资产
    t.root.children[0].children[1].children.push(
      { id: "extra1", role: "多的 1", actions: [], watches: [{ label: "x" }], actor: "program", children: [] },
      { id: "extra2", role: "多的 2", actions: [], watches: [{ label: "x" }], actor: "program", children: [] },
    );
    const l = layoutOrg(t);
    expect(find(l.nodes, "extra2").y + g.leafH).toBeCloseTo(l.height, 6);
  });
});

describe("组织图布局 · 只有根 / 只有一层", () => {
  it("只有根时不崩，也不摆出多余的东西", () => {
    const solo: OrgTree = {
      root: { id: "me", role: "我", actions: [], watches: [], actor: "human", children: [] },
      links: [],
    };
    const l = layoutOrg(solo);
    expect(l.nodes).toHaveLength(1);
    expect(l.nodes[0].kind).toBe("root");
    expect(l.columns).toBe(1);
  });

  it("根直接挂着多个领域（没有中间总管）时也排得开", () => {
    /*
      参考图上根和领域之间有一层总管，但生成出来的树未必有。
      没有中间层时，横排的就是根的直接子节点。
    */
    const flat: OrgTree = {
      root: {
        id: "me",
        role: "我",
        actions: [],
        watches: [],
        actor: "human",
        children: [
          { id: "a", role: "甲", actions: [], watches: [{ label: "x" }], actor: "ai", children: [] },
          { id: "b", role: "乙", actions: [], watches: [{ label: "x" }], actor: "ai", children: [] },
        ],
      },
      links: [],
    };
    const l = layoutOrg(flat);
    expect(l.columns).toBe(2);
    expect(find(l.nodes, "a").y).toBe(find(l.nodes, "b").y);
  });

  it("根只有一个孩子、孩子有多个孩子时，横排的是孙辈", () => {
    // 多一层中间节点时，横排的应当是"最靠上的那层分叉"
    const l = layoutOrg(treeOf(4, 1));
    // hub 是中间层，横排的是它的四个孩子
    expect(l.columns).toBe(4);
    expect(find(l.nodes, "hub").x + find(l.nodes, "hub").w / 2).toBeCloseTo(l.width / 2, 6);
  });
});

describe("组织图布局 · 连线", () => {
  it("端点取自底边和顶边的中点", () => {
    const l = layoutOrg(treeOf(3, 2));
    const hub = find(l.nodes, "hub");
    const d0 = find(l.nodes, "d0");
    expect(bottomOf(hub)).toEqual({ x: hub.x + hub.w / 2, y: hub.y + hub.h });
    expect(topOf(d0)).toEqual({ x: d0.x + d0.w / 2, y: d0.y });
  });

  it("【关键】走的是肘形，不是斜线", () => {
    /*
      总管居中、领域散开，画直线的话会是一把斜扇形。
      参考图上是一束：竖直下来一小段、横向走同一条走廊、再竖直下去。
      肘形让所有线共享同一段水平走廊 —— 那是"一束"的来源。
    */
    const l = layoutOrg(treeOf(4, 2));
    const hub = find(l.nodes, "hub");
    const d3 = find(l.nodes, "d3");
    const d = orgEdgePath(hub, d3, g);

    const pts = [...d.matchAll(/[ML] ([\d.-]+) ([\d.-]+)/g)].map((m) => ({
      x: Number(m[1]),
      y: Number(m[2]),
    }));
    expect(pts, "肘形要有四个点").toHaveLength(4);
    // 中间那两个点 y 相同（共享水平走廊）
    expect(pts[1].y).toBeCloseTo(pts[2].y, 9);
    // 第一个点正下方接着第二个点（先竖直走）
    expect(pts[0].x).toBeCloseTo(pts[1].x, 9);
  });

  it("【关键】所有到领域的线共享同一条水平走廊", () => {
    // 不共享的话就不是"一束"，而是一把散开的斜线
    const l = layoutOrg(treeOf(5, 1));
    const hub = find(l.nodes, "hub");
    const busYs = [0, 1, 2, 3, 4].map((i) => {
      const d = orgEdgePath(hub, find(l.nodes, `d${i}`), g);
      const pts = [...d.matchAll(/[ML] ([\d.-]+) ([\d.-]+)/g)].map((m) => Number(m[2]));
      return pts[1];
    });
    expect(new Set(busYs.map((y) => y.toFixed(3))).size, "走廊不在同一条水平线上").toBe(1);
  });

  it("走廊落在两层之间", () => {
    const l = layoutOrg(treeOf(3, 1));
    const hub = find(l.nodes, "hub");
    const d0 = find(l.nodes, "d0");
    const path = orgEdgePath(hub, d0, g);

    /*
      ⚠️ 取的是**第二个**顶点，不是第一个。
      路径是 `M 起点 L 走廊 L 走廊 L 终点` ——
      第一个 `M … L` 匹配到的是起点（总管底边），
      拿它当走廊去比"大于总管底边"永远不成立。
      第一版就是这么写的，报错是 "expected 174 to be greater than 174" ——
      两个数一样，说明取的根本是同一个点。
    */
    const ys = [...path.matchAll(/[ML] [\d.-]+ ([\d.-]+)/g)].map((m) => Number(m[1]));
    const busY = ys[1];
    expect(busY).toBeGreaterThan(hub.y + hub.h);
    expect(busY).toBeLessThan(d0.y);
  });

  it("路径是合法的 SVG", () => {
    const l = layoutOrg(treeOf(2, 1));
    const d = orgEdgePath(find(l.nodes, "hub"), find(l.nodes, "d0"), g);
    expect(d).toMatch(/^M [\d.-]+ [\d.-]+( L [\d.-]+ [\d.-]+){3}$/);
  });
});