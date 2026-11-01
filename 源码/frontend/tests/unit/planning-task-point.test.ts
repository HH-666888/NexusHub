import { describe, expect, it } from "vitest";
import {
  CONTROL_LAYER_MAX_DEPTH,
  TASK_POINT_STATUSES,
  TONE_RGB,
  childrenOf,
  hasOrphans,
  isControlLayer,
  rollUpStatus,
  statusLabel,
  statusTone,
  type TaskPoint,
  type TaskPointStatus,
} from "@/core/planning/task-point";

/**
 * 保护任务点基础规则：层级分界、子节点查询、孤儿判定、状态汇总与色调/标签映射。
 * 这几条被画布、清单与运行器共用，改错不会崩，只会让前后视图对不上。
 */

// 造任务点：kind 由 depth 推出来，两者这一期同步；造第 3 层控制点时再单传 kind。
function mk(
  id: string,
  depth: number,
  status: TaskPointStatus,
  parentId: string | null = null,
): TaskPoint {
  return {
    id,
    parentId,
    depth,
    kind: depth <= CONTROL_LAYER_MAX_DEPTH ? "control" : "exec",
    title: `任务点 ${id}`,
    status,
    bornAtSeq: 0,
  };
}

describe("isControlLayer：控制层与执行层的分界", () => {
  it("第 1、2 层是控制层（一级 Agent 与六道工序）", () => {
    expect(isControlLayer(1)).toBe(true);
    expect(isControlLayer(2)).toBe(true);
  });

  it("第 3 层起是执行层", () => {
    expect(isControlLayer(3)).toBe(false);
    expect(isControlLayer(4)).toBe(false);
    expect(isControlLayer(6)).toBe(false);
    expect(isControlLayer(10)).toBe(false);
  });

  it("分界线就是 CONTROL_LAYER_MAX_DEPTH 这个常量本身", () => {
    // 断言的是函数用了那个常量，不是常量等于 2；写死 2 会在扩层时一起错。
    expect(isControlLayer(CONTROL_LAYER_MAX_DEPTH)).toBe(true);
    expect(isControlLayer(CONTROL_LAYER_MAX_DEPTH + 1)).toBe(false);
  });

  it("depth 为 0 或负数也判为控制层 —— 这个函数不负责校验合法性", () => {
    // 0 与负数不是合法深度，但 isControlLayer 只回答在不在控制层，不做校验。
    // 把校验塞进来会让调用方拿不到一个干净的问题答案。
    expect(isControlLayer(0)).toBe(true);
    expect(isControlLayer(-1)).toBe(true);
  });
});

describe("childrenOf：只取直接子节点", () => {
  it("按 parentId 取子节点，保持 points 里的出现顺序（不按 id 排序）", () => {
    // 顺序来自事件日志的出生先后，不按 id 排；这里故意让字典序与出现顺序相反。
    const points = [
      mk("t2", 3, "running", "mid"),
      mk("mid", 2, "planning", "agent-1"),
      mk("t1", 3, "done", "mid"),
    ];
    expect(childrenOf(points, "mid").map((p) => p.id)).toEqual(["t2", "t1"]);
  });

  it("孙子不算儿子", () => {
    // 打平子树会让缩进失去意义：问第 2 层会拿到整棵子树的几十个点。
    const points = [
      mk("mid", 2, "planning", "agent-1"),
      mk("leaf", 3, "done", "mid"),
      mk("deep", 4, "done", "leaf"),
    ];
    expect(childrenOf(points, "agent-1").map((p) => p.id)).toEqual(["mid"]);
    expect(childrenOf(points, "mid").map((p) => p.id)).toEqual(["leaf"]);
    expect(childrenOf(points, "leaf").map((p) => p.id)).toEqual(["deep"]);
  });

  it("叶子节点返回空数组", () => {
    const points = [mk("leaf", 3, "done", "mid")];
    expect(childrenOf(points, "leaf")).toEqual([]);
  });

  it("空列表返回空数组", () => {
    expect(childrenOf([], "whatever")).toEqual([]);
  });

  it("返回的是原对象引用，不做拷贝", () => {
    // 返回原对象引用：同一个任务点在所有视图里是同一个对象，便于用 === 追踪。
    const points = [mk("mid", 2, "planning", "agent-1"), mk("leaf", 3, "done", "mid")];
    expect(childrenOf(points, "mid")[0]).toBe(points[1]);
  });
});

describe("hasOrphans：树必须完整", () => {
  it("一棵完整的树没有孤儿", () => {
    const points = [
      mk("agent-1", 1, "planning", null),
      mk("spec", 2, "planning", "agent-1"),
      mk("spec-1", 3, "done", "spec"),
    ];
    expect(hasOrphans(points)).toBe(false);
  });

  it("父节点不在场时立刻认出来", () => {
    // 孤儿不报错，只会被丢到原点或静默消失，所以要有函数专门回答这个问题。
    const points = [
      mk("agent-1", 1, "planning", null),
      mk("ghost-child", 2, "done", "ghost"),
    ];
    expect(hasOrphans(points)).toBe(true);
  });

  it("parentId 为 null 是根，不是孤儿", () => {
    expect(hasOrphans([mk("agent-1", 1, "planning", null)])).toBe(false);
  });

  it("空列表没有孤儿", () => {
    // 空树是合法的初始状态：什么事都还没发生
    expect(hasOrphans([])).toBe(false);
  });

  it("自引用不算孤儿 —— 环检测被有意划在这一期之外", () => {
    // 已知边界：parentId 等于自身时 id 在场，按定义不算孤儿；环检测不在此函数。
    expect(hasOrphans([mk("loop", 2, "pending", "loop")])).toBe(false);
  });
});

describe("rollUpStatus：六条优先级各钉一条", () => {
  it("① 没有子节点 → pending（不是 done）", () => {
    // every() 对空数组返回 true，会让还没长出执行点的工序显示成已完成。
    expect(rollUpStatus([])).toBe("pending");
  });

  it("② 有任意 running → running，压过 failed / waiting / done", () => {
    // 有 running 就当 running：失败的兄弟不该让整道工序看上去停了。
    const children = [
      mk("a", 3, "failed", "s"),
      mk("b", 3, "waiting", "s"),
      mk("c", 3, "running", "s"),
      mk("d", 3, "done", "s"),
    ];
    expect(rollUpStatus(children)).toBe("running");
  });

  it("② 的反证：把那个 running 拿掉，同样的子节点立刻变成 failed", () => {
    // 反证：去掉 running 后结果必须跟着变，否则命中的是别的分支。
    const children = [mk("a", 3, "failed", "s"), mk("b", 3, "waiting", "s")];
    expect(rollUpStatus(children)).toBe("failed");
  });

  it("③ 无 running 时有 failed → failed，压过 waiting / done", () => {
    // 失败要浮上来，不能被子节点的 done 淹没
    const children = [
      mk("a", 3, "done", "s"),
      mk("b", 3, "failed", "s"),
      mk("c", 3, "waiting", "s"),
    ];
    expect(rollUpStatus(children)).toBe("failed");
  });

  it("④ 无 running/failed 时有 waiting → waiting，压过 done", () => {
    // waiting 是唯一需要用户动手的状态，必须能穿过 done 冒到工序这一层。
    const children = [
      mk("a", 3, "done", "s"),
      mk("b", 3, "done", "s"),
      mk("c", 3, "waiting", "s"),
    ];
    expect(rollUpStatus(children)).toBe("waiting");
  });

  it("⑤ 全部 done → done", () => {
    expect(rollUpStatus([mk("a", 3, "done", "s"), mk("b", 3, "done", "s")])).toBe(
      "done",
    );
    // 单个子节点也成立，不要写成至少两个才算
    expect(rollUpStatus([mk("a", 3, "done", "s")])).toBe("done");
  });

  it("⑥ 有 ready 或 planning → ready", () => {
    expect(rollUpStatus([mk("a", 3, "ready", "s"), mk("b", 3, "pending", "s")])).toBe(
      "ready",
    );
    expect(
      rollUpStatus([mk("a", 3, "planning", "s"), mk("b", 3, "pending", "s")]),
    ).toBe("ready");
  });

  it("⑦ 其余（只有 pending）→ pending", () => {
    expect(rollUpStatus([mk("a", 3, "pending", "s"), mk("b", 3, "pending", "s")])).toBe(
      "pending",
    );
  });

  it("承认的取舍：全是 skipped 时汇总成 pending，而不是 skipped", () => {
    // 取舍：skipped 与 pending 汇总成同一个结果，界面还没有表达部分完成的语言。
    expect(rollUpStatus([mk("a", 3, "skipped", "s")])).toBe("pending");
    expect(rollUpStatus([mk("a", 3, "done", "s"), mk("b", 3, "skipped", "s")])).toBe(
      "pending",
    );
  });

  it("不修改入参", () => {
    const children = [mk("a", 3, "running", "s"), mk("b", 3, "failed", "s")];
    const before = structuredClone(children);
    rollUpStatus(children);
    expect(children).toEqual(before);
  });
});

describe("statusTone：八种状态 → 六种色调", () => {
  it("八种状态每一种都有色调，一种都没漏", () => {
    // 漏配的表现是一个白点，而白是最常见的底色；所以遍历全集，不抽查。
    for (const status of TASK_POINT_STATUSES) {
      expect(statusTone(status), `状态 ${status} 没有色调`).toBeTruthy();
    }
    expect(TASK_POINT_STATUSES).toHaveLength(8);
  });

  it("绿 = 正在（running / planning）", () => {
    expect(statusTone("running")).toBe("green");
    // planning 确实在动，只是动的不是产出代码那件事
    expect(statusTone("planning")).toBe("green");
  });

  it("蓝 = 完成（done）", () => {
    expect(statusTone("done")).toBe("blue");
  });

  it("白 = 未做（pending / ready）", () => {
    // ready 是准备好了但还没开始，仍属没动；给绿色会让人以为已经在跑。
    expect(statusTone("pending")).toBe("white");
    expect(statusTone("ready")).toBe("white");
  });

  it("红 = 失败、灰 = 跳过、黄 = 等人", () => {
    expect(statusTone("failed")).toBe("red");
    expect(statusTone("skipped")).toBe("gray");
    expect(statusTone("waiting")).toBe("yellow");
  });

  it("六种色调全部用上了 —— 调色板没有被浪费", () => {
    // 有色调定义了却永远拿不到，说明状态和颜色的对应关系想错了
    const used = new Set(TASK_POINT_STATUSES.map(statusTone));
    expect([...used].sort()).toEqual([
      "blue",
      "gray",
      "green",
      "red",
      "white",
      "yellow",
    ]);
  });
});

describe("statusLabel：八种状态 → 八句话", () => {
  it("八种状态每一种都有字，一种都没漏", () => {
    // 漏文字的表现是空白胶囊，看起来像样式没加载，所以同样遍历全集。
    for (const status of TASK_POINT_STATUSES) {
      const label = statusLabel(status);
      expect(typeof label, `状态 ${status} 没有文字`).toBe("string");
      expect(label.length, `状态 ${status} 的文字是空的`).toBeGreaterThan(0);
    }
    expect(TASK_POINT_STATUSES).toHaveLength(8);
  });

  it("八句话互不相同 —— 没有任何两档被合成一句", () => {
    // 两档同一句话会让用户分不清还没轮到与还跑不了，而两者该做的事不同。
    const labels = TASK_POINT_STATUSES.map(statusLabel);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("控制层的 done 说的是“已完成”，不是“已通过”", () => {
    // 一级 Agent 只做规划，不产出可通过的东西；写已通过是替它说了没做过的事。
    expect(statusLabel("done")).toBe("已完成");
    expect(statusLabel("running")).toBe("正在跑");
    expect(statusLabel("pending")).toBe("待执行");
  });

  it("每一档都有一套合法的色值 —— 三种分量、都在 0..255", () => {
    // TONE_RGB 被塞进 rgb(...) 模板串，少一段或多一个逗号都不报错，只让 CSS 失效。
    // 所以逐条校验形状，而不只查键在不在。
    for (const status of TASK_POINT_STATUSES) {
      const rgb = TONE_RGB[statusTone(status)];
      const parts = rgb.split(" ");
      expect(parts, `${status} 的色值不是三段：${JSON.stringify(rgb)}`).toHaveLength(3);
      for (const p of parts) {
        const n = Number(p);
        expect(Number.isInteger(n), `${status} 的色值分量不是整数：${p}`).toBe(true);
        expect(n).toBeGreaterThanOrEqual(0);
        expect(n).toBeLessThanOrEqual(255);
      }
    }
  });
});
