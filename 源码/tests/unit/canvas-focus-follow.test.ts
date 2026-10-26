import { describe, expect, it } from "vitest";
import {
  freshFocusFollow,
  markUserMoved,
  planFocusFollow,
  planUserFocus,
  type FocusFollowMemory,
  type FocusRequestMemory,
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

/* ============================================================
   用户点名：点清单里的一行 → 聚焦到那个任务点
   ------------------------------------------------------------
   和上面那一大组的关系，一句话：
     上面管的是「**没人要求**时系统能不能自己动镜头」（答案是：用户一动过就不能）；
     这一组管的是「**有人点名**时要怎么办」（答案是：照办，而且不受上面那条禁令管）。

   所以这两组里各有一条"另一半"：
     · 上面有一组「尊重用户：他动过视口之后，这一趟不再跟」
     · 下面有一条「用户动过之后点一次名，照样要执行」
   两条放在一起才说明白"点名 ≠ 跟随"——只有前一条的话，
   一个把点名也交给 planFocusFollow 去裁决的实现会让整组测试全绿。
   ============================================================ */

/** 点一次名 */
function nominate(mem: FocusRequestMemory, requestedId: string | null) {
  return planUserFocus(mem, requestedId);
}

describe("★ 用户点名：新的一次点名必须执行，不受「用户动过」那条禁令管", () => {
  it("第一次点名 → 执行（go 就是被点的那个 id）", () => {
    const s = nominate(null, "verify:完整 HTML 结构");
    expect(s.go).toBe("verify:完整 HTML 结构");
    expect(s.next).toBe("verify:完整 HTML 结构");
  });

  it("★ 换一个节点点 → 执行；而且**无视**上一条规矩里的 userMoved", () => {
    /*
      ★ 这一条是这个概念的落点 ★

      「用户动过视口之后不再自动聚焦」管的是**自动跟随**（没人要求的那种）。
      点名是用户自己开口要的 —— 那时候再拿那条禁令去挡他，
      结果就是"用户先拖了一下画布，回来点清单里的一行，点了没反应"。

      ⚠️ 注意这里连 userMoved 都传不进来：planUserFocus 的记忆里**没有**这个字段。
         这不是漏了，是故意的 —— 判据里根本没有"用户动过"这一项，
         将来谁想照着 planFocusFollow 给它加一条禁令，得先改这里的类型和测试。
    */
    const first = nominate(null, "spec");
    const second = nominate(first.next, "verify:中文界面");
    expect(second.go).toBe("verify:中文界面");
  });

  it("同一行点两次（URL 没变）→ 第二次不执行（重渲染不是事件）", () => {
    /*
      点名来自 URL，而 URL 是一段状态。运行还在跑时页面会一直重渲染，
      每次重渲染都重新执行一次点名的话，用户刚拖到别处就被拽回去 ——
      那是抢镜头，只不过换成了点名的名义。
    */
    const first = nominate(null, "build");
    const again = nominate(first.next, "build");
    expect(again.go).toBeNull();
    expect(again.next).toBe("build");
  });

  it("URL 上没有点名（null / 空串）→ 不执行，并且把记忆清空", () => {
    expect(nominate("build", null).go).toBeNull();
    expect(nominate("build", null).next).toBeNull();
    // 空串：`?focus=` 这种手写 URL。它不是一个节点 id，不能当成一次点名
    expect(nominate("build", "").go).toBeNull();
    expect(nominate("build", "").next).toBeNull();
  });

  it("★ 点 A → 走开（不带 focus 的 URL）→ 再点 A，要重新生效", () => {
    /*
      少了"清空记忆"那一步的话，这条会红，而症状是**回家再点同一行没反应** ——
      用户只会觉得这一列时灵时不灵。
    */
    const a = nominate(null, "spec");
    const away = nominate(a.next, null);
    const back = nominate(away.next, "spec");
    expect(back.go).toBe("spec");
  });

  it("A → B → A：第三次（回到 A）要执行 —— 判据是「和上一次比」，不是「点过没有」", () => {
    /*
      ⚠️ 判据写成"这个 id 点过没有"（比如用一个 Set 记住所有点过的）就会红：
         用户在两行之间来回看的时候，第一行永远点不动了。
    */
    const a = nominate(null, "spec");
    const b = nominate(a.next, "build");
    expect(b.go).toBe("build");
    const backToA = nominate(b.next, "spec");
    expect(backToA.go).toBe("spec");
  });

  it("查不到的 id 也照样算一次点名 —— 存不存在是画布的事，不是这个函数的", () => {
    /*
      这个函数只看 URL 说了什么。它要是顺手判断"这个 id 像不像存在的"，
      就会在查不到时把记忆留成旧值 —— 下一次重渲染又执行一遍，
      而那正是上面那条"重渲染不是事件"要防的。
    */
    const s = nominate(null, "根本不存在的东西");
    expect(s.go).toBe("根本不存在的东西");
    expect(s.next).toBe("根本不存在的东西");
    expect(nominate(s.next, "根本不存在的东西").go).toBeNull();
  });
});

describe("用户点名的纯函数性质", () => {
  it("不改入参（记忆是个字符串，改不了 —— 但返回值必须是新的一次判定的结果）", () => {
    const mem: FocusRequestMemory = "spec";
    nominate(mem, "build");
    expect(mem).toBe("spec");
  });

  it("同输入同输出：连调两次结果一样", () => {
    expect(nominate("spec", "build")).toEqual(nominate("spec", "build"));
  });

  it("go 只可能是 null 或者喂进去的那个 id —— 不会凭空造一个 id", () => {
    for (const prev of [null, "spec", "build"] as const) {
      for (const id of [null, "spec", "build"] as const) {
        const s = nominate(prev, id);
        expect([null, id]).toContain(s.go);
      }
    }
  });

  it("两条规矩互不干扰：点名不看自动跟随的记忆，自动跟随也不看点名", () => {
    /*
      两条规矩的输入是两个不同的值（FocusFollowMemory 是对象、FocusRequestMemory 是字符串），
      所以"点名被自动跟随的禁令挡住"这件事在类型上就写不出来。
      这一条把这个事实钉住：自动跟随那边 userMoved=true 之后，
      点名照旧执行；反过来，点名执行完不影响自动跟随那边的判据本身。
    */
    const followMem = markUserMoved({ lastStageId: BUILD, userMoved: false });
    expect(step(followMem, "verify").focus).toBeNull(); // 跟随：不许动
    expect(nominate(null, "verify").go).toBe("verify"); // 点名：照办
    expect(followMem.userMoved).toBe(true); // 点名没有偷偷改跟随的记忆
  });
});