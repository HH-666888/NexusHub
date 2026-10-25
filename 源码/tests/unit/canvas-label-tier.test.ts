import { describe, expect, it } from "vitest";
import {
  LABEL_MAJOR_SCALE,
  LABEL_MINOR_SCALE,
  MAX_SCALE,
  MIN_SCALE,
  labelTier,
} from "@/core/canvas/viewport";

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