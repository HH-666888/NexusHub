import { describe, expect, it } from "vitest";
import {
  freshFocusFollow,
  markUserMoved,
  planFocusFollow,
  type FocusFollowMemory,
} from "@/core/canvas/focus-follow";
import type { StageId } from "@/core/pipeline/stages";

/**
 * 自动跟随的闸门 —— 单测
 * ============================================================
 * 这个文件守的是两句话，两句都是关于**什么时候不动**的：
 *
 *   ① 挂载时不许自动聚焦（打开画布该看到整棵树，不是被人拽到某张卡上）
 *   ② 用户自己动过视口之后，这一趟再也不许自动聚焦（镜头是他的）
 *
 * 为什么值得单开一个文件：
 *   这两条规矩在界面上都表现为"**没有**发生一件事"——
 *   镜头没动。而"没动"是看不出来的：功能整个坏了，画面也是不动的，
 *   和"规矩生效了"长得一模一样。
 *   所以只能靠断言钉住：同样的输入序列，什么时候该动、什么时候不该动。
 *
 * 另一件在这里钉住的事：**它不认识 React**。
 *   状态是一个值（FocusFollowMemory），决策是一个纯函数。
 *   组件那边只剩一次调用，没有 if —— 于是"什么时候跟"只有一个地方在回答。
 */

const SPEC: StageId = "spec";
const BUILD: StageId = "build";

/** 走一步：喂进去一个工序，返回"该不该聚焦"和新的记忆 */
function step(mem: FocusFollowMemory, stageId: StageId | null) {
  return planFocusFollow(mem, stageId);
}

describe("起点：挂载时的第一个值不算「推进」", () => {
  it("第一次拿到工序 → 记下来，但**不动视口**", () => {
    /*
      这是"打开画布应当是整棵树的默认视图"那条规矩的落点。
      组件挂载时拿到的 focusStageId 不是"推进"，是"当前状态"。
      在这里跟过去的话，用户一进画布，镜头就已经替他选好了看哪儿 ——
      而那时他甚至还没看清这棵树有几层。
    */
    const first = step(freshFocusFollow(), SPEC);
    expect(first.focus).toBeNull();
    expect(first.next.lastStageId).toBe(SPEC);
  });

  it("第一次拿到的是 null（没有工序在跑）→ 同样不动视口", () => {
    const first = step(freshFocusFollow(), null);
    expect(first.focus).toBeNull();
    expect(first.next.lastStageId).toBeNull();
  });

  it("起点之后的**第二个**值才算推进", () => {
    const first = step(freshFocusFollow(), SPEC);
    const second = step(first.next, BUILD);
    expect(second.focus).toBe(BUILD);
  });
});

describe("推进：工序变了才跟过去", () => {
  it("spec → build：跟到 build", () => {
    const mem: FocusFollowMemory = { lastStageId: SPEC, userMoved: false };
    expect(step(mem, BUILD).focus).toBe(BUILD);
  });

  it("工序没变 → 不跟（哪怕这个函数被反复调用）", () => {
    /*
      重渲染会把 effect 再跑一遍：服务端刷新、子树长大、窗口尺寸变化都会。
      用"函数被调了"当信号的话，用户每被刷新一次镜头就动一次。
      信号只能是"值变了"。
    */
    const mem: FocusFollowMemory = { lastStageId: BUILD, userMoved: false };
    for (let i = 0; i < 5; i++) {
      const s = step(mem, BUILD);
      expect(s.focus).toBeNull();
      expect(s.next.lastStageId).toBe(BUILD);
    }
  });

  it("null → null：不跟（本来就没有目标）", () => {
    const mem: FocusFollowMemory = { lastStageId: null, userMoved: false };
    expect(step(mem, null).focus).toBeNull();
  });

  it("null → spec：**跟** —— 同一道工序重新开跑算一次新的推进", () => {
    /*
      这条容易写错成"上一次是 null 就不跟"。
      实际情形：一次运行里 ④ 跑完、⑤ 还没开始（null），
      然后 ⑤ 开跑 —— 那正是最该把镜头送过去的一刻。
    */
    const mem: FocusFollowMemory = { lastStageId: null, userMoved: false };
    expect(step(mem, SPEC).focus).toBe(SPEC);
  });

  it("build → null：不跟，但要把 null 记下来", () => {
    // 不记的话，下一道工序重新开跑时会被当成"没变"而错过
    const mem: FocusFollowMemory = { lastStageId: BUILD, userMoved: false };
    const s = step(mem, null);
    expect(s.focus).toBeNull();
    expect(s.next.lastStageId).toBeNull();
  });

  it("往回退也算推进（失败重跑：verify → build 要跟）", () => {
    const mem: FocusFollowMemory = { lastStageId: "verify", userMoved: false };
    expect(step(mem, BUILD).focus).toBe(BUILD);
  });
});

describe("尊重用户：他动过视口之后，这一趟不再跟", () => {
  it("动过之后，工序变了也不跟", () => {
    const mem = markUserMoved({ lastStageId: SPEC, userMoved: false });
    const s = step(mem, BUILD);
    expect(s.focus).toBeNull();
    // 但"到哪一步了"照样记：记忆是事实，跟不跟是策略
    expect(s.next.lastStageId).toBe(BUILD);
  });

  it("动过之后连着推进三步，一步都不跟", () => {
    /*
      这一条比上面那条更接近真实情形：用户拖了一次画面，
      然后后台连着走了三道工序。**任何一次跟过去都是抢镜头**。
    */
    let mem = markUserMoved({ lastStageId: SPEC, userMoved: false });
    for (const id of ["arch", "ui", "build", "assemble"] as StageId[]) {
      const s = step(mem, id);
      expect(s.focus).toBeNull();
      mem = s.next;
    }
    expect(mem.userMoved).toBe(true);
    expect(mem.lastStageId).toBe("assemble");
  });

  it("「用户动过」是单向的：动过之后不会自己变回来", () => {
    let mem = markUserMoved({ lastStageId: null, userMoved: false });
    mem = step(mem, SPEC).next;
    mem = step(mem, BUILD).next;
    expect(mem.userMoved).toBe(true);
  });

  it("用户动过 + 工序变回同一道（重跑）→ 仍然不跟", () => {
    // "同一道工序重新开跑"那条规则（null → spec 要跟）在用户动过之后也必须让位
    const mem = markUserMoved({ lastStageId: null, userMoved: false });
    expect(step(mem, SPEC).focus).toBeNull();
  });

  it("没动过的话，同一情形是跟的 —— 两个分支确实不同", () => {
    // 少了这一条，上面几条在"永远不跟"的实现下也会全绿
    const mem: FocusFollowMemory = { lastStageId: null, userMoved: false };
    expect(step(mem, SPEC).focus).toBe(SPEC);
  });
});

describe("换运行：从头开始", () => {
  it("重置之后，第一个值又只记不跟（和挂载同一条规矩）", () => {
    /*
      用户在运行 A 上把视口拖到位、又推进了两步；
      切到运行 B 时如果直接沿用"上次是 assemble"，B 的第一道工序
      会被当成一次推进，镜头立刻飞过去 —— 而用户根本还没看 B 是什么。
    */
    let mem = markUserMoved({ lastStageId: SPEC, userMoved: false });
    mem = step(mem, BUILD).next;
    expect(mem.userMoved).toBe(true);

    const fresh = freshFocusFollow();
    expect(fresh.userMoved).toBe(false);
    expect(step(fresh, SPEC).focus).toBeNull();
  });

  it("重置之后自动跟随重新可用", () => {
    // "重置"如果只重置了 lastStageId 而没重置 userMoved，用户换一次运行
    // 之后就再也看不到自动跟随了 —— 这一条防的就是那种半截重置
    const fresh = freshFocusFollow();
    const first = step(fresh, SPEC);
    expect(step(first.next, BUILD).focus).toBe(BUILD);
  });
});

describe("作为值的性质（组件那边靠它当 ref）", () => {
  it("每次 freshFocusFollow 都是新对象 —— 两个画布不会共享状态", () => {
    // cockpit 和 /canvas 上各挂着一个画布。共用一个模块级对象的话，
    // 一个实例上"用户动过"会顺着那个对象漏给另一个实例。
    const a = freshFocusFollow();
    const b = freshFocusFollow();
    expect(a).not.toBe(b);
    a.userMoved = true;
    expect(b.userMoved).toBe(false);
  });

  it("不变时返回**同一个**记忆对象（组件可以拿它做 === 判断）", () => {
    const mem: FocusFollowMemory = { lastStageId: BUILD, userMoved: false };
    expect(step(mem, BUILD).next).toBe(mem);
  });

  it("决策函数不改入参", () => {
    const mem: FocusFollowMemory = { lastStageId: SPEC, userMoved: false };
    step(mem, BUILD);
    markUserMoved(mem);
    expect(mem).toEqual({ lastStageId: SPEC, userMoved: false });
  });

  it("同输入同输出：连调两次结果一样", () => {
    const mem: FocusFollowMemory = { lastStageId: SPEC, userMoved: false };
    expect(step(mem, BUILD)).toEqual(step(mem, BUILD));
  });

  it("focus 只可能是 null 或者喂进去的那个工序 —— 不会凭空造一个 id", () => {
    for (const prev of [undefined, null, SPEC, BUILD] as const) {
      for (const id of [null, SPEC, BUILD] as const) {
        const s = step({ lastStageId: prev, userMoved: false }, id);
        expect([null, id]).toContain(s.focus);
      }
    }
  });
});