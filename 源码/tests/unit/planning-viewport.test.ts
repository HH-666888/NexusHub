import { describe, expect, it } from "vitest";
import { boundsFor, type Bounds, type RunMode } from "@/core/planning/viewport-policy";
import {
  appendBorn,
  projectAt,
  type PlanningEvent,
} from "@/core/planning/planning-log";
import { toOutline } from "@/core/planning/outline";
import { type TaskPoint, type TaskPointStatus } from "@/core/planning/task-point";

/**
 * 保护视口策略：focus 收进单卡、batch 退到全树，两种模式下面树和清单完全一样。
 * 这个文件同时验证数据侧完全不感知模式。
 */

function point(
  id: string,
  parentId: string | null,
  depth: number,
  status: TaskPointStatus,
  bornAtSeq: number,
): TaskPoint {
  return {
    id,
    parentId,
    depth,
    kind: depth <= 2 ? "control" : "exec",
    title: `任务点 ${id}`,
    status,
    bornAtSeq,
  };
}

/** 一整棵长齐了的树：一级 + 两道工序 + 各自的执行点 */
function fullTree(): PlanningEvent[] {
  let log: PlanningEvent[] = [];
  log = appendBorn(log, point("agent-1", null, 1, "planning", 1));
  log = appendBorn(log, point("spec", "agent-1", 2, "pending", 10));
  log = appendBorn(log, point("spec-1", "spec", 3, "running", 12));
  log = appendBorn(log, point("arch", "agent-1", 2, "pending", 20));
  log = appendBorn(log, point("arch-1", "arch", 3, "ready", 22));
  return log;
}

/** 当前正在跑的那张卡的矩形 */
const CARD: Bounds = { x: 120, y: 340, w: 232, h: 112 };
/** 整棵树的包围盒 */
const TREE: Bounds = { x: 0, y: 0, w: 2112, h: 704 };

describe("分支：focus 收进单卡，batch 退到全树", () => {
  it("focus → 返回 focusOn（单次聚焦：视口收进当前那张卡）", () => {
    expect(boundsFor("focus", CARD, TREE)).toEqual(CARD);
  });

  it("batch → 返回 whole（分批执行：不聚焦单卡，看全整棵树）", () => {
    expect(boundsFor("batch", CARD, TREE)).toEqual(TREE);
  });

  it("batch 时哪怕真有一张卡在跑，也不缩进去", () => {
    // batch 没有当前那张卡；写成有 focusOn 就用它，批量执行会一直对着第一张放大。
    const batched = boundsFor("batch", CARD, TREE);
    expect(batched).toEqual(TREE);
    expect(batched).not.toEqual(CARD);
  });

  it("focus 时哪怕整棵树很大，也只返回那一张卡", () => {
    const focused = boundsFor("focus", CARD, TREE);
    expect(focused).toEqual(CARD);
    expect(focused).not.toEqual(TREE);
  });
});

describe("纯函数", () => {
  it("同输入同输出：连调两次结果相同", () => {
    // 没有任何内部状态 —— 这也意味着它可以安全地放进 useMemo 的依赖里
    expect(boundsFor("focus", CARD, TREE)).toEqual(boundsFor("focus", CARD, TREE));
    expect(boundsFor("batch", CARD, TREE)).toEqual(boundsFor("batch", CARD, TREE));
  });

  it("调用顺序不影响结果：先 batch 再 focus 仍然正确", () => {
    // 上一次调用若记住了什么，这一条会红
    boundsFor("batch", CARD, TREE);
    expect(boundsFor("focus", CARD, TREE)).toEqual(CARD);
  });

  it("四个字段原样带过去，不做缩放、不做取整", () => {
    // 策略层不碰几何：这里开始取整，缩放会差半个像素，表现为画面有点糊。
    const fractional: Bounds = { x: 12.5, y: -3.25, w: 232.75, h: 111.5 };
    const whole: Bounds = { x: -0.5, y: 0.25, w: 2112.125, h: 704.875 };
    expect(boundsFor("focus", fractional, whole)).toEqual(fractional);
    expect(boundsFor("batch", fractional, whole)).toEqual(whole);
  });

  it("返回值一定是两个入参之一，不会凭空造一个新矩形", () => {
    const modes: RunMode[] = ["focus", "batch"];
    for (const mode of modes) {
      const got = boundsFor(mode, CARD, TREE);
      expect([CARD, TREE]).toContainEqual(got);
    }
  });

  it("原样返回入参对象，不做拷贝（调用方按只读使用）", () => {
    // 原样返回入参：每次复制会让视口变没变无法用 === 判断，而画布正需要它。
    // 代价写在明处：调用方不要就地改返回值。
    expect(boundsFor("focus", CARD, TREE)).toBe(CARD);
    expect(boundsFor("batch", CARD, TREE)).toBe(TREE);
  });
});

describe("两种模式下面，树和清单完全一样", () => {
  it("同一份日志投影出的清单，与模式无关 —— 差的只有视口矩形", () => {
    // 数据侧不认识也不接受模式参数：两种模式拿到的清单逐行相同，变的只有视口。
    // 谁往 TaskPoint 上加 mode 字段，这条会先红。
    const points = projectAt(fullTree(), 100);
    const outlineInFocus = toOutline(points);
    const outlineInBatch = toOutline(points);
    expect(outlineInBatch).toEqual(outlineInFocus);
    expect(outlineInBatch.length).toBeGreaterThan(0);

    const viewportInFocus = boundsFor("focus", CARD, TREE);
    const viewportInBatch = boundsFor("batch", CARD, TREE);
    expect(viewportInFocus).not.toEqual(viewportInBatch);
  });

  it("模式只影响视口：换模式不会让任何一个任务点多出来或少掉", () => {
    // 同一段数据路径：投影、清单、视口；只有最后一步被 mode 影响。
    const idsIn = (mode: RunMode): string[] => {
      const viewport = boundsFor(mode, CARD, TREE);
      expect(viewport.w).toBeGreaterThan(0);
      return toOutline(projectAt(fullTree(), 100)).map((r) => r.id);
    };
    expect(idsIn("batch")).toEqual(idsIn("focus"));
  });
});
