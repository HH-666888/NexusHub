import { describe, expect, it } from "vitest";
import {
  FAULT_ACTION,
  FAULT_LABEL,
  STAGES,
  STAGE_MAP,
  STAGE_ORDER,
  isStageId,
  type FaultClass,
  type StageId,
} from "@/core/pipeline/stages";
import {
  computeStageStatuses,
  countPlanned,
  wiredStages,
} from "@/core/pipeline/progress";

/**
 * 保护流水线定义与进度推算：未接入的工序不显示已通过、阶段定义与回退回路、
 * 人工门禁、失败归因分类、isStageId 收窄与 blockedBy 语义。
 */
describe("流水线进度推算", () => {
  const allStages = STAGES.map((s) => s.id);

  it("每道工序都有实现状态，且取值合法", () => {
    for (const s of STAGES) {
      expect(
        ["wired", "direct", "planned"],
        `工序 ${s.id} 的实现状态不合法`,
      ).toContain(s.implementation);
    }
  });

  it("【关键】未接入的工序永远不能显示成「已通过」", () => {
    const planned = STAGES.filter((s) => s.implementation === "planned");
    expect(planned.length).toBeGreaterThan(0); // 当前确实还有没接入的

    // 把所有可能的进度组合都试一遍：无论跑到哪一步、什么状态，
    // 未接入的工序都不能变成已通过
    const statuses = ["running", "paused", "done", "failed"] as const;
    for (const stage of allStages) {
      for (const status of statuses) {
        const result = computeStageStatuses({ stage, status });
        for (const p of planned) {
          expect(
            result[p.id],
            `运行到 ${stage}/${status} 时，未接入的 ${p.id} 竟然显示为 ${result[p.id]}`,
          ).not.toBe("passed");
        }
      }
    }
  });

  it("运行完成时，已接入且已跑过的工序才显示「已通过」", () => {
    const done = computeStageStatuses({ stage: "verify", status: "done" });

    // 规格化、构建、验收都已接入，应当显示已通过。
    // 断言写死的值会随实现推进而过期，下面那条通用断言更重要。
    expect(done.spec).toBe("passed");
    expect(done.build).toBe("passed");
    expect(done.verify).toBe("passed");

    // 架构定型这一期接上了：跑到 verify 时它确实跑过并交出了产物，
    // 再断言 pending 就变成把做成了的说成没做成。
    expect(done.arch).toBe("passed");

    // 界面设计同样接上了：跑到 verify 时它确实跑过并交出了产物。
    // 下面的兜底断言按 implementation 动态取，仍守着真正的底线。
    expect(done.ui).toBe("passed");

    // 还没接入的一律 pending
    expect(done.assemble).toBe("pending");
  });

  it("【兜底断言】凡是标为未接入的工序，无论跑到哪一步都必须是 pending", () => {
    // 上一条写死了具体工序，会随实现推进过期。
    // 这一条按 implementation 动态取：没接入的工序永远不能显示成已通过。
    const planned = STAGES.filter((s) => s.implementation === "planned");
    expect(planned.length).toBeGreaterThan(0);

    for (const stage of [
      { stage: "spec", status: "running" },
      { stage: "build", status: "running" },
      { stage: "verify", status: "done" },
      { stage: "verify", status: "failed" },
      { stage: "assemble", status: "done" },
    ] as const) {
      const statuses = computeStageStatuses(stage);
      for (const p of planned) {
        expect(
          statuses[p.id],
          `运行到 ${stage.stage}/${stage.status} 时，未接入的 ${p.id} 显示成了 ${statuses[p.id]}`,
        ).toBe("pending");
      }
    }
  });

  it("没有选中运行时，所有工序都是待执行", () => {
    const none = computeStageStatuses(null);
    for (const id of allStages) expect(none[id]).toBe("pending");
  });

  it("停在构建阶段时，验收阶段是待执行而不是已通过", () => {
    const mid = computeStageStatuses({ stage: "build", status: "running" });
    expect(mid.build).toBe("running");
    expect(mid.verify).toBe("pending");
  });

  it("运行失败时，当前工序显示失败，后续仍是待执行", () => {
    const failed = computeStageStatuses({ stage: "build", status: "failed" });
    expect(failed.build).toBe("failed");
    expect(failed.verify).toBe("pending");
  });

  it("需要人工介入时显示为「需人工」而不是失败", () => {
    const paused = computeStageStatuses({ stage: "build", status: "paused" });
    expect(paused.build).toBe("blocked");
  });

  it("countPlanned 与实际未接入数量一致", () => {
    expect(countPlanned()).toBe(
      STAGES.filter((s) => s.implementation === "planned").length,
    );
  });

  it("wiredStages 只返回真正有产物的工序", () => {
    const wired = wiredStages();
    expect(wired.length).toBeGreaterThan(0);
    for (const s of wired) expect(s.implementation).not.toBe("planned");
    // 未接入的工序不该出现在这个列表里 ——
    // 界面右侧用它来决定列哪些契约，列出来会让人以为产物已经存在
    for (const s of STAGES.filter((x) => x.implementation === "planned")) {
      expect(wired.map((w) => w.id as StageId)).not.toContain(s.id);
    }
  });
});

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
    // 界面美观、尽量流畅这类说法无法判定，一旦出现，第⑥阶段的自动验收就无从谈起
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

// isStageId 把 string 收窄成 StageId：任务点 id 是 string，画布要联合类型。
// 判错的后果不是崩溃，而是聚焦到不存在的工序，视口只是没动。
describe("isStageId", () => {
  it("六道工序的 id 全部认", () => {
    for (const stage of STAGES) {
      expect(isStageId(stage.id)).toBe(true);
    }
  });

  it("别的字符串一个都不认", () => {
    for (const junk of [
      "",
      "SPEC",
      "spec ",
      " spec",
      "builds",
      "agent-root",
      "verify:完整 HTML 结构",
      "0",
    ]) {
      expect(isStageId(junk)).toBe(false);
    }
  });

  it("原型链上的键不算工序 —— 用 in 写会在这里红", () => {
    // constructor 在 STAGE_MAP 上为 true（来自 Object.prototype），脏数据会被当成真工序。
    // 所以用 hasOwnProperty；from-run.ts 判 phase 时踩过同一个坑。
    for (const proto of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
      expect(isStageId(proto)).toBe(false);
    }
  });

  it("认出来的 id 确实能查到工序定义 —— 收窄之后可以放心用", () => {
    // 这条是"收窄"这件事的实质：过了这关就一定有对应的工序，
    // 于是下游（聚焦、STAGE_MAP[id].name）不会拿到 undefined
    for (const stage of STAGES) {
      if (isStageId(stage.id)) {
        expect(STAGE_MAP[stage.id]).toBeDefined();
        expect(STAGE_MAP[stage.id].name.length).toBeGreaterThan(0);
      }
    }
  });
});

// assemble 的三条验收标准要求真的把应用跑起来，而产物是单文件 HTML、没有沙箱。
// 所以这一道如实标成 planned，并把原因写在 blockedBy 上。
// 下面三条守语义边界：planned 必须说得出卡点，已接入的不许挂着过期原因。
describe("★ blockedBy：未接入的工序必须说清卡在哪", () => {
  it("所有 implementation === \"planned\" 的工序，blockedBy 必须存在且非空", () => {
    const planned = STAGES.filter((s) => s.implementation === "planned");
    // 前提：当前确实还有没接入的工序。都为 wired 时这组用例就成了空转
    expect(planned.length).toBeGreaterThan(0);

    for (const s of planned) {
      expect(
        s.blockedBy,
        `工序 ${s.id} 标着未接入，却没说卡在哪 —— 界面上只会剩一句「待规划」`,
      ).toBeTruthy();
      expect(
        (s.blockedBy ?? "").trim().length,
        `工序 ${s.id} 的 blockedBy 是空的（或只有空白）`,
      ).toBeGreaterThan(0);
    }
  });

  it("所有已接入（wired / direct）的工序，不该有 blockedBy", () => {
    const wired = STAGES.filter((s) => s.implementation !== "planned");
    // 前提：确实有已接入的工序，否则这条也是空转
    expect(wired.length).toBeGreaterThan(0);

    for (const s of wired) {
      expect(
        s.blockedBy,
        `工序 ${s.id} 已经接入了，却还挂着 blockedBy —— 那是界面在指着一个能用的功能说"它还没接"`,
      ).toBeUndefined();
    }
  });

  it("assemble 的 blockedBy 里必须出现「沙箱」—— 卡点是它，就得说到它", () => {
    // toContain 而不是全等：那句话的措辞可以改，但"卡在哪"这件事不许被改掉
    expect(STAGE_MAP.assemble.blockedBy).toContain("沙箱");
  });
});