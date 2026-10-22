import { describe, expect, it } from "vitest";
import {
  FAULT_ACTION,
  FAULT_LABEL,
  STAGES,
  STAGE_MAP,
  STAGE_ORDER,
  type FaultClass,
} from "@/core/pipeline/stages";

/**
 * 这些测试不是为了覆盖率，是为了把「架构不变量」固化下来。
 * 任何一次改动如果破坏了下面任何一条，CI/本地验证会立刻失败。
 */
describe("六阶段流水线定义", () => {
  it("恰好六个阶段，序号从 1 连续排到 6", () => {
    expect(STAGES).toHaveLength(6);
    expect(STAGES.map((s) => s.order)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("阶段 id 不重复", () => {
    const ids = STAGES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("阶段顺序与数组顺序一致", () => {
    STAGES.forEach((stage, index) => {
      expect(stage.order).toBe(index + 1);
    });
  });

  it("每个阶段都写明了「存在的理由」，且理由足够具体", () => {
    for (const stage of STAGES) {
      expect(stage.rationale.length).toBeGreaterThan(15);
    }
  });

  it("每个阶段都声明了结构化产物，且产物是 JSON", () => {
    for (const stage of STAGES) {
      expect(stage.artifact).toMatch(/\.json$/);
    }
  });

  it("每个阶段都至少有一条可机器判定的验收标准", () => {
    for (const stage of STAGES) {
      expect(stage.acceptance.length).toBeGreaterThan(0);
      for (const item of stage.acceptance) {
        expect(item.trim().length).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("验收标准不得包含不可判定的措辞 —— 这是「可机器判定」的实质要求", () => {
    // 「界面美观」「尽量流畅」这类说法无法判定，一旦出现，第⑥阶段的自动验收就无从谈起
    const vague = [
      "尽量",
      "尽可能",
      "美观",
      "友好",
      "待定",
      "差不多",
      "基本",
      "等等",
      "酌情",
    ];
    for (const stage of STAGES) {
      for (const item of stage.acceptance) {
        for (const word of vague) {
          expect(item).not.toContain(word);
        }
      }
    }
  });
});

describe("回退回路（这是它不是瀑布模型的证据）", () => {
  it("回退目标必须真实存在", () => {
    for (const stage of STAGES) {
      for (const target of stage.fallbackTo) {
        expect(STAGE_MAP[target]).toBeDefined();
      }
    }
  });

  it("回退目标必须早于自身 —— 骨架线性，回退只能往回", () => {
    for (const stage of STAGES) {
      for (const target of stage.fallbackTo) {
        expect(STAGE_ORDER[target]).toBeLessThan(stage.order);
      }
    }
  });

  it("回退目标不得重复", () => {
    for (const stage of STAGES) {
      expect(new Set(stage.fallbackTo).size).toBe(stage.fallbackTo.length);
    }
  });

  it("第一个阶段没有回退目标（它前面没有人）", () => {
    expect(STAGE_MAP.spec.fallbackTo).toHaveLength(0);
  });

  it("最后一个阶段可以退回到前面每一个阶段 —— 验收发现问题时能一路回退到源头", () => {
    expect(STAGE_MAP.verify.fallbackTo).toHaveLength(STAGES.length - 1);
  });
});

describe("人工门禁", () => {
  it("全流程只有第一个阶段设人工门禁 —— 确认「什么算做完了」之后全自动", () => {
    const gated = STAGES.filter((s) => s.humanGate).map((s) => s.id);
    expect(gated).toEqual(["spec"]);
  });
});

describe("失败归因四分类", () => {
  const faults: FaultClass[] = ["environment", "code", "model", "spec"];

  it("四类失败都有中文标签", () => {
    for (const fault of faults) {
      expect(FAULT_LABEL[fault]).toBeTruthy();
    }
  });

  it("四类失败都有各自的处置动作，且互不相同 —— 这是「分流」而非「无差别重试」", () => {
    const actions = faults.map((f) => FAULT_ACTION[f]);
    for (const action of actions) {
      expect(action.length).toBeGreaterThan(5);
    }
    expect(new Set(actions).size).toBe(faults.length);
  });

  it("环境错的处置动作明确要求「不调用模型」—— 这是省 token 的真正来源", () => {
    expect(FAULT_ACTION.environment).toContain("不调用模型");
  });

  it("规格错的处置动作明确要求转人工 —— 正确的失败是停下来问用户，不是烧钱重试", () => {
    expect(FAULT_ACTION.spec).toContain("人工");
  });
});