import { describe, expect, it } from "vitest";
import {
  FOREST_GEOMETRY,
  TREE_LEVELS,
  layoutForest,
  levelAt,
  type ForestGeometry,
  type LayoutNode,
} from "@/core/canvas/forest-layout";
import {
  CHILD_PLACEHOLDER,
  statusLabelOf,
  toForestNodes,
  type ChildrenByStage,
  type StageChild,
} from "@/core/pipeline/forest";
import type { StageId } from "@/core/pipeline/stages";

/**
 * 保护按深度定义尺寸：第 1 层六道工序用主卡尺寸、三层互不重叠、一行六个。
 * 不传 levels 时与以前逐字段相同，传了 levels 时也要对得上出厂的 TREE_LEVELS。
 */

/** 六道工序，顺序就是流水线顺序 */
const SIX: StageId[] = ["spec", "arch", "ui", "build", "assemble", "verify"];

/** 造一个子节点。布局只关心 id，别的字段填合法的占位值就够 */
function child(id: string, stage: StageId): StageChild {
  return {
    id,
    stage,
    label: id,
    detail: "",
    tone: "plain",
    reveal: "batch",
    statusLabel: statusLabelOf("plain"),
    chips: [CHILD_PLACEHOLDER],
    metric: CHILD_PLACEHOLDER,
  };
}

const kidsOf = (stage: StageId, n: number): StageChild[] =>
  Array.from({ length: n }, (_, i) => child(`${stage}:t${i}`, stage));

// 六道工序各挂 0~3 个子节点，折行与最后一行居中的边界都被走到。
const byStage: ChildrenByStage = {
  spec: kidsOf("spec", 0),
  arch: kidsOf("arch", 1),
  ui: kidsOf("ui", 2),
  build: kidsOf("build", 3),
  assemble: kidsOf("assemble", 2),
  verify: kidsOf("verify", 1),
};

/** 三层树：一个一级 Agent → 六道工序 → 各自的执行任务点 */
const TREE: LayoutNode[] = toForestNodes("agent-1", SIX, byStage);

// 第 0、1 层用主卡 240x156，第 2 层起子卡 232x112；六道工序一行六个。
const LEVELS: ForestGeometry = {
  ...FOREST_GEOMETRY,
  levels: {
    0: { w: 240, h: 156, perRow: 1 },
    1: { w: 240, h: 156, perRow: 6 },
    2: { w: 232, h: 112, perRow: 2 },
  },
};

const LAID = layoutForest(TREE, LEVELS);

/** 两个矩形是否重叠（容差 0 —— 贴边不算重叠）。写法和 canvas-forest-layout.test.ts 一致 */
function overlaps(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

describe("不传 levels 时与以前逐字段相同", () => {
  it("levels: {} 和不传 levels，整份 nodes 数组完全一致", () => {
    // levels 是可选项，没写和写空都必须走回原来那条路；比的是整份 nodes 数组。
    const before = layoutForest(TREE, FOREST_GEOMETRY);
    const after = layoutForest(TREE, { ...FOREST_GEOMETRY, levels: {} });

    expect(after.nodes).toEqual(before.nodes);
    expect(after.roots).toEqual(before.roots);
    expect(after.bounds).toEqual(before.bounds);
  });

  it("不传 levels 时 levelAt 就是「depth 0 用 root，其余用 child」", () => {
    expect(levelAt(FOREST_GEOMETRY, 0)).toEqual({
      ...FOREST_GEOMETRY.root,
      // root 上没有 gapY，它只能来自 child
      gapY: FOREST_GEOMETRY.child.gapY,
    });
    for (const depth of [1, 2, 5]) {
      expect(levelAt(FOREST_GEOMETRY, depth), `depth ${depth} 没退回 child`).toEqual(
        FOREST_GEOMETRY.child,
      );
    }
  });
});

describe("三层树的几何：第 1 层用主卡尺寸", () => {
  it("一级 Agent 是 240×156，depth 0，没有父节点，而且是唯一的根", () => {
    const root = LAID.byId.get("agent-1")!;
    expect({ w: root.w, h: root.h }).toEqual({ w: 240, h: 156 });
    expect(root.depth).toBe(0);
    expect(root.parentId).toBeNull();
    expect(LAID.roots).toHaveLength(1);
  });

  it("★ 六道工序每个都是 240×156 —— 这是这次改动的核心目的", () => {
    // 改之前 depth>=1 一律取 child，六张工序卡被画成执行点那么大；
    // 这条钉住第 1 层回到主卡尺寸，层级感不再消失。
    for (const id of SIX) {
      const n = LAID.byId.get(id)!;
      expect({ id, w: n.w, h: n.h }).toEqual({ id, w: 240, h: 156 });
      expect(n.depth).toBe(1);
      expect(n.parentId).toBe("agent-1");
    }
  });

  it("执行任务点是 232×112，depth 2，父节点是它所属的那道工序", () => {
    let seen = 0;
    for (const stage of SIX) {
      for (const k of byStage[stage] ?? []) {
        const n = LAID.byId.get(k.id)!;
        expect({ id: k.id, w: n.w, h: n.h }).toEqual({ id: k.id, w: 232, h: 112 });
        expect(n.depth).toBe(2);
        expect(n.parentId).toBe(stage);
        seen++;
      }
    }
    // 前提：确实查过子节点，否则循环体等于没跑
    expect(seen).toBe(9);
  });

  it("同一棵树不传 levels 时，六道工序仍然掉在 232×112 —— 说明上一条是 levels 起的作用", () => {
    // 前提断言：不传 levels 时这棵树仍是 232x112，上一条才有意义。
    const flat = layoutForest(TREE, FOREST_GEOMETRY);
    for (const id of SIX) {
      expect(flat.byId.get(id)!.w, `${id} 在不传 levels 时不该是主卡尺寸`).toBe(232);
      expect(flat.byId.get(id)!.h).toBe(112);
    }
  });

  it("★ 三层树里任意两个方块都不重叠", () => {
    // 尺寸一改，measure 与 place 最容易对不上，表现是方块叠在一起；
    // 这里查所有两两组合，不挑层级。
    const all = LAID.nodes;
    expect(all).toHaveLength(16); // 1 + 6 + 9，先把节点数钉住
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        expect(overlaps(all[i], all[j]), `${all[i].id} 和 ${all[j].id} 叠了`).toBe(false);
      }
    }
  });

  it("根节点的 subtree 含住这棵三层树里的每一个节点", () => {
    const root = LAID.byId.get("agent-1")!;
    for (const n of LAID.nodes) {
      expect(n.x).toBeGreaterThanOrEqual(root.subtree.x);
      expect(n.y).toBeGreaterThanOrEqual(root.subtree.y);
      expect(n.x + n.w).toBeLessThanOrEqual(root.subtree.x + root.subtree.w + 1e-9);
      expect(n.y + n.h).toBeLessThanOrEqual(root.subtree.y + root.subtree.h + 1e-9);
    }
  });
});

describe("六道工序排成一行", () => {
  it("y 相同，x 按流水线顺序从左到右", () => {
    const stages = SIX.map((id) => LAID.byId.get(id)!);
    expect(new Set(stages.map((n) => n.y)).size, "六道工序被折成了多行").toBe(1);

    expect([...stages].sort((a, b) => a.x - b.x).map((n) => n.id)).toEqual(SIX);
    for (let i = 1; i < stages.length; i++) {
      expect(
        stages[i].x,
        `${stages[i].id} 没有排在前一道的右边`,
      ).toBeGreaterThan(stages[i - 1].x);
    }
  });

  it("整行在根卡的中线上居中", () => {
    const root = LAID.byId.get("agent-1")!;
    const stages = SIX.map((id) => LAID.byId.get(id)!);
    const left = Math.min(...stages.map((n) => n.x));
    const right = Math.max(...stages.map((n) => n.x + n.w));
    expect((left + right) / 2).toBeCloseTo(root.x + root.w / 2, 6);
  });

  it("不传 levels 时同一棵树会折成 3 行 —— 「一行 6 个」是 levels 给的", () => {
    const flat = layoutForest(TREE, FOREST_GEOMETRY);
    expect(new Set(SIX.map((id) => flat.byId.get(id)!.y)).size).toBe(3);
  });
});

describe("toForestNodes 的形状", () => {
  it("只有一个根，六道工序都挂在它下面，顺序不变", () => {
    expect(TREE).toHaveLength(1);
    expect(TREE[0].id).toBe("agent-1");
    expect(TREE[0].children!.map((c) => c.id)).toEqual(SIX);
  });

  it("有子节点的工序把子节点挂上，id 原样带过去", () => {
    const ui = TREE[0].children!.find((c) => c.id === "ui")!;
    expect(ui.children!.map((c) => c.id)).toEqual(["ui:t0", "ui:t1"]);
  });

  it("没有子节点的工序不带 children 键（不是空数组）", () => {
    // 渲染层按 children !== undefined 判断要不要画展开箭头，
    // 空数组会给一道空工序画出指向虚无的箭头。
    const spec = TREE[0].children!.find((c) => c.id === "spec")!;
    expect("children" in spec).toBe(false);

    const bare = toForestNodes("agent-1", SIX, {});
    expect(bare).toHaveLength(1);
    expect(bare[0].children).toHaveLength(6);
    for (const s of bare[0].children!) {
      expect("children" in s, `${s.id} 带了 children 键`).toBe(false);
    }
  });

  it("节点上只有布局要的 id / children，没有别的字段混进去", () => {
    expect(Object.keys(TREE[0]).sort()).toEqual(["children", "id"]);
    expect(Object.keys(TREE[0].children![2]).sort()).toEqual(["children", "id"]);
  });
});

describe("TREE_LEVELS：画布真正用到的那份三层几何", () => {
  // 上面几组用的是本文件的本地副本，只能证明这套几何摆得对。
  // 这一组直接比出厂的 TREE_LEVELS，防止两边漂开而单测全绿。
  it("出厂的 TREE_LEVELS 就是本文件里那套（三层的尺寸和行数一个不差）", () => {
    expect(TREE_LEVELS).toEqual(LEVELS.levels);
  });

  it("拿出厂常量摆一遍，三层各自的尺寸/深度/行数都对得上", () => {
    const laid = layoutForest(TREE, { ...FOREST_GEOMETRY, levels: TREE_LEVELS });

    expect(laid.roots).toHaveLength(1);
    const root = laid.byId.get("agent-1")!;
    expect({ w: root.w, h: root.h, depth: root.depth }).toEqual({ w: 240, h: 156, depth: 0 });

    const stages = SIX.map((id) => laid.byId.get(id)!);
    for (const n of stages) expect({ id: n.id, w: n.w, h: n.h }).toEqual({ id: n.id, w: 240, h: 156 });
    expect(new Set(stages.map((n) => n.y)).size, "六道工序被折成了多行").toBe(1);

    const kids = SIX.flatMap((s) => byStage[s] ?? []).map((k) => laid.byId.get(k.id)!);
    expect(kids.length).toBe(9);
    for (const n of kids) expect({ id: n.id, w: n.w, h: n.h }).toEqual({ id: n.id, w: 232, h: 112 });

    // 六道工序自己那一行是 6x240 + 5x28，没有子节点时量最干净。
    // 有子树之后 measure 会按子树宽把兄弟撑开，见下一条。
    const bare = layoutForest(toForestNodes("agent-1", SIX, {}), {
      ...FOREST_GEOMETRY,
      levels: TREE_LEVELS,
    });
    const bareStages = SIX.map((id) => bare.byId.get(id)!);
    expect(Math.max(...bareStages.map((n) => n.x + n.w)) - Math.min(...bareStages.map((n) => n.x))).toBe(
      1580,
    );
    expect(bare.bounds.w).toBe(1580);

    // 带上子树后这一行会被各自的子树宽撑开；这里钉的是不失控（总宽 <= 2450），
    // 不是钉住某个具体数字。
    expect(laid.bounds.w).toBeLessThanOrEqual(2450);
    expect(laid.bounds.w).toBe(2336);
  });
});

describe("levelAt 解析规则", () => {
  it("只写 { w } 的那一层，h / gapX / perRow / gapY 逐字段退回默认", () => {
    const g: ForestGeometry = { ...FOREST_GEOMETRY, levels: { 2: { w: 300 } } };
    const lv = levelAt(g, 2);

    expect(lv).toEqual({ ...FOREST_GEOMETRY.child, w: 300 });
    expect(lv.h, "h 没有退回 child 的默认值").toBe(FOREST_GEOMETRY.child.h);
    expect(lv.gapX).toBe(FOREST_GEOMETRY.child.gapX);
    expect(lv.perRow).toBe(FOREST_GEOMETRY.child.perRow);
    expect(lv.gapY).toBe(FOREST_GEOMETRY.child.gapY);
  });

  it("depth 0 的基准是 root：只改 w 时，h 不会掉到 child 那一档去", () => {
    const g: ForestGeometry = { ...FOREST_GEOMETRY, levels: { 0: { w: 500 } } };
    expect(levelAt(g, 0)).toEqual({
      ...FOREST_GEOMETRY.root,
      w: 500,
      gapY: FOREST_GEOMETRY.child.gapY,
    });
    expect(levelAt(g, 0).h).toBe(FOREST_GEOMETRY.root.h);
  });

  it("深度不在 levels 里时整层退回 root / child", () => {
    const g: ForestGeometry = { ...FOREST_GEOMETRY, levels: { 1: { w: 999, perRow: 6 } } };

    expect(levelAt(g, 0)).toEqual({
      ...FOREST_GEOMETRY.root,
      gapY: FOREST_GEOMETRY.child.gapY,
    });
    expect(levelAt(g, 2)).toEqual(FOREST_GEOMETRY.child);

    // 前提：写进去的那一层真的生效了，否则上面两条是空转的
    expect(levelAt(g, 1)).toEqual({ ...FOREST_GEOMETRY.child, w: 999, perRow: 6 });
  });

  it("gapY 只有 child 上有，所以任何深度都默认取 child.gapY，除非那一层明写", () => {
    const g: ForestGeometry = { ...FOREST_GEOMETRY, levels: { 0: {}, 3: { gapY: 7 } } };
    expect(levelAt(g, 0).gapY).toBe(FOREST_GEOMETRY.child.gapY);
    expect(levelAt(g, 3).gapY).toBe(7);
  });
});