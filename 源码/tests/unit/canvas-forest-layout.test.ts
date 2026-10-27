import { describe, expect, it } from "vitest";
import {
  FOREST_GEOMETRY,
  isNewNode,
  layoutForest,
  lerpLayout,
  treeLinks,
  type ForestGeometry,
  type LayoutNode,
} from "@/core/canvas/forest-layout";
import {
  FALLBACK_DROP as OLD_DROP,
  nodeRect,
  pipelineBounds,
  pipelineWidth,
  WIDE_GEOMETRY,
} from "@/core/canvas/pipeline-layout";

/**
 * 保护森林布局：没有子树时与旧布局逐像素一致、子树撑开兄弟、连线不穿方块、插值动画。
 * 回归锚排第一：改布局时任何意外位移都要当场变红。
 */

const G: ForestGeometry = FOREST_GEOMETRY;

/** 造一个没有子树的六道工序 */
const pipeline = (names: string[]): LayoutNode[] => names.map((id) => ({ id }));

const SIX = ["spec", "arch", "ui", "build", "assemble", "verify"];

/** 两个矩形是否重叠（容差 0 —— 贴边不算重叠） */
function overlaps(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

describe("没有子树时与旧布局一致", () => {
  it("六个节点的位置逐个相同", () => {
    const laid = layoutForest(pipeline(SIX), G);
    const total = SIX.length;
    for (let i = 0; i < total; i++) {
      const old = nodeRect(i, total, WIDE_GEOMETRY);
      const now = laid.byId.get(SIX[i])!;
      expect({ x: now.x, y: now.y, w: now.w, h: now.h }, `第 ${i + 1} 个节点变了`).toEqual(old);
    }
  });

  it("包围盒的宽和旧的 pipelineWidth 相同", () => {
    const laid = layoutForest(pipeline(SIX), G);
    expect(laid.bounds.w).toBe(pipelineWidth(SIX.length, WIDE_GEOMETRY));
  });

  it("包围盒的左上角就是第一个节点的左上角", () => {
    const laid = layoutForest(pipeline(SIX), G);
    const first = nodeRect(0, SIX.length, WIDE_GEOMETRY);
    expect(laid.bounds.x).toBe(first.x);
    expect(laid.bounds.y).toBe(first.y);
  });

  it("高度和旧的 pipelineBounds 相同", () => {
    // 旧 pipelineBounds 与新 bounds 都含 FALLBACK_DROP，这里核一次相等。
    const laid = layoutForest(pipeline(SIX), G);
    expect(laid.bounds.h).toBe(pipelineBounds(SIX.length, WIDE_GEOMETRY).h);
  });

  it("包围盒比节点区多出一个 FALLBACK_DROP —— 回退弧线不能被切在屏幕外", () => {
    // 守的不是两个常量相等（同一处定义由编译器保证），而是那个值真的被加进包围盒。
    // 回退弧线不能被切在屏幕外。
    const laid = layoutForest(pipeline(SIX), G);
    const nodeBottom = Math.max(...laid.nodes.map((n) => n.y + n.h));
    expect(laid.bounds.y + laid.bounds.h - nodeBottom).toBe(OLD_DROP);
  });

  it("空森林不炸，也不返回 NaN", () => {
    const laid = layoutForest([], G);
    expect(laid.nodes).toEqual([]);
    expect(laid.roots).toEqual([]);
    expect(Number.isFinite(laid.bounds.x)).toBe(true);
  });
});

describe("一棵子树", () => {
  const tree: LayoutNode[] = [
    { id: "spec", children: [{ id: "s1" }, { id: "s2" }, { id: "s3" }] },
  ];

  it("子节点摆在父节点下面", () => {
    const laid = layoutForest(tree, G);
    const parent = laid.byId.get("spec")!;
    for (const id of ["s1", "s2", "s3"]) {
      const kid = laid.byId.get(id)!;
      expect(kid.y, `${id} 没有在父节点下面`).toBeGreaterThanOrEqual(parent.y + parent.h);
      expect(kid.depth).toBe(1);
      expect(kid.parentId).toBe("spec");
    }
  });

  it("整行子节点在父节点的中线上居中", () => {
    const laid = layoutForest(tree, G);
    const parent = laid.byId.get("spec")!;
    const kids = ["s1", "s2", "s3"].map((id) => laid.byId.get(id)!);
    const left = Math.min(...kids.map((k) => k.x));
    const right = Math.max(...kids.map((k) => k.x + k.w));
    expect((left + right) / 2).toBeCloseTo(parent.x + parent.w / 2, 6);
  });

  it("每行 2 个 —— 3 个子节点排成 2 行", () => {
    const laid = layoutForest(tree, G);
    const ys = ["s1", "s2", "s3"].map((id) => laid.byId.get(id)!.y);
    expect(ys[0]).toBe(ys[1]);
    expect(ys[2]).toBeGreaterThan(ys[0]);
  });

  it("父节点的 subtree 含住自己和全部子节点", () => {
    const laid = layoutForest(tree, G);
    const p = laid.byId.get("spec")!;
    for (const id of ["spec", "s1", "s2", "s3"]) {
      const n = laid.byId.get(id)!;
      expect(n.x).toBeGreaterThanOrEqual(p.subtree.x);
      expect(n.y).toBeGreaterThanOrEqual(p.subtree.y);
      expect(n.x + n.w).toBeLessThanOrEqual(p.subtree.x + p.subtree.w + 1e-9);
      expect(n.y + n.h).toBeLessThanOrEqual(p.subtree.y + p.subtree.h + 1e-9);
    }
  });

  it("childCount 是直接子节点数", () => {
    const laid = layoutForest(tree, G);
    expect(laid.byId.get("spec")!.childCount).toBe(3);
    expect(laid.byId.get("s1")!.childCount).toBe(0);
  });
});

describe("自动扩展", () => {
  it("某一棵长出子树之后，它和右边的兄弟被推开了", () => {
    const before = layoutForest(pipeline(["a", "b", "c"]), G);
    const after = layoutForest(
      [{ id: "a" }, { id: "b", children: [{ id: "b1" }, { id: "b2" }] }, { id: "c" }],
      G,
    );

    const gapBefore =
      before.byId.get("c")!.x - (before.byId.get("b")!.x + before.byId.get("b")!.w);
    const gapAfter = after.byId.get("c")!.x - (after.byId.get("b")!.x + after.byId.get("b")!.w);

    expect(gapAfter, "兄弟没有被撑开 —— 子树会压到它身上").toBeGreaterThan(gapBefore);
  });

  it("撑开之后两棵子树仍然不重叠", () => {
    const laid = layoutForest(
      [
        { id: "a", children: [{ id: "a1" }, { id: "a2" }, { id: "a3" }] },
        { id: "b", children: [{ id: "b1" }, { id: "b2" }, { id: "b3" }] },
      ],
      G,
    );
    expect(overlaps(laid.byId.get("a")!.subtree, laid.byId.get("b")!.subtree)).toBe(false);
  });

  it("六道工序都长出子树时，任意两棵都不重叠", () => {
    const laid = layoutForest(
      SIX.map((id) => ({
        id,
        children: Array.from({ length: 5 }, (_, i) => ({ id: `${id}-${i}` })),
      })),
      G,
    );
    const subs = laid.roots.map((r) => r.subtree);
    for (let i = 0; i < subs.length; i++) {
      for (let j = i + 1; j < subs.length; j++) {
        expect(overlaps(subs[i], subs[j]), `第 ${i + 1} 棵和第 ${j + 1} 棵叠了`).toBe(false);
      }
    }
  });

  it("长出子树之后整片森林更宽了", () => {
    const flat = layoutForest(pipeline(SIX), G);
    const grown = layoutForest(
      SIX.map((id) => ({ id, children: [{ id: `${id}-0` }, { id: `${id}-1` }] })),
      G,
    );
    expect(grown.bounds.w).toBeGreaterThan(flat.bounds.w);
    expect(Number.isFinite(grown.bounds.x + grown.bounds.w / 2)).toBe(true);
  });
});

describe("两层以上", () => {
  const deep: LayoutNode[] = [
    { id: "spec", children: [{ id: "a", children: [{ id: "a1" }, { id: "a2" }] }, { id: "b" }] },
  ];

  it("孙节点在子节点下面，不是并排", () => {
    const laid = layoutForest(deep, G);
    const a = laid.byId.get("a")!;
    const a1 = laid.byId.get("a1")!;
    expect(a1.y).toBeGreaterThanOrEqual(a.y + a.h);
    expect(a1.depth).toBe(2);
    expect(a1.parentId).toBe("a");
  });

  it("孙节点那一行在它父亲的中线上居中", () => {
    const laid = layoutForest(deep, G);
    const a = laid.byId.get("a")!;
    const kids = ["a1", "a2"].map((id) => laid.byId.get(id)!);
    expect((kids[0].x + kids[1].x + kids[1].w) / 2).toBeCloseTo(a.x + a.w / 2, 6);
  });

  it("整棵子树的包围盒含住最深的那个节点", () => {
    const laid = layoutForest(deep, G);
    const s = laid.byId.get("spec")!.subtree;
    for (const id of ["a1", "a2", "a", "b"]) {
      const n = laid.byId.get(id)!;
      expect(n.y + n.h).toBeLessThanOrEqual(s.y + s.h + 1e-9);
    }
  });
});

describe("根节点换行", () => {
  const panel: ForestGeometry = { ...G, root: { ...G.root, perRow: 3 } };

  it("六个根排成两行", () => {
    const laid = layoutForest(pipeline(SIX), panel);
    expect(new Set(laid.roots.map((r) => r.y)).size).toBe(2);
  });

  it("下一行落在上一行**子树**的下面，而不是上一行节点自己的下面", () => {
    // 第二行的 y 必须大于第一行里最高那棵子树的底边，防子树横穿下一行。
    const laid = layoutForest(
      SIX.map((id, i) => ({
        id,
        children:
          i < 3 ? Array.from({ length: 5 }, (_, k) => ({ id: `${id}-${k}` })) : undefined,
      })),
      panel,
    );
    const firstTop = laid.roots[0].y;
    const firstRow = laid.roots.filter((r) => r.y === firstTop);
    const secondTop = Math.min(...laid.roots.filter((r) => r.y !== firstTop).map((r) => r.y));
    const firstBottom = Math.max(...firstRow.map((r) => r.subtree.y + r.subtree.h));

    expect(secondTop, "第二行压在第一行的子树上").toBeGreaterThanOrEqual(firstBottom);
  });
});

describe("输出完整性", () => {
  it("每个输入节点都在输出里，一个不多一个不少", () => {
    const laid = layoutForest(
      [{ id: "a", children: [{ id: "a1", children: [{ id: "a1x" }] }] }, { id: "b" }],
      G,
    );
    expect(laid.nodes.map((n) => n.id).sort()).toEqual(["a", "a1", "a1x", "b"]);
    expect(laid.byId.size).toBe(4);
  });

  it("所有位置都是有限数 —— 没有 NaN 溜进去", () => {
    const laid = layoutForest(
      SIX.map((id) => ({ id, children: [{ id: `${id}-0` }] })),
      G,
    );
    for (const n of laid.nodes) {
      for (const [k, v] of Object.entries({ x: n.x, y: n.y, w: n.w, h: n.h })) {
        expect(Number.isFinite(v), `${n.id}.${k} 不是有限数`).toBe(true);
      }
    }
  });
});

describe("treeLinks 父子连线", () => {
  const g = FOREST_GEOMETRY;

  /** 造一棵根 + 该根下面挂 n 个孩子的森林，取它全部摆好的节点 */
  function withKids(n: number) {
    const tree: LayoutNode[] = [
      { id: "root", children: Array.from({ length: n }, (_, i) => ({ id: `c${i}` })) },
    ];
    return layoutForest(tree, g).nodes;
  }

  it("没有子节点时不产生任何连线", () => {
    const nodes = layoutForest([{ id: "a" }, { id: "b" }], g).nodes;
    expect(treeLinks(nodes)).toEqual([]);
  });

  it("一个父节点只出一条躯干，孩子各占一根横枝", () => {
    const links = treeLinks(withKids(4));
    expect(links).toHaveLength(1);
    expect(links[0].parentId).toBe("root");
    expect(links[0].branches).toHaveLength(4);
  });

  it("躯干从父卡底边中点出发，拉到最下面那根横枝", () => {
    const nodes = withKids(4);
    const links = treeLinks(nodes);
    const root = nodes.find((n) => n.id === "root")!;
    const l = links[0];

    expect(l.spineX).toBeCloseTo(root.x + root.w / 2, 9);
    expect(l.trunk.x).toBe(l.spineX);
    expect(l.trunk.y1).toBeCloseTo(root.y + root.h, 9);
    // 终点是**最下面**那根横枝，不是最后一根 —— 两列布局下最后一根未必最低
    expect(l.trunk.y2).toBeCloseTo(Math.max(...l.branches.map((b) => b.y)), 9);
  });

  it("横枝接在孩子朝向脊线的那条边的中点", () => {
    const nodes = withKids(4);
    const links = treeLinks(nodes);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const l = links[0];

    for (const b of l.branches) {
      const kid = byId.get(b.childId)!;
      expect(b.x1).toBe(l.spineX);

      if (b.degenerate) {
        expect(b.y).toBeCloseTo(kid.y, 9);
        expect(b.x2).toBeCloseTo(kid.x + kid.w / 2, 9);
        continue;
      }

      expect(b.y).toBeCloseTo(kid.y + kid.h / 2, 9);
      const kidCx = kid.x + kid.w / 2;
      const expected = kidCx > l.spineX ? kid.x : kid.x + kid.w;
      expect(b.x2).toBeCloseTo(expected, 9);
    }
  });

  it("★ 脊线不穿过任何一个孩子（第 2/3/4 行的线不会被方块盖住）", () => {
    // 第一版每个孩子各画一条线，多行时会从上一行方块底下穿过。
    // 改成脊线后必须保证它在每一行都落在两个方块的间隙里；4/5/7 个孩子各试一遍。
    for (const n of [1, 2, 3, 4, 5, 7]) {
      const nodes = withKids(n);
      const links = treeLinks(nodes);
      const kids = nodes.filter((x) => x.parentId === "root");
      const spineX = links[0].spineX;

      const rows = new Map<number, typeof kids>();
      for (const k of kids) {
        const list = rows.get(k.y) ?? [];
        list.push(k);
        rows.set(k.y, list);
      }

      for (const [, rowKids] of rows) {
        const inside = rowKids.filter((k) => spineX > k.x && spineX < k.x + k.w);
        // 唯一允许落在方块内部的情形：这一行只有 1 个孩子横跨脊线，横枝退化成直下。
        if (rowKids.length === 1 && inside.length === 1) continue;
        expect(
          inside.length,
          `n=${n} 时脊线穿过了 ${inside.length} 个方块，那一行的线会被盖住`,
        ).toBe(0);
      }
    }
  });

  it("最后一个孩子横跨脊线时，横枝退化成从顶边直下", () => {
    // 7 个孩子：两列排，最后一行只有 1 个、居中 —— 正落在脊线上
    const nodes = withKids(7);
    const l = treeLinks(nodes)[0];
    const degen = l.branches.filter((b) => b.degenerate);

    expect(degen).toHaveLength(1);
    const kid = nodes.find((n) => n.id === degen[0].childId)!;
    expect(degen[0].y).toBeCloseTo(kid.y, 9);
    expect(degen[0].x2).toBeCloseTo(kid.x + kid.w / 2, 9);
  });

  it("多个父节点各自成组，没有孩子的父节点不冒出空连线", () => {
    const nodes = layoutForest(
      [
        { id: "r1", children: [{ id: "a" }, { id: "b" }] },
        { id: "r2", children: [{ id: "c" }] },
        { id: "r3" },
      ],
      g,
    ).nodes;

    const links = treeLinks(nodes);
    expect(links.map((l) => l.parentId).sort()).toEqual(["r1", "r2"]);
    expect(links.find((l) => l.parentId === "r1")!.branches).toHaveLength(2);
    expect(links.find((l) => l.parentId === "r2")!.branches).toHaveLength(1);
    expect(links.find((l) => l.parentId === "r3")).toBeUndefined();
  });
});

describe("lerpLayout 两套布局之间插值", () => {
  const g = FOREST_GEOMETRY;

  // 挂两个孩子而不是一个：一个孩子的子树宽 232，比根卡 240 还窄。
  // 两个才是 232x2+28 = 492 > 240，真的会撑开兄弟。
  const KIDS = 2;
  function forest(childrenFor: string[] = []) {
    return layoutForest(
      SIX.map((id) =>
        childrenFor.includes(id)
          ? {
              id,
              children: Array.from({ length: KIDS }, (_, i) => ({ id: `${id}-k${i}` })),
            }
          : { id },
      ),
      g,
    ).nodes;
  }

  it("t=0 时逐像素等于上一帧", () => {
    const prev = forest();
    const next = forest(["verify"]);
    for (const n of lerpLayout(prev, next, 0)) {
      const p = prev.find((x) => x.id === n.id);
      if (!p) continue; // 新节点不在这条断言的范围里
      expect(n.x).toBeCloseTo(p.x, 9);
      expect(n.y).toBeCloseTo(p.y, 9);
      expect(n.w).toBeCloseTo(p.w, 9);
      expect(n.h).toBeCloseTo(p.h, 9);
    }
  });

  it("t=1 时逐像素等于这一帧", () => {
    const prev = forest();
    const next = forest(["verify"]);
    for (const n of lerpLayout(prev, next, 1)) {
      const t = next.find((x) => x.id === n.id)!;
      expect(n.x).toBeCloseTo(t.x, 9);
      expect(n.y).toBeCloseTo(t.y, 9);
      expect(n.w).toBeCloseTo(t.w, 9);
      expect(n.h).toBeCloseTo(t.h, 9);
    }
  });

  it("t=0.5 落在两帧正中间（老节点）", () => {
    const prev = forest();
    const next = forest(["verify"]);
    const mid = lerpLayout(prev, next, 0.5);
    // 验收有子节点，它自己没动，但别的根节点被撑开了，拿第一道验
    const a0 = prev.find((n) => n.id === SIX[0])!;
    const a1 = next.find((n) => n.id === SIX[0])!;
    const am = mid.find((n) => n.id === SIX[0])!;
    expect(am.x).toBeCloseTo((a0.x + a1.x) / 2, 9);
    expect(a0.x).not.toBeCloseTo(a1.x, 3); // 前提：它真的动了
  });

  it("★ 新节点从父节点那儿长出来，不是凭空出现", () => {
    const prev = forest(); // 还没有子节点
    const next = forest(["verify"]);
    const parentPrev = prev.find((n) => n.id === "verify")!;

    // t=0 时，新节点应该退化成一个点，落在**上一帧**父节点的中心
    const born = lerpLayout(prev, next, 0).find((n) => n.id === "verify-k0")!;
    expect(born.w).toBeCloseTo(0, 9);
    expect(born.h).toBeCloseTo(0, 9);
    expect(born.x).toBeCloseTo(parentPrev.x + parentPrev.w / 2, 9);
    expect(born.y).toBeCloseTo(parentPrev.y + parentPrev.h / 2, 9);

    // 前提：这棵树确实在动。不断言某个特定根动了，那取决于布局算法。
    const moved = next.some((n) => {
      const p = prev.find((x) => x.id === n.id);
      return p !== undefined && n.depth === 0 && Math.abs(p.x - n.x) > 1;
    });
    expect(moved, "这棵树根本没动，上面的断言等于没测").toBe(true);
  });

  it("新节点的尺寸随时间单调长大", () => {
    const prev = forest();
    const next = forest(["verify"]);
    const target = next.find((n) => n.id === "verify-k0")!;
    let last = -1;
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const w = lerpLayout(prev, next, t).find((n) => n.id === "verify-k0")!.w;
      expect(w).toBeGreaterThanOrEqual(last);
      last = w;
    }
    expect(last).toBeCloseTo(target.w, 9);
  });

  it("t 超出 [0,1] 会被夹住 —— rAF 的时间戳会倒退，不能算出负尺寸", () => {
    const prev = forest();
    const next = forest(["verify"]);
    for (const bad of [-5, -0.001, 1.001, 99]) {
      for (const n of lerpLayout(prev, next, bad)) {
        expect(Number.isFinite(n.w), `t=${bad} 时 w 不是有限数`).toBe(true);
        expect(n.w, `t=${bad} 时算出了负宽度`).toBeGreaterThanOrEqual(0);
        expect(n.h).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("第一次渲染（上一帧是空的）不炸，所有节点都当成新节点", () => {
    const next = forest(["verify"]);
    const laid = lerpLayout([], next, 1);
    expect(laid).toHaveLength(next.length);
    for (const n of laid) {
      expect(Number.isFinite(n.x)).toBe(true);
      expect(Number.isFinite(n.y)).toBe(true);
    }
  });

  it("isNewNode 认得出新老节点", () => {
    const prev = forest();
    expect(isNewNode(prev, "verify")).toBe(false);
    expect(isNewNode(prev, "verify-k0")).toBe(true);
    expect(isNewNode([], "anything")).toBe(true);
  });
});