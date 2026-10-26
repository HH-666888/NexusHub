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
 * 任务点基础规则的单测
 * ============================================================
 * 这一组钉的是**后面所有东西都站在上面的那几条规则**：
 * 层级分界在哪儿、子节点怎么找、孤儿怎么认、状态怎么汇总、状态什么颜色。
 *
 * 为什么值得单独一个文件：
 *   这五件事分别会被画布、清单、运行器用到。任何一条改错，
 *   表现都是「画面有点不对」——不是崩，是错。而错得最安静的那个是
 *   rollUpStatus：它算错的时候，一道工序只是显示成另一个颜色，
 *   没有异常、没有日志，只有人盯着屏幕觉得哪儿怪。
 */

/**
 * 造一个任务点。
 * kind 由 depth 推出来，因为这一期两者是同步的（见 task-point.ts 文件头）；
 * 真要造「第 3 层的控制点」时再单独传 kind。
 */
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

/* ── 层级判断 ── */

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
    /*
      这里断言的是「函数用的是那个常量」，不是「常量等于 2」。
      写死 2 的话，将来把控制层扩到 3 层时，这条测试会跟着一起错 ——
      而它本该是那条提醒你「分界线动了」的锚。
    */
    expect(isControlLayer(CONTROL_LAYER_MAX_DEPTH)).toBe(true);
    expect(isControlLayer(CONTROL_LAYER_MAX_DEPTH + 1)).toBe(false);
  });

  it("depth 为 0 或负数也判为控制层 —— 这个函数不负责校验合法性", () => {
    /*
      0 和 -1 都不是合法的深度。但 isControlLayer 回答的问题是
      「它在不在控制层」，答案确实是「在」。
      把校验塞进来会让调用方拿不到一个干净的问题答案：
      它要么得多写一个 try，要么得接受「非法输入返回 false」这种
      和语义相反的结果（false 的意思是「执行层」）。
    */
    expect(isControlLayer(0)).toBe(true);
    expect(isControlLayer(-1)).toBe(true);
  });
});

/* ── 子节点查询 ── */

describe("childrenOf：只取直接子节点", () => {
  it("按 parentId 取子节点，保持 points 里的出现顺序（不按 id 排序）", () => {
    /*
      顺序来自事件日志的投影，也就是「出生的先后」。
      按 id 排序会让清单里同一道工序下的任务按字典序排列，
      读起来像是乱的 —— 用户看到的顺序应该和事情发生的顺序一致。
      这里故意让字典序和出现顺序相反（t2 在前、t1 在后），
      这样「实现成 sort 了」会当场变红。
    */
    const points = [
      mk("t2", 3, "running", "mid"),
      mk("mid", 2, "planning", "agent-1"),
      mk("t1", 3, "done", "mid"),
    ];
    expect(childrenOf(points, "mid").map((p) => p.id)).toEqual(["t2", "t1"]);
  });

  it("孙子不算儿子", () => {
    /*
      打平子树的实现很诱人，但会让界面上的缩进失去意义：
      清单问「第 2 层下面有哪些执行点」时，拿到的会是整棵子树的几十个点。
    */
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
    /*
      这是有意的：同一个任务点在所有视图里应当是同一个对象，
      便于 React 比较、也便于调试时用 === 追一个点。
      测试把它写出来，是为了让「哪天有人顺手加了 .map(clone)」也能被发现。
    */
    const points = [mk("mid", 2, "planning", "agent-1"), mk("leaf", 3, "done", "mid")];
    expect(childrenOf(points, "mid")[0]).toBe(points[1]);
  });
});

/* ── 不变量：孤儿 ── */

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
    /*
      这是画布最容易出事的一种数据：布局要靠父子关系摆位置，
      一个找不到父节点的点要么被丢到 (0,0)、要么被静默丢弃。
      两种表现都不报错 —— 所以必须有一个函数专门回答这个问题。
    */
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
    /*
      这条测试记录的是一个**已知的边界**，不是「这样是对的」。
      parentId === 自己的 id 时，那个 id 确实在场，按定义就不是孤儿。
      环会让布局陷入递归，但那是另一个问题、另一个函数。
      写在这里，是为了让下一个读到的人知道这不是漏了。
    */
    expect(hasOrphans([mk("loop", 2, "pending", "loop")])).toBe(false);
  });
});

/* ── 状态汇总 ── */

describe("rollUpStatus：六条优先级各钉一条", () => {
  it("① 没有子节点 → pending（不是 done）", () => {
    /*
      这是整张表里最容易写错的一条：every() 对空数组返回 true，
      于是「一道工序还没长出任何执行点」会被显示成「已完成」。
      界面上写着已完成、底下什么都没有，是最坏的一种谎。
    */
    expect(rollUpStatus([])).toBe("pending");
  });

  it("② 有任意 running → running，压过 failed / waiting / done", () => {
    /*
      有活人在这棵子树里，画面就该是活的。
      哪怕同时有一个失败的兄弟，也不该让整道工序看上去停了 ——
      用户此刻真正需要知道的是「还有东西在跑」。
    */
    const children = [
      mk("a", 3, "failed", "s"),
      mk("b", 3, "waiting", "s"),
      mk("c", 3, "running", "s"),
      mk("d", 3, "done", "s"),
    ];
    expect(rollUpStatus(children)).toBe("running");
  });

  it("② 的反证：把那个 running 拿掉，同样的子节点立刻变成 failed", () => {
    /*
      上一条单独看不能证明「是 running 决定的」—— 也可能是别的规则先命中。
      去掉 running 之后结果必须跟着变，否则说明命中的是别的分支。
    */
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
    /*
      等人是唯一需要**用户**动手的状态。它必须能穿过 done 冒到工序这一层，
      否则用户永远不知道屏风后面在等自己。
    */
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
    // 单个子节点也成立 —— 不要写成「至少两个才算」
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
    /*
      第 ⑦ 条把 skipped 和 pending 抹成了同一个结果。
      这一期不引入「部分完成」这类新状态，因为界面上还没有表达它的语言；
      具体谁被跳过了，在画布的执行卡片上仍然看得见。
      这条测试是把这个取舍写下来，免得将来有人以为是 bug。
    */
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

/* ── 状态 → 色调 ── */

describe("statusTone：八种状态 → 六种色调", () => {
  it("八种状态每一种都有色调，一种都没漏", () => {
    /*
      漏配的表现是一个白点，而白色是最常见的底色 ——
      靠截图根本发现不了。所以这条测试遍历全集，而不是抽查两三个。
    */
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
    /*
      ready 是「准备好了但还没开始」，仍然属于「没动」。
      给它绿色会让用户以为已经在跑了。
    */
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

/* ── 状态 → 胶囊上的字 ── */

describe("statusLabel：八种状态 → 八句话", () => {
  it("八种状态每一种都有字，一种都没漏", () => {
    /*
      和上面那条同一个理由，只是后果不同：
      漏了色调 → 一个白点（看不见）；漏了文字 → 一个**空白胶囊**。
      空白胶囊在界面上看起来像样式没加载，不像数据缺失 ——
      所以它更需要一条遍历全集的测试，而不是抽查。
    */
    for (const status of TASK_POINT_STATUSES) {
      const label = statusLabel(status);
      expect(typeof label, `状态 ${status} 没有文字`).toBe("string");
      expect(label.length, `状态 ${status} 的文字是空的`).toBeGreaterThan(0);
    }
    expect(TASK_POINT_STATUSES).toHaveLength(8);
  });

  it("八句话互不相同 —— 没有任何两档被合成一句", () => {
    /*
      两档写成同一句话的后果不只是"看着粗糙"：用户没法从界面区分
      「还没轮到」（pending）和「还跑不了」（skipped / failed），
      而这两种情况该做的事完全不同 —— 一个等着就行，一个得去查。
    */
    const labels = TASK_POINT_STATUSES.map(statusLabel);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("控制层的 done 说的是「已完成」，不是「已通过」", () => {
    /*
      一级 Agent 是控制层：它只做规划，不产出任何可"通过"的东西。
      写成「已通过」会让人以为它交出了什么被验收过的东西 ——
      那是替它说了它没做过的事。
    */
    expect(statusLabel("done")).toBe("已完成");
    expect(statusLabel("running")).toBe("正在跑");
    expect(statusLabel("pending")).toBe("待执行");
  });

  it("每一档都有一套合法的色值 —— 三种分量、都在 0..255", () => {
    /*
      TONE_RGB 是画布和清单共用的调色板（写成 `r g b` 三段，塞进 rgb(...)）。
      它的消费者是 `rgb(${TONE_RGB[tone]} / 0.5)` 这种模板串：
      少写一段、多写个逗号**都不会报错**，只会让整条 CSS 失效 ——
      表现是那个元素没有颜色，一眼看不出来是数据问题。
      所以这里逐条校验形状，而不是只查"键在不在"。
    */
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
