import { describe, expect, it } from "vitest";
import {
  LABEL_MAJOR_SCALE,
  LABEL_MINOR_SCALE,
  MAX_SCALE,
  MIN_SCALE,
  fitFloor,
  fitViewport,
  labelTier,
} from "@/core/canvas/viewport";
import { WIDE_GEOMETRY, pipelineBounds } from "@/core/canvas/pipeline-layout";
import { STAGES } from "@/core/pipeline/stages";

/**
 * 保护缩小时的文字分档：阈值闭区间、单调、自动适应的缩放下限，以及看全与默认两个出口。
 * 分档写错的表现是卡片上糊着一层读不清的灰渣。
 */

describe("labelTier", () => {
  it("倍率够大时全都显示", () => {
    expect(labelTier(1)).toBe("all");
    expect(labelTier(MAX_SCALE)).toBe("all");
  });

  it("阈值本身就是「全都显示」那一档 —— 边界取闭区间", () => {
    // 边界写成开区间时，正好 0.62 会突然没字，而工作台面板适应后正是 0.62。
    expect(labelTier(LABEL_MINOR_SCALE)).toBe("all");
    expect(labelTier(LABEL_MAJOR_SCALE)).toBe("major");
  });

  it("中间档只藏次要文字，工序名和序号还留着", () => {
    const mid = (LABEL_MINOR_SCALE + LABEL_MAJOR_SCALE) / 2;
    expect(labelTier(mid)).toBe("major");
  });

  it("再往下就只剩色块", () => {
    expect(labelTier(LABEL_MAJOR_SCALE - 0.01)).toBe("none");
    expect(labelTier(MIN_SCALE)).toBe("none");
  });

  it("分档随倍率单调 —— 放大只会显示得更多，不会更少", () => {
    // 分段 if-else 容易在某一段接反：轻微放大反而字没了。
    const rank = { none: 0, major: 1, all: 2 } as const;
    let prev = -1;
    for (let s = MIN_SCALE; s <= MAX_SCALE; s += 0.01) {
      const r = rank[labelTier(s)];
      expect(r, `倍率 ${s.toFixed(2)} 处档位倒退了`).toBeGreaterThanOrEqual(prev);
      prev = r;
    }
  });

  it("两个阈值都落在合法的倍率区间里", () => {
    for (const t of [LABEL_MINOR_SCALE, LABEL_MAJOR_SCALE]) {
      expect(t).toBeGreaterThanOrEqual(MIN_SCALE);
      expect(t).toBeLessThanOrEqual(MAX_SCALE);
    }
    expect(LABEL_MAJOR_SCALE).toBeLessThan(LABEL_MINOR_SCALE);
  });
});

// 下限决定自动适应停在哪一档：没有它，1440 屏四分布局会缩到字全没。
// 最后两条用真实几何与真实屏宽算一遍，改了面板宽度或几何就会红。
describe("fitFloor", () => {
  it("面板档留到「次要文字」那一档，整页档留到「工序名」那一档", () => {
    expect(fitFloor("panel")).toBe(LABEL_MINOR_SCALE);
    expect(fitFloor("page")).toBe(LABEL_MAJOR_SCALE);
  });

  it("下限本身不会落进「字全没了」那一档", () => {
    // 下限若落在档位下方，自动适应会把一个没有字的画面当成合适视口。
    expect(labelTier(fitFloor("panel"))).toBe("all");
    expect(labelTier(fitFloor("page"))).toBe("major");
    for (const v of ["page", "panel"] as const) {
      expect(fitFloor(v)).toBeGreaterThanOrEqual(MIN_SCALE);
      expect(fitFloor(v)).toBeLessThanOrEqual(MAX_SCALE);
    }
  });

  it("1440 屏四分布局下：不设下限会缩到 36%（字全没），设了下限停在 45%", () => {
    const bounds = pipelineBounds(STAGES.length, WIDE_GEOMETRY);
    /** 左清单 17rem = 272px，右内容 22rem = 352px */
    const canvasW = 1440 - 272 - 352;
    /** 画布实测高度（e2e 里量出来的 1410×609 那个数） */
    const canvasH = 609;

    const naive = fitViewport(bounds, canvasW, canvasH, 56, 0);
    expect(naive.scale).toBeLessThan(LABEL_MAJOR_SCALE);
    expect(labelTier(naive.scale)).toBe("none");

    const floored = fitViewport(bounds, canvasW, canvasH, 56, fitFloor("page"));
    expect(floored.scale).toBe(fitFloor("page"));
    expect(labelTier(floored.scale)).toBe("major");

    // 代价写下来：下限生效时整条比画布宽，最外侧两张卡各被切掉一点。
    // 断言守的是量级：几十像素，不是几百像素。
    const drawnW = bounds.w * floored.scale;
    expect(drawnW - canvasW).toBeLessThan(120);
  });

  it("宽屏上不该被下限碰到 —— 1920 屏仍然是「装下整条 + 字全在」", () => {
    const bounds = pipelineBounds(STAGES.length, WIDE_GEOMETRY);
    const canvasW = 1920 - 272 - 352;
    const vp = fitViewport(bounds, canvasW, 900, 56, fitFloor("page"));
    expect(vp.scale).toBeGreaterThan(fitFloor("page"));
    expect(labelTier(vp.scale)).toBe("all");
    expect(bounds.w * vp.scale).toBeLessThanOrEqual(canvasW);
  });
});

// 看全按钮就是把 minScale 传 0，与默认路径用同一个区域，只差这条下限。
// 传下限停在 45%，传 0 缩到 20% 上下，两个出口都要在。
// 这一组不碰 fitFloor 的取值。
describe("看全 vs 默认：同一条下限的两个出口", () => {
  /** 三层树量出来的真实包围盒（e2e 里量到的 1832×1064） */
  const tree = { x: 400, y: 162, w: 1832, h: 1064 };
  /** 四分布局之后画布实测 770×330 */
  const canvasW = 770;
  const canvasH = 330;

  it("同一个包围盒：默认停在下限上，看全缩到下限以下", () => {
    const byDefault = fitViewport(tree, canvasW, canvasH, 56, fitFloor("page"));
    const fitAll = fitViewport(tree, canvasW, canvasH, 56, 0);

    expect(byDefault.scale).toBe(fitFloor("page"));
    expect(fitAll.scale).toBeLessThan(fitFloor("page"));
    // 而且小得**看得出来**：不是 44% 这种"差一点点"
    expect(fitAll.scale).toBeLessThan(0.4);
  });

  it("看全之后，整棵树在**两个方向**上都装得下（这正是它存在的理由）", () => {
    // 按钮唯一的验收标准：两个方向都装得下；只算一个方向的话，缩得很小也能成立。
    const fitAll = fitViewport(tree, canvasW, canvasH, 56, 0);
    expect(tree.w * fitAll.scale).toBeLessThanOrEqual(canvasW - 56 * 2 + 1e-6);
    expect(tree.h * fitAll.scale).toBeLessThanOrEqual(canvasH - 56 * 2 + 1e-6);
  });

  it("默认视图确实装不下 —— 这就是它被下限挡住的那个代价", () => {
    // 反过来证明上面那条不是白给的：默认视口下整棵树是装不下的
    const byDefault = fitViewport(tree, canvasW, canvasH, 56, fitFloor("page"));
    expect(tree.w * byDefault.scale).toBeGreaterThan(canvasW);
  });

  it("看全不会缩到「看不见」那一档以下 —— MIN_SCALE 仍然兜着底", () => {
    // 下限传 0 不等于无限制：clampScale 的 0.2 全局夹紧仍在，防点了看全后一片空白。
    const tiny = fitViewport({ x: 0, y: 0, w: 20000, h: 20000 }, canvasW, canvasH, 56, 0);
    expect(tiny.scale).toBeGreaterThanOrEqual(MIN_SCALE);
  });
});