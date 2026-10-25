import { describe, expect, it } from "vitest";
import {
  FALLBACK_DROP,
  PANEL_GEOMETRY,
  WIDE_GEOMETRY,
  bottomOf,
  fallbackLabelAt,
  fallbackLaneX,
  fallbackPath,
  flowArrowAt,
  flowPath,
  leftOf,
  nodeRect,
  pipelineBounds,
  pipelineHeight,
  pipelineWidth,
  rightOf,
  rowCount,
  slotOf,
  type NodeRect,
} from "@/core/canvas/pipeline-layout";
import { HOME_WORLD } from "@/core/canvas/viewport";

/**
 * 六道工序在画布上的布局
 * ============================================================
 * 布局是纯函数，所以"摆得对不对"这件事能被断言 ——
 * 摆错一点在画面上看不出来（看起来"就是这样设计的"），
 * 但连线的两端会跟着歪，而歪的线是查不出来的。
 *
 * 两档几何都要测：
 *   WIDE   整页画布，一行六个
 *   PANEL  工作台面板，三列两行
 */

const WIDE = WIDE_GEOMETRY;
const PANEL = PANEL_GEOMETRY;
const TOTAL = 6;

describe("画布布局 · 摆放（整页，一行六个）", () => {
  it("总宽 = 六个节点 + 五个空隙", () => {
    // 写成 n 个空隙的话整条会宽出一个空隙，
    // 而"宽一点"只有拿两个节点的间距去量才发现
    expect(pipelineWidth(6, WIDE)).toBe(6 * WIDE.nodeW + 5 * WIDE.gapX);
  });

  it("只有一个节点时没有空隙", () => {
    expect(pipelineWidth(1, WIDE)).toBe(WIDE.nodeW);
    expect(pipelineWidth(0, WIDE)).toBe(0);
  });

  it("六个节点等距排开", () => {
    const xs = Array.from({ length: TOTAL }, (_, i) => nodeRect(i, TOTAL, WIDE).x);
    const gaps = xs.slice(1).map((x, i) => x - xs[i]);
    for (const gap of gaps) {
      expect(gap).toBeCloseTo(WIDE.nodeW + WIDE.gapX, 9);
    }
  });

  it("同一行 —— 六个节点的 y 完全一样", () => {
    const ys = new Set(Array.from({ length: TOTAL }, (_, i) => nodeRect(i, TOTAL, WIDE).y));
    expect(ys.size, "摆成了两行").toBe(1);
  });

  it("互不重叠", () => {
    for (let i = 0; i < TOTAL - 1; i++) {
      const a = nodeRect(i, TOTAL, WIDE);
      const b = nodeRect(i + 1, TOTAL, WIDE);
      expect(b.x).toBeGreaterThanOrEqual(a.x + a.w);
    }
  });

  it("【关键】整条以核心格的 x 居中", () => {
    /*
      画布打开时视口对准的是核心格。
      流水线以它的 x 居中，于是「打开就看到整条」这件事
      不需要额外调视口 —— 一个常量对齐比一段对准逻辑可靠。
    */
    const first = nodeRect(0, TOTAL, WIDE);
    const last = nodeRect(TOTAL - 1, TOTAL, WIDE);
    const center = (first.x + last.x + last.w) / 2;
    expect(center).toBeCloseTo(HOME_WORLD.x, 9);
  });

  it("纵向相对核心格有一个固定偏移", () => {
    expect(nodeRect(0, TOTAL, WIDE).y).toBe(HOME_WORLD.y + WIDE.rowOffsetY);
  });

  it("包围盒装得下所有节点", () => {
    const b = pipelineBounds(TOTAL, WIDE);
    for (let i = 0; i < TOTAL; i++) {
      const r = nodeRect(i, TOTAL, WIDE);
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
    const b = pipelineBounds(TOTAL, WIDE);
    const r = nodeRect(0, TOTAL, WIDE);
    expect(b.h).toBe(WIDE.nodeH + FALLBACK_DROP);
    expect(b.y + b.h).toBeGreaterThan(r.y + r.h + FALLBACK_DROP - 1);
  });

  it("零个节点不会崩", () => {
    const b = pipelineBounds(0, WIDE);
    expect(b.w).toBe(0);
    expect(Number.isFinite(b.x) && Number.isFinite(b.y)).toBe(true);
  });
});

describe("画布布局 · 换行（面板，三列两行）", () => {
  it("六道排成两行三列", () => {
    expect(rowCount(6, PANEL)).toBe(2);
    expect(slotOf(0, PANEL)).toEqual({ col: 0, row: 0 });
    expect(slotOf(2, PANEL)).toEqual({ col: 2, row: 0 });
    expect(slotOf(3, PANEL)).toEqual({ col: 0, row: 1 });
    expect(slotOf(5, PANEL)).toEqual({ col: 2, row: 1 });
  });

  it("【关键】宽度按最宽的那一行算，不是按总数", () => {
    /*
      最后一行常常没排满（六道、一行四个的话第二行只有两个）。
      按 total 算会多出两个空位，整条看起来偏左 ——
      而"偏左一点"在画面上完全看不出来。
    */
    // 六道、一行四个 → 两行：第一行 4 个，第二行 2 个 → 宽度按 4 算
    const g4 = { ...PANEL, perRow: 4 };
    expect(pipelineWidth(6, g4)).toBe(4 * g4.nodeW + 3 * g4.gapX);
    expect(pipelineWidth(6, g4)).toBeLessThan(pipelineWidth(6, { ...PANEL, perRow: 6 }));
  });

  it("换行之后仍然以核心格居中", () => {
    const b = pipelineBounds(TOTAL, PANEL);
    expect(b.x + b.w / 2).toBeCloseTo(HOME_WORLD.x, 9);
  });

  it("两行的 y 差 = 节点高 + 行距", () => {
    const r0 = nodeRect(0, TOTAL, PANEL);
    const r1 = nodeRect(3, TOTAL, PANEL);
    expect(r1.y - r0.y).toBeCloseTo(PANEL.nodeH + PANEL.gapY, 9);
  });

  it("【关键】行距装得下回退边绕的那一段", () => {
    /*
      装不下的话，上一行的回退弧线会横穿下一行的节点 ——
      和"回退边不画直线"是同一个毛病，只是换了个方向。
    */
    expect(PANEL.gapY).toBeGreaterThanOrEqual(FALLBACK_DROP);
  });

  it("换行后纵向也不重叠", () => {
    const r0 = nodeRect(2, TOTAL, PANEL); // 第一行最后一个
    const r1 = nodeRect(3, TOTAL, PANEL); // 第二行第一个
    expect(r1.y).toBeGreaterThanOrEqual(r0.y + r0.h);
  });

  it("包围盒装得下两行", () => {
    const b = pipelineBounds(TOTAL, PANEL);
    expect(b.h).toBe(pipelineHeight(TOTAL, PANEL) + FALLBACK_DROP);
    for (let i = 0; i < TOTAL; i++) {
      const r = nodeRect(i, TOTAL, PANEL);
      expect(r.y + r.h).toBeLessThanOrEqual(b.y + b.h);
    }
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

/* ============================================================
   失败回退边
   ============================================================
   两条不同的路，因为有两种不同的穿透要躲：

     同一行  往回退 → 走下面那条弧（横着躲开中间几个节点）
     跨行    往上退 → 走左边那条空白带（竖着躲开中间那一行）
   ============================================================ */

describe("画布布局 · 回退边（同一行，走下面的弧）", () => {
  function points(d: string) {
    return [...d.matchAll(/[-\d.]+ [-\d.]+/g)].map((m) => {
      const [x, y] = m[0].split(" ").map(Number);
      return { x, y };
    });
  }

  it("【关键】从节点下方绕，不穿过中间那几个节点", () => {
    /*
      画直线的话它会横穿中间那几个节点 ——
      穿过多少个就盖住多少个节点的正文。

      判据：路径上的每个点，y 都不小于节点底边。
    */
    const from = nodeRect(5, TOTAL, WIDE);
    const to = nodeRect(0, TOTAL, WIDE);
    const pts = points(fallbackPath(from, to, WIDE));
    expect(pts.length).toBeGreaterThanOrEqual(4);

    const nodeBottom = from.y + from.h;
    for (const pt of pts) {
      expect(pt.y, `回退边跑到了节点上方（y=${pt.y}）`).toBeGreaterThanOrEqual(nodeBottom);
    }
  });

  it("弧顶在节点下方一个固定距离", () => {
    const from = nodeRect(5, TOTAL, WIDE);
    const to = nodeRect(0, TOTAL, WIDE);
    expect(fallbackLabelAt(from, to).y).toBe(bottomOf(from).y + FALLBACK_DROP);
  });

  it("弧顶横在两个节点的中间", () => {
    const from = nodeRect(5, TOTAL, WIDE);
    const to = nodeRect(0, TOTAL, WIDE);
    expect(fallbackLabelAt(from, to).x).toBeCloseTo((bottomOf(from).x + bottomOf(to).x) / 2, 9);
  });

  it("跨得越远，弧顶越靠左", () => {
    const wide = fallbackLabelAt(nodeRect(5, TOTAL, WIDE), nodeRect(0, TOTAL, WIDE));
    const narrow = fallbackLabelAt(nodeRect(5, TOTAL, WIDE), nodeRect(4, TOTAL, WIDE));
    expect(wide.x).toBeLessThan(narrow.x);
  });

  it("【关键】跨度相同的两条回退边不会重叠成一条", () => {
    /*
      折线（下去、横走、上来）在拐角处是直角，
      两条回退边并排时拐角会叠在一起分不清哪条是哪条。
      弧线的中段自然分开 —— 这条断言守的就是那个"分开"。
    */
    const a = fallbackLabelAt(nodeRect(3, TOTAL, WIDE), nodeRect(1, TOTAL, WIDE));
    const b = fallbackLabelAt(nodeRect(4, TOTAL, WIDE), nodeRect(2, TOTAL, WIDE));
    expect(a.y).toBeCloseTo(b.y, 9);
    expect(Math.abs(a.x - b.x)).toBeGreaterThan(WIDE.nodeW * 0.5);
  });

  it("生成的是一条合法的 SVG 路径", () => {
    const p = fallbackPath(nodeRect(3, TOTAL, WIDE), nodeRect(0, TOTAL, WIDE), WIDE);
    expect(p).toMatch(
      /^M [\d.-]+ [\d.-]+ Q [\d.-]+ [\d.-]+ [\d.-]+ [\d.-]+ Q [\d.-]+ [\d.-]+ [\d.-]+ [\d.-]+$/,
    );
  });
});

describe("画布布局 · 回退边（跨行，走左边的空白带）", () => {
  it("【关键】跨行的回退边走左边，不竖着穿过下一行", () => {
    /*
      换行之后有一条回退是"第二行的某道 → 第一行的某道"。
      还走下面那条弧的话，它回升到第一行的那一段
      会竖着穿过第二行正中间那个节点 ——
      竖直方向也会穿透，和水平方向一样。
    */
    const from = nodeRect(3, TOTAL, PANEL);
    const to = nodeRect(0, TOTAL, PANEL);
    const p = fallbackPath(from, to, PANEL);

    // 四个顶点的折线，不是两段贝塞尔
    expect(p).toMatch(/^M [\d.-]+ [\d.-]+( L [\d.-]+ [\d.-]+){3}$/);

    const pts = [...p.matchAll(/[ML] ([-\d.]+) ([-\d.]+)/g)].map((m) => ({
      x: Number(m[1]),
      y: Number(m[2]),
    }));
    // 中间那两个拐点的 x 相同（都在左边那条竖线上）
    expect(pts[1].x).toBeCloseTo(pts[2].x, 9);
    // 而且那条竖线在整条流水线左边 —— 不能落在任何一个节点上
    const leftEdge = Math.min(...[0, 1, 2, 3, 4, 5].map((i) => nodeRect(i, TOTAL, PANEL).x));
    expect(pts[1].x, "竖线跑到了节点范围里").toBeLessThan(leftEdge);
  });

  it("标签挂在左边那条竖线上，两条不会叠在一起", () => {
    /*
      ⚠️ laneX 必须由外面给同一个值。
      第一版让函数按「源节点的左边」自己算 —— 对第二行第一道是对的，
      对第二行第二道就偏了一个列宽，竖线落进节点范围里，照样竖穿。
      「整条流水线左边在哪」是布局整体的事，单个节点不知道。

      ⚠️ 两条的 y 还需要 stagger 岔开：它们的中点**算出来一模一样**
      （起点都在第二行中线、终点都在第一行中线），
      不错位的话两个标签会精确地叠在一个点上，看起来只有一个。
    */
    const lane = fallbackLaneX(TOTAL, PANEL);
    const a = fallbackLabelAt(nodeRect(3, TOTAL, PANEL), nodeRect(0, TOTAL, PANEL), lane, 0);
    const b = fallbackLabelAt(nodeRect(4, TOTAL, PANEL), nodeRect(1, TOTAL, PANEL), lane, 1);
    expect(a.x).toBeCloseTo(b.x, 9);
    expect(Math.abs(a.y - b.y)).toBeGreaterThan(10);
  });

  it("【关键】不错位的话，两条跨行标签会精确重合", () => {
    // 这条钉住「为什么需要 stagger」这个理由本身 ——
    // 哪天有人觉得那个参数多余、删掉它，这条会红
    const lane = fallbackLaneX(TOTAL, PANEL);
    const a = fallbackLabelAt(nodeRect(3, TOTAL, PANEL), nodeRect(0, TOTAL, PANEL), lane);
    const b = fallbackLabelAt(nodeRect(4, TOTAL, PANEL), nodeRect(1, TOTAL, PANEL), lane);
    expect(a.y, "两条跨行标签本来就该重合 —— 所以才要 stagger").toBeCloseTo(b.y, 9);
  });

  it("【关键】两条跨行回退边共用同一根竖线，且都在节点范围之外", () => {
    // 各算各的话第二条会偏一个列宽，落进节点里
    const lane = fallbackLaneX(TOTAL, PANEL);
    const leftEdge = Math.min(...[0, 1, 2, 3, 4, 5].map((i) => nodeRect(i, TOTAL, PANEL).x));
    expect(lane, "空白带落进了节点范围").toBeLessThan(leftEdge);

    for (const [f, t] of [
      [3, 0],
      [4, 1],
      [5, 2],
    ]) {
      const xs = [
        ...fallbackPath(nodeRect(f, TOTAL, PANEL), nodeRect(t, TOTAL, PANEL), PANEL, lane).matchAll(
          /[ML] ([-\d.]+)/g,
        ),
      ].map((m) => Number(m[1]));
      // 中间那两个拐点就是竖线的 x
      expect(xs[1]).toBeCloseTo(lane, 9);
      expect(xs[2]).toBeCloseTo(lane, 9);
    }
  });

  it("【关键】跨行的线整条都在节点范围之外（竖的那一段）", () => {
    const lane = fallbackLaneX(TOTAL, PANEL);
    const leftEdge = Math.min(...[0, 1, 2, 3, 4, 5].map((i) => nodeRect(i, TOTAL, PANEL).x));
    const p = fallbackPath(nodeRect(4, TOTAL, PANEL), nodeRect(1, TOTAL, PANEL), PANEL, lane);
    const pts = [...p.matchAll(/[ML] ([-\d.]+) ([-\d.]+)/g)].map((m) => ({
      x: Number(m[1]),
      y: Number(m[2]),
    }));
    // 竖线段两端都在左边空白带里
    expect(pts[1].x).toBeLessThan(leftEdge);
    expect(pts[2].x).toBeLessThan(leftEdge);
    expect(pts[1].x).toBeCloseTo(pts[2].x, 9);
  });

  it("往下的回退（目标在下一行）仍然走弧", () => {
    // 不是所有跨行都走左边 —— 只有「往上退」才走
    const p = fallbackPath(nodeRect(0, TOTAL, PANEL), nodeRect(3, TOTAL, PANEL), PANEL);
    expect(p, "往下的回退不该走左边的折线").toContain("Q");
  });
});

