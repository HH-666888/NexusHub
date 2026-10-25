import { describe, expect, it } from "vitest";
import {
  FOREST_GEOMETRY,
  layoutForest,
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
 * 森林布局的单测
 * ============================================================
 * 最要紧的一组在最上面：**没有子树时，新布局和旧的 nodeRect
 * 必须逐像素相同**。
 *
 * 为什么它排第一：
 *   这次改动把画布的位置计算整个换掉了。如果没有这条锚，
 *   「换完之后画面变了」这件事只能靠肉眼看截图发现 ——
 *   而肉眼对几个像素的偏移是瞎的。
 *   有了它，改布局时任何意外的位移都会当场变红。
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

/* ① 回归锚：没有子树时必须和旧布局一模一样 */

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
    /*
      旧 pipelineBounds 的 h = 节点区 + FALLBACK_DROP，
      新 layoutForest 的 bounds 也是。两者应该相等 ——
      这条写出来是为了说明「我核过这件事」，而不是默认它成立。
    */
    const laid = layoutForest(pipeline(SIX), G);
    expect(laid.bounds.h).toBe(pipelineBounds(SIX.length, WIDE_GEOMETRY).h);
  });

  it("包围盒比节点区多出一个 FALLBACK_DROP —— 回退弧线不能被切在屏幕外", () => {
    /*
      这条守的不是「两个常量相等」，而是**那个值真的被加上了**。

      我一开始写的是「forest-layout 里的 FALLBACK_DROP 和
      pipeline-layout 里的相等」—— 那是错的断言：
      后来改成 forest-layout 直接 import，**全项目只有一处定义**，
      两个常量相等这件事由编译器保证，不需要测。
      需要测的是它有没有被用在包围盒上。
    */
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

/* ② 一棵子树的形状 */

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

/* ③ 自动扩展：子树越宽，兄弟被撑得越开 */

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

/* ④ 子节点自己也有子节点 */

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

/* ⑤ 根节点换行（工作台面板那一档） */

describe("根节点换行", () => {
  const panel: ForestGeometry = { ...G, root: { ...G.root, perRow: 3 } };

  it("六个根排成两行", () => {
    const laid = layoutForest(pipeline(SIX), panel);
    expect(new Set(laid.roots.map((r) => r.y)).size).toBe(2);
  });

  it("下一行落在上一行**子树**的下面，而不是上一行节点自己的下面", () => {
    /*
      这一条是防「子树横穿下一行节点」的。
      第二行的 y 必须大于第一行里最高的那棵子树的底边。
    */
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

/* ⑥ 数据保真 */

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