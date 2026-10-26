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
 * 缩小时文字该让位 —— 分档的纯函数
 * ============================================================
 * 这条逻辑小到不值得单测？不。
 *
 * 它决定了「缩小之后屏幕上还剩什么」。写错一档的后果是
 * **卡片上糊着一层 6 像素的灰渣**，而那正是这次要消灭的东西。
 * 而且它是纯函数，测起来一分钱不花。
 */

describe("labelTier", () => {
  it("倍率够大时全都显示", () => {
    expect(labelTier(1)).toBe("all");
    expect(labelTier(MAX_SCALE)).toBe("all");
  });

  it("阈值本身就是「全都显示」那一档 —— 边界取闭区间", () => {
    /*
      边界写成开区间的话，正好落在 0.62 时字会突然消失一次，
      而 0.62 恰恰是常用倍率（工作台面板自动适应就是这个值）。
    */
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
    /*
      这条是防「轻微放大反而字没了」的。
      界面里所有"随缩放变化"的东西都有这个陷阱：
      写成分段的 if-else 时很容易在某一段里接反。
    */
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

/**
 * 自动适应的缩放下限
 * ============================================================
 * 这一条以前只有工作台面板有，四分布局之后整页画布也有了 ——
 * 左清单 17rem + 右内容 22rem 吃掉 624px，1440 屏上画布只剩 786px。
 *
 * 这里测的不是"某个数字对不对"，而是**那条下限到底有没有用**：
 * 没有它，自动适应会把画面缩到档位 none（六张卡一个字都看不见）；
 * 有它，工序名和序号还在。下面最后两条用真实的几何和真实的屏宽算一遍 ——
 * 这样以后谁改了面板宽度或者几何，这里会立刻红。
 */
describe("fitFloor", () => {
  it("面板档留到「次要文字」那一档，整页档留到「工序名」那一档", () => {
    expect(fitFloor("panel")).toBe(LABEL_MINOR_SCALE);
    expect(fitFloor("page")).toBe(LABEL_MAJOR_SCALE);
  });

  it("下限本身不会落进「字全没了」那一档", () => {
    /*
      下限如果落在档位下方，自动适应就会把一个"没有字"的画面
      当成合适的初始视口 —— 那不是缩小，是视觉上把内容删了。
    */
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

    /*
      代价也要写下来，别让下一个人以为它是免费的：
      下限生效时整条流水线比画布宽 —— 最外侧两张卡各被切掉一点。
      这一条守的是"切掉多少"的量级：只有几十像素（对得上"基本都在画布里"），
      不是几百像素（那就变成"最后两道得先平移才看得见"）。
    */
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

/* ============================================================
   「看全」这个出口：同一个区域，只差一个下限
   ============================================================
   画布右下角那个「看全」按钮做的就是下面第一行 —— 把 minScale 传 0。
   它和默认路径**用的区域完全相同**（都是整棵树的包围盒），
   差别只有这一条下限。所以这一组断言测的不是按钮，是那条下限：

     传下限  → 停在 45%（工序名还看得见），代价是最外侧被切掉一点
     传 0    → 缩到 20% 上下（字读不清了），但整棵树真的全在视口里

   两条都要钉住，因为它们是一对**取舍**：
   只有第一条，「看全」就不叫看全（点了还是看不全）；
   只有第二条，默认视图就会变成一张看不清的全景图。
   ⚠️ 这一组不碰 fitFloor 的取值 —— 它守的是"两个出口都还在"。
   ============================================================ */
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
    /*
      这是这个按钮的**唯一**验收标准。
      只算一个方向的话，"缩到很小"这个行为本身就能让下式成立，
      而内容可能还横着溢出去 —— 那按钮就白叫「看全」了。
    */
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
    /*
      下限传 0 不等于"无限制"：clampScale 那道 0.2 的全局夹紧还在。
      它防的是"点了看全之后画布上一片空白"——
      那是比"读不清字"更糟的结果：用户会以为内容没了。
    */
    const tiny = fitViewport({ x: 0, y: 0, w: 20000, h: 20000 }, canvasW, canvasH, 56, 0);
    expect(tiny.scale).toBeGreaterThanOrEqual(MIN_SCALE);
  });
});