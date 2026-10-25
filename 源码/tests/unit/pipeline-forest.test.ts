import { describe, expect, it } from "vitest";
import {
  childIndex,
  checksToChildren,
  summarizeChildren,
  toLayoutNodes,
  type ChildrenByStage,
} from "@/core/pipeline/forest";
import type { CheckResult } from "@/core/domain/check";
import type { StageId } from "@/core/pipeline/stages";

/**
 * 子树拼装的单测
 * ============================================================
 * 这个文件管的是「画布上除了六个骨架节点之外，还画出什么」。
 * 所以最要紧的一组是**不该有子节点的时候一个都不给** ——
 * 图上多画一个方块，比少画一个更容易让人误解。
 */

const SEVEN: CheckResult[] = [
  { name: "完整 HTML 结构", pass: true, detail: "含 <html> 与 </html>" },
  { name: "内联样式", pass: true, detail: "含 <style> 块" },
  { name: "内联脚本", pass: true, detail: "含 <script> 块" },
  { name: "完全自包含（无外部引用）", pass: true, detail: "没有任何指向外部的引用" },
  { name: "有事件处理", pass: false, detail: "没找到任何事件绑定" },
  { name: "数据能持久化", pass: true, detail: "用到了 localStorage" },
  { name: "中文界面", pass: true, detail: "含 86 个中文字符" },
];

const SIX: StageId[] = ["spec", "arch", "ui", "build", "assemble", "verify"];

describe("检查结果 → 子节点", () => {
  it("七项检查变成七个子节点", () => {
    expect(checksToChildren(SEVEN)).toHaveLength(7);
  });

  it("每一项都归到「验收与交付」名下", () => {
    expect(checksToChildren(SEVEN).every((c) => c.stage === "verify")).toBe(true);
  });

  it("通过与否映到 tone 上", () => {
    const kids = checksToChildren(SEVEN);
    expect(kids[0].tone).toBe("pass");
    expect(kids[4].tone).toBe("fail");
    expect(kids[4].label).toBe("有事件处理");
  });

  it("每项都带着自己的依据 —— 界面上要能说出「凭什么」", () => {
    for (const k of checksToChildren(SEVEN)) {
      expect(k.detail.length, `${k.label} 没有依据`).toBeGreaterThan(0);
    }
  });

  it("id 用检查项名字，不用下标", () => {
    /*
      用下标的话，检查项顺序一变，React 会把"通过"那个方块复用到
      "失败"那一项上 —— 颜色闪一下，而状态是错的。
      这条断言钉住 id 是可读且稳定的。
    */
    const kids = checksToChildren(SEVEN);
    expect(kids[0].id).toBe("verify:完整 HTML 结构");
    expect(new Set(kids.map((k) => k.id)).size).toBe(kids.length);
  });

  it("检查是同步跑完的一条流水，所以是 stream（可以真的逐个出现）", () => {
    expect(checksToChildren(SEVEN).every((c) => c.reveal === "stream")).toBe(true);
  });
});

describe("不该有子节点的时候一个都不给", () => {
  it("null / undefined / 空数组都返回空", () => {
    expect(checksToChildren(null)).toEqual([]);
    expect(checksToChildren(undefined)).toEqual([]);
    expect(checksToChildren([])).toEqual([]);
  });

  it("没有子节点的工序在森林里就是一片叶子，不带空 children 数组", () => {
    /*
      ⚠️ 这一条防的是「空数组也算有子节点」。
      布局里 `children: []` 和 `children: undefined` 结果一样，
      但渲染层如果按 `children !== undefined` 判断"要不要画展开箭头"，
      就会给六道工序全都画上一个指向虚无的箭头。
    */
    const nodes = toLayoutNodes(SIX, {});
    expect(nodes).toHaveLength(6);
    for (const n of nodes) {
      expect(n.children, `${n.id} 带了空 children`).toBeUndefined();
    }
  });
});

describe("拼森林", () => {
  const byStage: ChildrenByStage = {
    verify: checksToChildren(SEVEN),
    build: [
      {
        id: "build:m1",
        stage: "build",
        label: "模块 1",
        detail: "",
        tone: "plain",
        reveal: "batch",
      },
    ],
  };

  it("六道工序都在，顺序不变", () => {
    expect(toLayoutNodes(SIX, byStage).map((n) => n.id)).toEqual(SIX);
  });

  it("只有真有子节点的那几步长出子树", () => {
    const nodes = toLayoutNodes(SIX, byStage);
    const withKids = nodes.filter((n) => n.children).map((n) => n.id);
    expect(withKids).toEqual(["build", "verify"]);
  });

  it("子节点的 id 原样带进布局", () => {
    const verify = toLayoutNodes(SIX, byStage).find((n) => n.id === "verify")!;
    expect(verify.children!.map((c) => c.id)).toEqual(checksToChildren(SEVEN).map((c) => c.id));
  });

  it("没有子节点的工序不会因为别人有子树而错位", () => {
    const flat = toLayoutNodes(SIX, {});
    const grown = toLayoutNodes(SIX, byStage);
    expect(grown.map((n) => n.id)).toEqual(flat.map((n) => n.id));
  });
});

describe("查表", () => {
  it("按 id 能查到那一条的数据", () => {
    const idx = childIndex({ verify: checksToChildren(SEVEN) });
    expect(idx.get("verify:有事件处理")?.tone).toBe("fail");
    expect(idx.size).toBe(7);
  });

  it("空表不炸", () => {
    expect(childIndex({}).size).toBe(0);
  });

  it("两个工序的子节点不会互相覆盖", () => {
    const idx = childIndex({
      verify: checksToChildren(SEVEN),
      build: [
        { id: "build:x", stage: "build", label: "x", detail: "", tone: "plain", reveal: "batch" },
      ],
    });
    expect(idx.size).toBe(8);
  });
});

describe("角标用的汇总", () => {
  it("数出总数和失败数", () => {
    expect(summarizeChildren(checksToChildren(SEVEN))).toEqual({ total: 7, failed: 1 });
  });

  it("空的一批是 0/0，而不是 NaN", () => {
    expect(summarizeChildren([])).toEqual({ total: 0, failed: 0 });
  });
});