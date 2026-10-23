import { describe, expect, it } from "vitest";
import {
  DEFAULT_GEOMETRY,
  GRID_COLS,
  GRID_ROWS,
  HUB_SLOT,
  PERIMETER,
  cellCenter,
  cellOrigin,
  edgeSides,
  isPerimeter,
  loopCanvasSize,
  loopSlot,
  perimeterIndex,
  routeEdge,
  sidePoint,
} from "@/core/blueprint/loop-layout";

describe("闭环布局 · 七步落在哪", () => {
  it("【关键】七步的落位和参考图完全一致", () => {
    /*
      参考图的摆法看着不规则，其实是一条环：
        01 左下 → 02 左中 → 03 左上 → 04 上中
        → 05 右上 → 06 右中 → 07 右下
      这条断言就是"我们真的照着原图摆了"，而不是"大概摆了个圈"。
      摆错一格在画面上不一定看得出来 —— 但这里会红。
    */
    const expected = [
      { col: 0, row: 2 }, // 01 接数据   左下
      { col: 0, row: 1 }, // 02 看数     左中
      { col: 0, row: 0 }, // 03 给建议   左上
      { col: 1, row: 0 }, // 04 人拍板   上中
      { col: 2, row: 0 }, // 05 动手     右上
      { col: 2, row: 1 }, // 06 验收     右中
      { col: 2, row: 2 }, // 07 回流     右下
    ];
    expected.forEach((e, i) => {
      expect(loopSlot(i), `第 ${i + 1} 步落在 (${e.col},${e.row})`).toEqual(e);
    });
  });

  it("中心是 hub，且不在外圈上", () => {
    expect(HUB_SLOT).toEqual({ col: 1, row: 1 });
    expect(isPerimeter(HUB_SLOT.col, HUB_SLOT.row)).toBe(false);
  });

  it("七步时正下方那一格空着", () => {
    // 参考图上 01 和 07 之间是空的，回流那条线从那里穿过去
    const used = new Set(
      Array.from({ length: 7 }, (_, i) => {
        const s = loopSlot(i);
        return `${s.col},${s.row}`;
      }),
    );
    expect(used.has("1,2")).toBe(false);
    expect(isPerimeter(1, 2)).toBe(true); // 它仍然是外圈的一格
  });

  it("外圈正好八格，九宫格去掉中心", () => {
    expect(PERIMETER).toHaveLength(GRID_COLS * GRID_ROWS - 1);
    // 八格互不重复
    const keys = new Set(PERIMETER.map((p) => `${p.col},${p.row}`));
    expect(keys.size).toBe(8);
  });

  it("外圈每一格都在 3×3 范围内", () => {
    for (const p of PERIMETER) {
      expect(p.col).toBeGreaterThanOrEqual(0);
      expect(p.col).toBeLessThan(GRID_COLS);
      expect(p.row).toBeGreaterThanOrEqual(0);
      expect(p.row).toBeLessThan(GRID_ROWS);
    }
  });

  it("格号能反查回来", () => {
    PERIMETER.forEach((p, i) => {
      expect(perimeterIndex(p.col, p.row)).toBe(i);
    });
    // 中心不在外圈上
    expect(perimeterIndex(1, 1)).toBe(-1);
  });

  it("步数超过八格时绕回来重用，不崩", () => {
    expect(loopSlot(8)).toEqual(PERIMETER[0]);
    expect(loopSlot(15)).toEqual(PERIMETER[7]);
  });
});

describe("闭环布局 · 像素位置", () => {
  const g = DEFAULT_GEOMETRY;

  it("整张图的大小 = 三格加两条缝", () => {
    const s = loopCanvasSize(g);
    expect(s.width).toBe(3 * g.cellW + 2 * g.gapX);
    expect(s.height).toBe(3 * g.cellH + 2 * g.gapY);
  });

  it("格子之间有缝 —— 缝是留给连线的", () => {
    // 缝为 0 的话线会贴着卡片走，看起来像卡片的边
    expect(g.gapX).toBeGreaterThan(20);
    expect(g.gapY).toBeGreaterThan(10);
  });

  it("格心在格子的正中", () => {
    const o = cellOrigin(1, 1, g);
    const c = cellCenter(1, 1, g);
    expect(c.x - o.x).toBeCloseTo(g.cellW / 2, 9);
    expect(c.y - o.y).toBeCloseTo(g.cellH / 2, 9);
  });

  it("同一列相邻两行的格心，纵向差正好是一格加一缝", () => {
    const a = cellCenter(0, 0, g);
    const b = cellCenter(0, 1, g);
    expect(b.y - a.y).toBeCloseTo(g.cellH + g.gapY, 9);
    expect(b.x).toBeCloseTo(a.x, 9);
  });

  it("中心格确实在整张图的正中", () => {
    // hub 在中间这件事，是这张图的语义（它不属于任何一步）
    const c = cellCenter(HUB_SLOT.col, HUB_SLOT.row, g);
    const s = loopCanvasSize(g);
    expect(c.x).toBeCloseTo(s.width / 2, 9);
    expect(c.y).toBeCloseTo(s.height / 2, 9);
  });
});

describe("闭环布局 · 连线走哪条边", () => {
  it("往上走：从顶边出、进底边", () => {
    // 01 左下 → 02 左中
    expect(edgeSides({ col: 0, row: 2 }, { col: 0, row: 1 })).toEqual({
      out: "top",
      into: "bottom",
    });
  });

  it("往下走：从底边出、进顶边", () => {
    // 05 右上 → 06 右中
    expect(edgeSides({ col: 2, row: 0 }, { col: 2, row: 1 })).toEqual({
      out: "bottom",
      into: "top",
    });
  });

  it("往右走：从右边出、进左边", () => {
    // 03 左上 → 04 上中
    expect(edgeSides({ col: 0, row: 0 }, { col: 1, row: 0 })).toEqual({
      out: "right",
      into: "left",
    });
  });

  it("斜的：从上下出、往左右进 —— 走 L 形而不是直斜线", () => {
    /*
      直斜线会从卡片中间穿过去。
      参考图上每条线都是沿格子之间的缝走的。
    */
    expect(edgeSides({ col: 0, row: 0 }, { col: 1, row: 1 })).toEqual({
      out: "bottom",
      into: "left",
    });
    // 反过来：从下往上到左边
    expect(edgeSides({ col: 1, row: 1 }, { col: 0, row: 0 })).toEqual({
      out: "top",
      into: "right",
    });
  });

  it("每一边的中点都贴在格子边上", () => {
    const g = DEFAULT_GEOMETRY;
    const o = cellOrigin(0, 0, g);
    expect(sidePoint(0, 0, "top", g)).toEqual({ x: o.x + g.cellW / 2, y: o.y });
    expect(sidePoint(0, 0, "left", g)).toEqual({ x: o.x, y: o.y + g.cellH / 2 });
    expect(sidePoint(0, 0, "right", g)).toEqual({ x: o.x + g.cellW, y: o.y + g.cellH / 2 });
    expect(sidePoint(0, 0, "bottom", g)).toEqual({ x: o.x + g.cellW / 2, y: o.y + g.cellH });
  });
});

describe("闭环布局 · 走线", () => {
  const g = DEFAULT_GEOMETRY;

  /** 从 d 里抠出所有顶点 */
  function points(d: string): Array<{ x: number; y: number }> {
    return [...d.matchAll(/[ML] ([\d.-]+) ([\d.-]+)/g)].map((m) => ({
      x: Number(m[1]),
      y: Number(m[2]),
    }));
  }

  /** 这个点落在哪一格（含卡片区域，不只是格心） */
  function cellOf(p: { x: number; y: number }) {
    const col = Math.floor(p.x / (g.cellW + g.gapX));
    const row = Math.floor(p.y / (g.cellH + g.gapY));
    // 落在缝里的不算任何一格
    const inXGap = p.x - col * (g.cellW + g.gapX) > g.cellW;
    const inYGap = p.y - row * (g.cellH + g.gapY) > g.cellH;
    return { col, row, inGap: inXGap || inYGap };
  }

  it("同一列：一条竖线", () => {
    const r = routeEdge({ col: 0, row: 2 }, { col: 0, row: 1 }, g);
    expect(points(r.d)).toHaveLength(2);
    expect(r.vertical).toBe(true);
  });

  it("同一行：一条横线", () => {
    const r = routeEdge({ col: 0, row: 0 }, { col: 1, row: 0 }, g);
    const ps = points(r.d);
    expect(ps).toHaveLength(2);
    expect(ps[0].y).toBeCloseTo(ps[1].y, 9);
    expect(r.vertical).toBe(false);
  });

  it("【关键】斜着连时走三段，且中间那段在缝里", () => {
    /*
      第一版这里是**一条直线**，斜着穿过 (0,1) 那格 ——
      而 (0,1) 上正好是 02 那张卡，标签于是压在卡片角上。
      截图上一眼看出来。
      现在走三段：出边 → 拐进缝 → 沿缝走 → 拐进目标边。
    */
    const r = routeEdge({ col: 0, row: 0 }, { col: 1, row: 1 }, g);
    const ps = points(r.d);
    expect(ps, "斜着连必须是三段以上").toHaveLength(4);
    // 中间那两个拐点，x 相同（都在缝的中心线上）
    expect(ps[1].x).toBeCloseTo(ps[2].x, 9);
  });

  it("【关键】标签落在缝里，不落在任何卡片上", () => {
    const cases: Array<[{ col: number; row: number }, { col: number; row: number }]> = [
      [{ col: 0, row: 0 }, { col: 1, row: 1 }], // 03 → hub
      [{ col: 1, row: 1 }, { col: 2, row: 0 }], // hub → 05
      [{ col: 2, row: 0 }, { col: 1, row: 1 }], // 05 → hub
      [{ col: 1, row: 1 }, { col: 1, row: 0 }], // hub → 04
    ];
    for (const [from, to] of cases) {
      const r = routeEdge(from, to, g);
      const c = cellOf(r.label);
      expect(
        c.inGap,
        `(${from.col},${from.row})→(${to.col},${to.row}) 的标签落在了 (${c.col},${c.row}) 这张卡上`,
      ).toBe(true);
    }
  });

  it("【关键】斜线的顶点也都不在卡片里", () => {
    // 线穿过卡片比标签压在上面更糟 —— 它会盖住正文
    const r = routeEdge({ col: 0, row: 0 }, { col: 2, row: 2 }, g);
    for (const p of points(r.d)) {
      expect(cellOf(p).inGap || isOnCellEdge(p), `顶点 (${p.x},${p.y}) 落在卡片内部`).toBe(true);
    }
  });

  it("往左绕和往右绕是对称的", () => {
    const right = routeEdge({ col: 0, row: 0 }, { col: 1, row: 1 }, g);
    const left = routeEdge({ col: 1, row: 1 }, { col: 0, row: 0 }, g);
    // 两条都该在同一个缝里（x 相同）
    expect(right.label.x).toBeCloseTo(left.label.x, 9);
  });

  it("生成的是一条合法的 SVG 路径", () => {
    const r = routeEdge({ col: 0, row: 2 }, { col: 0, row: 1 }, g);
    expect(r.d).toMatch(/^M [\d.-]+ [\d.-]+( L [\d.-]+ [\d.-]+)+$/);
  });

  it("七步串起来，每一条都接得上", () => {
    const slots = Array.from({ length: 7 }, (_, i) => loopSlot(i));
    for (let i = 0; i < slots.length - 1; i++) {
      const r = routeEdge(slots[i], slots[i + 1], g);
      const ps = points(r.d);
      expect(ps.length, `第 ${i + 1} → ${i + 2} 步的线没有顶点`).toBeGreaterThanOrEqual(2);
      for (const p of ps) {
        expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
      }
    }
  });

  /** 点在格子的边上（线本来就该从边上出入） */
  function isOnCellEdge(p: { x: number; y: number }) {
    const col = Math.floor(p.x / (g.cellW + g.gapX));
    const row = Math.floor(p.y / (g.cellH + g.gapY));
    const ox = col * (g.cellW + g.gapX);
    const oy = row * (g.cellH + g.gapY);
    const onV = Math.abs(p.x - ox) < 0.01 || Math.abs(p.x - (ox + g.cellW)) < 0.01;
    const onH = Math.abs(p.y - oy) < 0.01 || Math.abs(p.y - (oy + g.cellH)) < 0.01;
    return onV || onH;
  }
});