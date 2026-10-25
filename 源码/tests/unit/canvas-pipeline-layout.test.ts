import { describe, expect, it } from "vitest";
import {
  FALLBACK_DROP,
  PIPELINE_GEOMETRY,
  bottomOf,
  fallbackLabelAt,
  fallbackPath,
  flowArrowAt,
  flowPath,
  leftOf,
  nodeRect,
  pipelineBounds,
  pipelineWidth,
  rightOf,
  type NodeRect,
} from "@/core/canvas/pipeline-layout";
import { HOME_WORLD } from "@/core/canvas/viewport";

/**
 * 六道工序在画布上的布局
 * ============================================================
 * 布局是纯函数，所以"摆得对不对"这件事能被断言 ——
 * 摆错一点在画面上看不出来（看起来"就是这样设计的"），
 * 但连线的两端会跟着歪，而歪的线是查不出来的。
 */

const g = PIPELINE_GEOMETRY;
const TOTAL = 6;

describe("画布布局 · 摆放", () => {
  it("总宽 = 六个节点 + 五个空隙", () => {
    // 写成 n 个空隙的话整条会宽出一个空隙，
    // 而"宽一点"只有拿两个节点的间距去量才发现
    expect(pipelineWidth(6)).toBe(6 * g.nodeW + 5 * g.gapX);
  });

  it("只有一个节点时没有空隙", () => {
    expect(pipelineWidth(1)).toBe(g.nodeW);
    expect(pipelineWidth(0)).toBe(0);
  });

  it("六个节点等距排开", () => {
    const xs = Array.from({ length: TOTAL }, (_, i) => nodeRect(i, TOTAL).x);
    const gaps = xs.slice(1).map((x, i) => x - xs[i]);
    for (const gap of gaps) {
      expect(gap).toBeCloseTo(g.nodeW + g.gapX, 9);
    }
  });

  it("同一行 —— 六个节点的 y 完全一样", () => {
    const ys = new Set(Array.from({ length: TOTAL }, (_, i) => nodeRect(i, TOTAL).y));
    expect(ys.size, "摆成了两行").toBe(1);
  });

  it("互不重叠", () => {
    for (let i = 0; i < TOTAL - 1; i++) {
      const a = nodeRect(i, TOTAL);
      const b = nodeRect(i + 1, TOTAL);
      expect(b.x).toBeGreaterThanOrEqual(a.x + a.w);
    }
  });

  it("【关键】整条以核心格的 x 居中", () => {
    /*
      画布打开时视口对准的是核心格。
      流水线以它的 x 居中，于是「打开就看到整条」这件事
      不需要额外调视口 —— 一个常量对齐比一段对准逻辑可靠。
    */
    const first = nodeRect(0, TOTAL);
    const last = nodeRect(TOTAL - 1, TOTAL);
    const center = (first.x + last.x + last.w) / 2;
    expect(center).toBeCloseTo(HOME_WORLD.x, 9);
  });

  it("纵向相对核心格有一个固定偏移", () => {
    expect(nodeRect(0, TOTAL).y).toBe(HOME_WORLD.y + g.rowOffsetY);
  });

  it("包围盒装得下所有节点", () => {
    const b = pipelineBounds(TOTAL);
    for (let i = 0; i < TOTAL; i++) {
      const r = nodeRect(i, TOTAL);
      expect(r.x).toBeGreaterThanOrEqual(b.x);
      expect(r.x + r.w).toBeLessThanOrEqual(b.x + b.w);
      expect(r.y).toBeGreaterThanOrEqual(b.y);
    }
  });

  it("【关键】包围盒的高度算上了回退边往下绕的那一段", () => {
    /*
      只算节点的话，「缩放到全部」之后回退边会被切在屏幕外 ——
      而它是这张图上最该被看见的东西之一（别家画不出来的那个）。
    */
    const b = pipelineBounds(TOTAL);
    const r = nodeRect(0, TOTAL);
    expect(b.h).toBe(g.nodeH + FALLBACK_DROP);
    expect(b.y + b.h).toBeGreaterThan(r.y + r.h + FALLBACK_DROP - 1);
  });

  it("零个节点不会崩", () => {
    const b = pipelineBounds(0);
    expect(b.w).toBe(0);
    expect(Number.isFinite(b.x) && Number.isFinite(b.y)).toBe(true);
  });
});

describe("画布布局 · 边的端点", () => {
  const r: NodeRect = nodeRect(0, TOTAL);

  it("左中 / 右中 / 下中三个端点算得对", () => {
    expect(rightOf(r)).toEqual({ x: r.x + r.w, y: r.y + r.h / 2 });
    expect(leftOf(r)).toEqual({ x: r.x, y: r.y + r.h / 2 });
    expect(bottomOf(r)).toEqual({ x: r.x + r.w / 2, y: r.y + r.h });
  });

  it("顺序流转的线是水平的", () => {
    const p = flowPath(nodeRect(0, TOTAL), nodeRect(1, TOTAL));
    /*
      ⚠️ 路径里的坐标是**空格**分隔的（`M x y L x y`），不是逗号。
      写成 /, ([\d.-]+)/ 会一个都匹配不到，
      于是 new Set([]).size === 0，断言变成"0 不等于 1" ——
      看起来像代码错了，其实是正则错了。
    */
    const ys = [...p.matchAll(/[ML] [\d.-]+ ([\d.-]+)/g)].map((m) => Number(m[1]));
    expect(ys, "没从路径里解析出坐标").toHaveLength(2);
    expect(new Set(ys.map((y) => y.toFixed(3))).size, "两头不在同一高度").toBe(1);
  });

  it("顺序流转的线两端各缩进 10 像素", () => {
    // 不缩的话箭头顶在节点边框上，看起来像"线和框黏在一起"
    const a = nodeRect(0, TOTAL);
    const b = nodeRect(1, TOTAL);
    const p = flowPath(a, b);
    const [x1, x2] = [...p.matchAll(/[ML] ([\d.-]+)/g)].map((m) => Number(m[1]));
    expect(x1).toBeCloseTo(rightOf(a).x + 10, 9);
    expect(x2).toBeCloseTo(leftOf(b).x - 10, 9);
  });

  it("箭头落在两个节点中间，方向向右", () => {
    const a = nodeRect(0, TOTAL);
    const b = nodeRect(1, TOTAL);
    const arrow = flowArrowAt(a, b);
    expect(arrow.x).toBeCloseTo((rightOf(a).x + leftOf(b).x) / 2, 9);
    expect(arrow.dir).toBe("right");
  });
});

describe("画布布局 · 失败回退边", () => {
  it("【关键】回退边从节点**下方**绕，不穿过中间那几个节点", () => {
    /*
      画直线的话它会横穿中间那几个节点 ——
      穿过多少个就盖住多少个节点的正文。

      判据：路径上的每个点，y 都不小于节点底边（除了两端进出那一点）。
    */
    const from = nodeRect(5, TOTAL); // 验收
    const to = nodeRect(0, TOTAL); // 退回规格化
    const p = fallbackPath(from, to);

    const pts = [...p.matchAll(/[-\d.]+ [-\d.]+/g)].map((m) => {
      const [x, y] = m[0].split(" ").map(Number);
      return { x, y };
    });
    expect(pts.length).toBeGreaterThanOrEqual(4);

    const nodeBottom = from.y + from.h;
    for (const pt of pts) {
      expect(pt.y, `回退边跑到了节点上方（y=${pt.y}）`).toBeGreaterThanOrEqual(nodeBottom);
    }
  });

  it("回退边的弧顶在节点下方一个固定距离", () => {
    const from = nodeRect(5, TOTAL);
    const to = nodeRect(0, TOTAL);
    const label = fallbackLabelAt(from, to);
    expect(label.y).toBe(bottomOf(from).y + FALLBACK_DROP);
  });

  it("弧顶横在两个节点的中间", () => {
    const from = nodeRect(5, TOTAL);
    const to = nodeRect(0, TOTAL);
    const label = fallbackLabelAt(from, to);
    expect(label.x).toBeCloseTo((bottomOf(from).x + bottomOf(to).x) / 2, 9);
  });

  it("跨得越远，弧线越宽", () => {
    const wide = fallbackLabelAt(nodeRect(5, TOTAL), nodeRect(0, TOTAL));
    const narrow = fallbackLabelAt(nodeRect(5, TOTAL), nodeRect(4, TOTAL));
    expect(wide.x).toBeLessThan(narrow.x);
  });

  it("【关键】相邻两道的回退边不会重叠成一条", () => {
    /*
      折线（下去、横走、上来）在拐角处是直角，
      两条回退边并排时拐角会叠在一起分不清哪条是哪条。
      弧线的中段自然分开 —— 这条断言守的就是那个"分开"。
    */
    const a = fallbackLabelAt(nodeRect(3, TOTAL), nodeRect(1, TOTAL));
    const b = fallbackLabelAt(nodeRect(4, TOTAL), nodeRect(2, TOTAL));
    // 这两条的跨度一样（都跨两道），弧顶应该在同一高度但不同 x
    expect(a.y).toBeCloseTo(b.y, 9);
    expect(Math.abs(a.x - b.x)).toBeGreaterThan(g.nodeW * 0.5);
  });

  it("生成的是一条合法的 SVG 路径", () => {
    const p = fallbackPath(nodeRect(3, TOTAL), nodeRect(0, TOTAL));
    expect(p).toMatch(/^M [\d.-]+ [\d.-]+ Q [\d.-]+ [\d.-]+ [\d.-]+ [\d.-]+ Q [\d.-]+ [\d.-]+ [\d.-]+ [\d.-]+$/);
  });
});