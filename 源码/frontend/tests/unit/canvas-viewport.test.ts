/**
 * 保护画布的换算、以光标为锚点缩放、平移夹紧、初始视口与网格显示。
 */

import { describe, expect, it } from "vitest";
import {
  CELL,
  HOME_COL,
  HOME_ROW,
  HOME_SCREEN_Y_RATIO,
  HOME_WORLD,
  MAX_SCALE,
  MIN_SCALE,
  PAN_LIMIT,
  clampPan,
  clampScale,
  formatScale,
  gridStepScreen,
  homeViewport,
  panBy,
  screenToWorld,
  viewportCenteredOn,
  worldToScreen,
  zoomAt,
  type Viewport,
} from "@/core/canvas/viewport";

const VP: Viewport = { panX: 100, panY: 50, scale: 2 };

describe("画布 · 换算", () => {
  it("世界↔屏幕 来回换算是可逆的", () => {
    for (const [wx, wy] of [
      [0, 0],
      [160, 320],
      [-500, 1234],
    ]) {
      const s = worldToScreen(VP, wx, wy);
      const w = screenToWorld(VP, s.x, s.y);
      expect(w.x).toBeCloseTo(wx, 9);
      expect(w.y).toBeCloseTo(wy, 9);
    }
  });

  it("缩放为 1、平移为 0 时，世界坐标就是屏幕坐标", () => {
    const vp: Viewport = { panX: 0, panY: 0, scale: 1 };
    expect(worldToScreen(vp, 42, 99)).toEqual({ x: 42, y: 99 });
  });

  it("平移只影响屏幕坐标，不影响世界坐标", () => {
    const a: Viewport = { panX: 0, panY: 0, scale: 1 };
    const b: Viewport = { panX: 300, panY: -80, scale: 1 };
    const wa = screenToWorld(a, 100, 100);
    const wb = screenToWorld(b, 100 + 300, 100 - 80);
    expect(wa).toEqual(wb);
  });
});

describe("画布 · 缩放", () => {
  it("以光标为锚点缩放时，光标下的那个世界点不动", () => {
    // 不以光标为锚点，滚轮缩放时内容会朝视口中心跑，用户得反复缩放加重平移。
    const cursor = { x: 640, y: 300 };
    const before = screenToWorld(VP, cursor.x, cursor.y);

    for (const factor of [1.2, 0.8, 2, 0.5]) {
      const next = zoomAt(VP, cursor.x, cursor.y, factor);
      const after = screenToWorld(next, cursor.x, cursor.y);
      expect(after.x, `倍率 ${factor} 后锚点漂了`).toBeCloseTo(before.x, 6);
      expect(after.y, `倍率 ${factor} 后锚点漂了`).toBeCloseTo(before.y, 6);
    }
  });

  it("连续缩放多次，锚点依然不漂", () => {
    // 单步正确不代表累积正确：每一步的舍入会攒起来
    const cursor = { x: 700, y: 400 };
    const before = screenToWorld(VP, cursor.x, cursor.y);
    let vp = VP;
    for (let i = 0; i < 20; i++) vp = zoomAt(vp, cursor.x, cursor.y, 1.1);
    const after = screenToWorld(vp, cursor.x, cursor.y);
    expect(after.x).toBeCloseTo(before.x, 4);
    expect(after.y).toBeCloseTo(before.y, 4);
  });

  it("倍率被夹在上下限之间", () => {
    let vp: Viewport = { panX: 0, panY: 0, scale: 1 };
    for (let i = 0; i < 50; i++) vp = zoomAt(vp, 500, 300, 1.5);
    expect(vp.scale).toBe(MAX_SCALE);

    vp = { panX: 0, panY: 0, scale: 1 };
    for (let i = 0; i < 50; i++) vp = zoomAt(vp, 500, 300, 0.7);
    expect(vp.scale).toBe(MIN_SCALE);
  });

  it("已经顶到上限时继续放大，视口完全不变", () => {
    // 不返回原值的话，滚到顶后继续滚会持续改 pan，表现为缩不动但画面还在漂。
    const at: Viewport = { panX: 12, panY: 34, scale: MAX_SCALE };
    expect(zoomAt(at, 500, 300, 1.5)).toBe(at);

    const atMin: Viewport = { panX: 12, panY: 34, scale: MIN_SCALE };
    expect(zoomAt(atMin, 500, 300, 0.5)).toBe(atMin);
  });

  it("非法倍率不会污染视口", () => {
    expect(clampScale(NaN)).toBe(1);
    expect(clampScale(Infinity)).toBe(MAX_SCALE);
    expect(clampScale(-3)).toBe(MIN_SCALE);
  });
});

describe("画布 · 平移", () => {
  it("平移就是加", () => {
    const vp = panBy({ panX: 0, panY: 0, scale: 1 }, 30, -20);
    expect(vp).toEqual({ panX: 30, panY: -20, scale: 1 });
  });

  it("平移被夹在软边界内 —— 无限画布也不会真飘到无穷远", () => {
    const far = panBy({ panX: 0, panY: 0, scale: 1 }, 999_999, -999_999);
    expect(far.panX).toBe(PAN_LIMIT);
    expect(far.panY).toBe(-PAN_LIMIT);

    const back = panBy(far, 999_999, -999_999);
    expect(back.panX).toBe(PAN_LIMIT);
    expect(back.panY).toBe(-PAN_LIMIT);
  });

  it("边界远到用不上 —— 100000 像素 ≈ 625 格", () => {
    // 这条是给无限画布会不会太小这个疑问留的证据：
    // 流水线几十个节点，永远碰不到这条线
    expect(PAN_LIMIT / CELL).toBeGreaterThan(600);
  });

  it("非有限值被挡掉", () => {
    expect(clampPan(NaN)).toBe(0);
    expect(clampPan(Infinity)).toBe(PAN_LIMIT);
    expect(clampPan(-Infinity)).toBe(-PAN_LIMIT);
  });
});

describe("画布 · 初始视口", () => {
  it("核心格落在视口偏上的位置，而不是正中", () => {
    const vp = homeViewport(1200, 800);
    const s = worldToScreen(vp, HOME_WORLD.x, HOME_WORLD.y);
    // 横向正中
    expect(s.x).toBeCloseTo(600, 6);
    // 纵向偏上
    expect(s.y).toBeCloseTo(800 * HOME_SCREEN_Y_RATIO, 6);
    expect(s.y).toBeLessThan(400);
  });

  it("核心格是第 3 列第 2 行", () => {
    expect(HOME_COL).toBe(3);
    expect(HOME_ROW).toBe(2);
    // 第 3 列的中心 = 2.5 格；第 2 行的中心 = 1.5 格
    expect(HOME_WORLD.x).toBeCloseTo(2.5 * CELL, 9);
    expect(HOME_WORLD.y).toBeCloseTo(1.5 * CELL, 9);
  });

  it("核心格在视口里是偏上的 —— 下面要留地方长", () => {
    // 流水线从上往下长：核心格放偏上，往下加东西时不用先平移。
    const H = 900;
    const vp = homeViewport(1400, H);
    const s = worldToScreen(vp, HOME_WORLD.x, HOME_WORLD.y);
    expect(s.y).toBeLessThan(H / 2); // 在水平中线以上
  });

  it("可以按给定倍率对准任意世界点", () => {
    const vp = viewportCenteredOn(1000, 2000, 800, 600, 2);
    expect(vp.scale).toBe(2);
    const s = worldToScreen(vp, 1000, 2000);
    expect(s.x).toBeCloseTo(400, 6);
    expect(s.y).toBeCloseTo(300, 6);
  });
});

describe("画布 · 显示", () => {
  it("倍率显示成百分比", () => {
    expect(formatScale(1)).toBe("100%");
    expect(formatScale(0.5)).toBe("50%");
    expect(formatScale(2.5)).toBe("250%");
  });

  // 曾经做过网格 LOD，但它和单调性冲突：放大反而更密。
  // 去掉之后网格间距就是 CELL 乘以倍率。
  it("网格间距就是 格宽 × 倍率，没有隐藏换档", () => {
    for (const s of [0.2, 0.25, 0.5, 1, 2, 4]) {
      expect(gridStepScreen(s), `倍率 ${s}`).toBeCloseTo(CELL * s, 9);
    }
  });

  it("倍数越大，格子只会更疏，不会更密", () => {
    // 单调性。这条断言当初逼掉了 LOD，它比密度恒定更值得守：
    // 轻微放大时网格突然变密一次，比格子稍密更让人分神。
    let prev = 0;
    for (const s of [0.2, 0.3, 0.5, 1, 1.5, 2, 3, 4]) {
      const step = gridStepScreen(s);
      expect(step, `倍率 ${s} 时格子反而变密了`).toBeGreaterThanOrEqual(prev);
      prev = step;
    }
  });

  it("缩到最小倍率时间距仍然看得清", () => {
    // 这条是不需要 LOD 的依据：32px 不糊
    expect(gridStepScreen(MIN_SCALE)).toBeGreaterThanOrEqual(30);
  });
});
